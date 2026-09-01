import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ResourceResolver } from "./resourceResolver";
import { OpcuaBridge } from "./opcuaBridge";
import type {
  HostToWebview,
  WebviewToHost,
  ViewerSettings,
  SceneConfig,
  OpcuaConfig,
} from "./protocol";

export class RobotPreviewPanel {
  public static readonly viewType = "robotViewer.preview";
  private static panels = new Map<string, RobotPreviewPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private resolver: ResourceResolver;
  private opcua?: OpcuaBridge;
  private currentJointNames: string[] = [];
  private modelUri: vscode.Uri;

  static async createOrShow(
    context: vscode.ExtensionContext,
    fileUri: vscode.Uri
  ): Promise<void> {
    const key = fileUri.toString();
    const existing = RobotPreviewPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      await existing.loadModel();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      RobotPreviewPanel.viewType,
      `Robot: ${path.basename(fileUri.fsPath)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: RobotPreviewPanel.resourceRoots(context, fileUri),
      }
    );
    const instance = new RobotPreviewPanel(context, panel, fileUri);
    RobotPreviewPanel.panels.set(key, instance);
  }

  private static resourceRoots(
    context: vscode.ExtensionContext,
    fileUri: vscode.Uri
  ): vscode.Uri[] {
    const roots: vscode.Uri[] = [
      vscode.Uri.joinPath(context.extensionUri, "dist"),
      vscode.Uri.joinPath(context.extensionUri, "media"),
      vscode.Uri.file(path.dirname(fileUri.fsPath)),
    ];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      roots.push(f.uri);
    }
    return roots;
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    fileUri: vscode.Uri
  ) {
    this.panel = panel;
    this.modelUri = fileUri;
    this.resolver = new ResourceResolver(path.dirname(fileUri.fsPath));

    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => this.onMessage(msg),
      null,
      this.disposables
    );

    if (
      vscode.workspace.getConfiguration("robotViewer").get<boolean>("reRenderOnSave", true)
    ) {
      this.disposables.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
          if (doc.uri.toString() === this.modelUri.toString()) {
            void this.loadModel();
          }
        })
      );
    }
  }

  private post(message: HostToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.loadModel();
        break;
      case "requestResource":
        this.handleResourceRequest(msg.requestId, msg.uri);
        break;
      case "jointChanged":
        // User moved a joint in the viewer; hook for outbound sync if needed.
        break;
      case "saveScene":
        await this.saveScene(msg.scene);
        break;
      case "sceneSnapshot":
        await this.saveScene(msg.scene);
        break;
      case "requestLoadScene":
        await this.loadSceneFromDialog();
        break;
      case "log":
        this.log(msg.level, msg.message);
        break;
      case "connectOpcua":
        await this.connectOpcua(msg.config);
        break;
      case "disconnectOpcua":
        await this.opcua?.disconnect();
        break;
    }
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    const line = `[Robot Viewer] ${message}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  private handleResourceRequest(requestId: number, uri: string): void {
    try {
      const abs = this.resolver.resolve(uri);
      if (!abs || !fs.existsSync(abs)) {
        this.post({
          type: "resource",
          response: { requestId, ok: false, error: `Not found: ${uri}` },
        });
        return;
      }
      const data = fs.readFileSync(abs);
      const ext = path.extname(abs).slice(1).toLowerCase();
      this.post({
        type: "resource",
        response: { requestId, ok: true, data: data.toString("base64"), ext },
      });
    } catch (e: any) {
      this.post({
        type: "resource",
        response: { requestId, ok: false, error: e?.message ?? String(e) },
      });
    }
  }

  private async readModelContent(): Promise<string> {
    const raw = (await vscode.workspace.fs.readFile(this.modelUri)).toString();
    if (this.modelUri.fsPath.toLowerCase().endsWith(".xacro")) {
      return this.expandXacro(raw);
    }
    return Buffer.from(raw).toString();
  }

  private async expandXacro(raw: string): Promise<string> {
    try {
      const xmldom = require("@xmldom/xmldom");
      // xacro-parser relies on global DOMParser/XMLSerializer in Node.
      const g = globalThis as any;
      g.DOMParser = g.DOMParser ?? xmldom.DOMParser;
      g.XMLSerializer = g.XMLSerializer ?? xmldom.XMLSerializer;

      const { XacroParser } = require("xacro-parser");
      const parser = new XacroParser();
      parser.workingPath = path.dirname(this.modelUri.fsPath);
      parser.getFileContents = async (p: string): Promise<string> => {
        const abs = path.isAbsolute(p)
          ? p
          : path.join(path.dirname(this.modelUri.fsPath), p);
        return fs.readFileSync(abs, "utf8");
      };
      const doc: Document = await parser.parse(raw);
      const serializer = new xmldom.XMLSerializer();
      return serializer.serializeToString(doc as any);
    } catch (e: any) {
      this.log("warn", `Xacro expansion failed, using raw content: ${e?.message}`);
      return raw;
    }
  }

  private workspaceBase(): string {
    const folder = vscode.workspace.getWorkspaceFolder(this.modelUri);
    const root = folder?.uri.fsPath ?? path.dirname(this.modelUri.fsPath);
    return root;
  }

  async loadModel(): Promise<void> {
    try {
      const urdfContent = await this.readModelContent();
      this.currentJointNames = this.extractJointNames(urdfContent);
      this.post({
        type: "loadModel",
        urdfContent,
        workspaceBase: this.workspaceBase(),
        fileName: path.basename(this.modelUri.fsPath),
      });
      this.post({ type: "applySettings", settings: this.readSettings() });
      this.post({ type: "opcuaInit", config: this.opcuaDefaults() });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Robot Viewer: failed to load model — ${e?.message}`);
    }
  }

  /** Seed the webview OPC UA panel from the user's VS Code settings. */
  private opcuaDefaults(): Partial<OpcuaConfig> {
    const cfg = vscode.workspace.getConfiguration("robotViewer");
    const endpoint = cfg.get<string>("opcua.endpoint", "opc.tcp://localhost:4840");
    const template = cfg.get<string>("opcua.nodeIdTemplate", "ns=2;s=Joints/{joint}");

    let host = "localhost";
    let port = 4840;
    const epMatch = /^opc\.tcp:\/\/([^:/]+)(?::(\d+))?/i.exec(endpoint);
    if (epMatch) {
      host = epMatch[1];
      port = epMatch[2] ? Number(epMatch[2]) : 4840;
    }

    // Split a template like "ns=2;s=Joints/{joint}" into namespace + id parts.
    let namespace = 2;
    let identifierType: OpcuaConfig["identifierType"] = "s";
    let identifierPrefix = "Joints/";
    const nsMatch = /ns=(\d+);/i.exec(template);
    if (nsMatch) {
      namespace = Number(nsMatch[1]);
    }
    const idMatch = /;?\s*(i|s|g|b)=(.*)$/i.exec(template);
    if (idMatch) {
      identifierType = idMatch[1].toLowerCase() as OpcuaConfig["identifierType"];
      // The common prefix is everything before the {joint} placeholder.
      identifierPrefix = idMatch[2].replace(/\{joint\}.*$/i, "");
    }

    return { host, port, namespace, identifierType, identifierPrefix };
  }

  private extractJointNames(urdf: string): string[] {
    const names: string[] = [];
    const re = /<joint\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(urdf))) {
      names.push(m[1]);
    }
    return names;
  }

  private readSettings(): ViewerSettings {
    const cfg = vscode.workspace.getConfiguration("robotViewer");
    return {
      backgroundColor: cfg.get<string>("backgroundColor", "#263238"),
      showGrid: cfg.get<boolean>("showGrid", true),
      upAxis: cfg.get<"+Z" | "+Y">("upAxis", "+Z"),
      ambientIntensity: 0.8,
      directionalIntensity: 1.0,
      showVisual: true,
      showCollision: false,
      wireframe: false,
      colorMode: "original",
      showOriginAxes: true,
      showJointAxes: true,
      showViewGizmo: true,
      axisSize: 0.25,
    };
  }

  private sceneFileUri(): vscode.Uri {
    const dir = path.dirname(this.modelUri.fsPath);
    const base = path.basename(this.modelUri.fsPath, path.extname(this.modelUri.fsPath));
    return vscode.Uri.file(path.join(dir, `${base}.robotscene.json`));
  }

  private async saveScene(scene: SceneConfig): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: this.sceneFileUri(),
      filters: { "Robot Scene": ["json"] },
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(
      target,
      Buffer.from(JSON.stringify(scene, null, 2), "utf8")
    );
    vscode.window.showInformationMessage(`Scene saved: ${path.basename(target.fsPath)}`);
  }

  async loadSceneFromDialog(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri: this.sceneFileUri(),
      filters: { "Robot Scene": ["json"] },
    });
    if (!picked || picked.length === 0) {
      return;
    }
    try {
      const raw = (await vscode.workspace.fs.readFile(picked[0])).toString();
      const scene: SceneConfig = JSON.parse(raw);
      this.post({ type: "loadScene", scene });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to load scene: ${e?.message}`);
    }
  }

  private async connectOpcua(config: OpcuaConfig): Promise<void> {
    if (!this.opcua) {
      this.opcua = new OpcuaBridge(
        (values) => this.post({ type: "setJoints", values, source: "external" }),
        (connected, detail) =>
          this.post({ type: "connectionStatus", connected, detail })
      );
      this.disposables.push({ dispose: () => this.opcua?.dispose() });
    }
    try {
      await this.opcua.connect(config);
    } catch (e: any) {
      vscode.window.showErrorMessage(`OPC UA connection failed: ${e?.message}`);
    }
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      `connect-src ${webview.cspSource} data: blob:`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Robot Viewer</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    RobotPreviewPanel.panels.delete(this.modelUri.toString());
    this.opcua?.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  static getActive(): RobotPreviewPanel | undefined {
    for (const p of RobotPreviewPanel.panels.values()) {
      if (p.panel.active) {
        return p;
      }
    }
    return RobotPreviewPanel.panels.values().next().value;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
