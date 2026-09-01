import styles from "./style.css";
import { Viewer } from "./viewer";
import { UI } from "./ui";
import { handleResourceResponse } from "./meshLoader";
import { post, onMessage, log, getState, setState } from "./vscodeApi";
import type {
  HostToWebview,
  JointValues,
  ViewerSettings,
  SceneConfig,
  OpcuaConfig,
} from "../src/protocol";

interface PersistedState {
  opcua?: OpcuaConfig;
}

function injectStyles(): void {
  const style = document.createElement("style");
  style.textContent = styles as unknown as string;
  document.head.appendChild(style);
}

function bootstrap(): void {
  injectStyles();

  const app = document.getElementById("app")!;
  const canvas = document.createElement("canvas");
  canvas.id = "viewer-canvas";
  app.appendChild(canvas);

  const viewer = new Viewer(canvas);
  let currentFileName = "";

  const ui = new UI(app, viewer, {
    onJointInput: (name, value) => {
      viewer.setJoint(name, value);
      post({ type: "jointChanged", values: { [name]: value }, source: "user" });
    },
    onSettingsChange: (partial) => {
      viewer.applySettings({ ...viewer.getSettings(), ...partial });
    },
    onResetCamera: () => viewer.resetCamera(),
    onResetJoints: () => {
      const zeros: JointValues = {};
      for (const j of viewer.getJoints()) {
        zeros[j.name] = 0;
      }
      viewer.setJoints(zeros);
      ui.updateJointValues(zeros);
    },
    onSaveScene: () => {
      const scene: SceneConfig = buildScene();
      post({ type: "saveScene", scene });
    },
    onLoadScene: () => {
      // Delegates to the extension command palette flow.
      post({ type: "log", level: "info", message: "load-scene requested" });
      // The extension exposes 'Robot Viewer: Load Scene Configuration...'.
    },
    onToggleOpcua: () => {
      if (ui.isOpcuaConnected()) {
        post({ type: "disconnectOpcua" });
      } else {
        post({ type: "connectOpcua", config: ui.getOpcuaConfig() });
      }
    },
    onOpcuaConfigChange: (config) => {
      // Persist config across reloads, but never store the password on disk.
      const state = (getState<PersistedState>() ?? {}) as PersistedState;
      state.opcua = { ...config, password: "" };
      setState(state);
    },
  });

  // Restore a previously saved OPC UA configuration, if any.
  const saved = getState<PersistedState>();
  if (saved?.opcua) {
    ui.applyOpcuaConfig(saved.opcua);
  }

  function buildScene(): SceneConfig {
    return {
      version: 1,
      fileName: currentFileName,
      joints: viewer.getJointValues(),
      camera: viewer.getCameraState(),
      settings: viewer.getSettings(),
    };
  }

  onMessage((msg: HostToWebview) => {
    switch (msg.type) {
      case "loadModel": {
        currentFileName = msg.fileName;
        try {
          const joints = viewer.loadModel(msg.urdfContent);
          ui.populateJoints(joints);
        } catch (e) {
          log("error", `failed to parse model: ${(e as Error).message}`);
        }
        break;
      }
      case "resource":
        handleResourceResponse(msg.response);
        break;
      case "setJoints":
        viewer.setJoints(msg.values);
        ui.updateJointValues(msg.values);
        break;
      case "applySettings":
        viewer.applySettings(msg.settings as ViewerSettings);
        break;
      case "opcuaInit":
        ui.setOpcuaDefaults(msg.config);
        break;
      case "loadScene":
        viewer.applyScene(msg.scene);
        ui.updateJointValues(msg.scene.joints ?? {});
        break;
      case "requestScene":
        post({ type: "sceneSnapshot", scene: buildScene() });
        break;
      case "connectionStatus":
        ui.setConnectionStatus(msg.connected, msg.detail);
        break;
    }
  });

  post({ type: "ready" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
