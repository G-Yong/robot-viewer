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

/** Keyboard shortcuts that filter the IK handles. See the keydown handler below. */
const IK_HANDLE_KEYS: Record<string, "both" | "translate" | "rotate"> = {
  w: "translate",
  e: "rotate",
  q: "both",
};

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

  const saveScene = (): void => {
    const scene: SceneConfig = buildScene();
    post({ type: "saveScene", scene });
  };

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
    onSaveScene: saveScene,
    onLoadScene: () => {
      post({ type: "requestLoadScene" });
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
    onIkEnabled: (enabled) => viewer.setIkEnabled(enabled),
    onIkTcpLink: (link) => viewer.setIkTcpLink(link),
    onIkToolOffset: (x, y, z) => viewer.setIkToolOffset(x, y, z),
    onIkHandleSize: (factor) => viewer.setIkHandleSize(factor),
    onIkPoseOrigin: (origin) => viewer.setPoseOrigin(origin),
    onIkPoseFormat: (representation, eulerOrder) =>
      viewer.setPoseRepresentation(representation, eulerOrder),
  });

  // Joint values changed by something other than the sliders (an IK drag, a
  // loaded scene): keep the sidebar in step.
  viewer.onJointChange = (values) => ui.updateJointValues(values);
  viewer.onIkStatus = (status) => ui.updateIkStatus(status);
  viewer.onPoseUpdate = (readout) => ui.updatePose(readout);

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
      // Password is intentionally cleared so it is not written to the file.
      opcua: { ...ui.getOpcuaConfig(), password: "" },
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
        if (msg.scene.opcua) {
          ui.applyOpcuaConfig(msg.scene.opcua);
        }
        break;
      case "requestScene":
        post({ type: "sceneSnapshot", scene: buildScene() });
        break;
      case "connectionStatus":
        ui.setConnectionStatus(msg.connected, msg.detail);
        break;
      case "opcuaJointState":
        ui.updateOpcuaJointStates(msg.joints);
        break;
    }
  });

  // Ctrl+S / Cmd+S saves the current scene, same as the Scene tab's Save
  // button. preventDefault stops the browser's native "save page" dialog.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      saveScene();
    }
  });

  // W / E / Q filter the IK handles (move only / rotate only / both) without
  // reaching for the panel - the arrows and the rings are shown together, so
  // these only ever narrow that down. Ignored with a modifier held and while the
  // focus sits in a panel field, so typing never toggles anything.
  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      Boolean(target?.isContentEditable);
    if (typing || e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    const handles = IK_HANDLE_KEYS[e.key.toLowerCase()];
    if (!handles) {
      return;
    }
    e.preventDefault();
    viewer.setIkHandles(handles);
  });

  // Automation seam for the offline UI harness (tools/uiHarness.html), which
  // drives the bundled webview in a plain browser to check the IK interaction.
  // Never set inside a real webview.
  if ((window as unknown as { __ROBOT_VIEWER_TEST__?: boolean }).__ROBOT_VIEWER_TEST__) {
    (window as unknown as { __robotViewer?: unknown }).__robotViewer = { viewer, ui };
  }

  post({ type: "ready" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
