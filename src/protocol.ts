// Message protocol shared between the extension host and the webview.
// Kept dependency-free so both bundles can import it.

export interface JointValues {
  [jointName: string]: number;
}

/** A single mesh/texture resource resolved by the extension host. */
export interface ResourceResponse {
  requestId: number;
  ok: boolean;
  /** base64-encoded file contents when ok. */
  data?: string;
  /** original extension (e.g. "stl", "dae", "obj") lowercased. */
  ext?: string;
  error?: string;
}

// ---- Extension host -> Webview ------------------------------------------------

export type HostToWebview =
  | { type: "loadModel"; urdfContent: string; workspaceBase: string; fileName: string }
  | { type: "resource"; response: ResourceResponse }
  | { type: "setJoints"; values: JointValues; source: "external" }
  | { type: "applySettings"; settings: ViewerSettings }
  | { type: "loadScene"; scene: SceneConfig }
  | { type: "requestScene" }
  | { type: "opcuaInit"; config: Partial<OpcuaConfig> }
  | { type: "connectionStatus"; connected: boolean; detail?: string };

// ---- Webview -> Extension host ------------------------------------------------

export type WebviewToHost =
  | { type: "ready" }
  | { type: "requestResource"; requestId: number; uri: string }
  | { type: "jointChanged"; values: JointValues; source: "user" }
  | { type: "saveScene"; scene: SceneConfig }
  | { type: "sceneSnapshot"; scene: SceneConfig }
  | { type: "requestLoadScene" }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "connectOpcua"; config: OpcuaConfig }
  | { type: "disconnectOpcua" };

export interface ViewerSettings {
  backgroundColor: string;
  showGrid: boolean;
  upAxis: "+Z" | "+Y";
  ambientIntensity: number;
  directionalIntensity: number;
  showVisual: boolean;
  showCollision: boolean;
  wireframe: boolean;
  /** "original" uses the URDF/material colors; "alternate" gives each link a distinct palette color. */
  colorMode: "original" | "alternate";
  /** Show the X/Y/Z axes at the world origin (model base). */
  showOriginAxes: boolean;
  /** Show an X/Y/Z frame at every joint. */
  showJointAxes: boolean;
  /** Show the corner orientation gizmo. */
  showViewGizmo: boolean;
  /** Axes length as a fraction of the model size. */
  axisSize: number;
}

/** Per-joint OPC UA node binding. */
export interface OpcuaJointMapping {
  /** Robot joint name. */
  joint: string;
  /** The joint-specific part of the identifier, appended to the common prefix. */
  identifier: string;
  enabled: boolean;
  /** Incoming value is transformed as value * scale + offset. */
  scale: number;
  offset: number;
}

/** Complete OPC UA connection + binding configuration built in the webview. */
export interface OpcuaConfig {
  /** Server host / IP. */
  host: string;
  port: number;
  /** Namespace index applied to every joint NodeId. */
  namespace: number;
  /** Identifier kind: string (s), numeric (i), guid (g), opaque (b). */
  identifierType: "s" | "i" | "g" | "b";
  /** Common identifier prefix shared by all joints (e.g. "Joints/"). */
  identifierPrefix: string;
  /** Incoming unit; "deg" values are converted to radians before display. */
  valueUnit: "rad" | "deg";
  /** Monitored-item sampling interval in milliseconds. */
  samplingInterval: number;
  securityMode: "None" | "Sign" | "SignAndEncrypt";
  securityPolicy: string;
  /** Optional user credentials (empty => anonymous). Never persisted to disk. */
  username: string;
  password: string;
  mappings: OpcuaJointMapping[];
}

export interface SceneConfig {
  version: 1;
  fileName?: string;
  joints: JointValues;
  camera?: {
    position: [number, number, number];
    target: [number, number, number];
  };
  settings?: Partial<ViewerSettings>;
  /** OPC UA configuration; password is never written to the scene file. */
  opcua?: OpcuaConfig;
}
