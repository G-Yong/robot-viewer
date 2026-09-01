import * as vscode from "vscode";
import * as path from "path";
import { RobotPreviewPanel } from "./robotPreviewPanel";

const MODEL_EXTENSIONS = [".urdf", ".xacro"];

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("robotViewer.preview", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage(
          "Robot Viewer: open or select a URDF/Xacro file first."
        );
        return;
      }
      await RobotPreviewPanel.createOrShow(context, target);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("robotViewer.openFile", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Robot Model": ["urdf", "xacro"], "All Files": ["*"] },
      });
      if (picked && picked.length > 0) {
        await RobotPreviewPanel.createOrShow(context, picked[0]);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("robotViewer.loadScene", async () => {
      const panel = RobotPreviewPanel.getActive();
      if (!panel) {
        vscode.window.showWarningMessage("Robot Viewer: no active preview.");
        return;
      }
      await panel.loadSceneFromDialog();
    })
  );
}

export function deactivate(): void {
  /* panels dispose themselves via context subscriptions */
}

export function isModelFile(uri: vscode.Uri): boolean {
  return MODEL_EXTENSIONS.includes(path.extname(uri.fsPath).toLowerCase());
}
