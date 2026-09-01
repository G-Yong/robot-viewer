# Robot Viewer

**English** | [简体中文](README_zh-CN.md)

A VS Code extension for importing and visualizing robot models (URDF / Xacro) directly in the editor. Inspect the model in an interactive 3D view, drive joint angles in real time, tweak rendering, save/load scene configurations, and synchronize joint states from an external system over OPC UA.

## Features

- **Model import** — Preview `.urdf` and `.xacro` files. Xacro documents are expanded on the extension side before rendering.
- **3D interaction** — Orbit, pan and zoom the camera; automatic fit-to-model framing.
- **Joint control** — A slider per movable joint with live value readout (degrees for revolute/continuous, meters for prismatic).
- **Rendering settings** — Background color, ground grid, ambient/key light intensity, visual/collision geometry toggles, wireframe, and up-axis (`+Z` URDF convention or `+Y`).
- **Scene save/load** — Persist joint values, camera pose and render settings to a `*.robotscene.json` file and restore them later.
- **Live sync (OPC UA)** — A six-part configuration panel (Connection, Security, Address Space, Variable Naming, Joint Mapping, Runtime) subscribes to a NodeId per joint and mirrors external joint states into the viewer in real time.
- **Package resolution** — Resolve `package://<pkg>/...` mesh references via the `robotViewer.packages` setting. The model's own directory and its parent are always searched too, so meshes resolve even when the `package://` name doesn't match a real folder.

Supported mesh formats: **STL**, **Collada (.dae)**, **OBJ**, **glTF/GLB**.

## Usage

1. Open the folder that contains your robot description (so mesh resources resolve).
2. Open a `.urdf` / `.xacro` file, then either:
   - click the **Preview** icon in the editor title bar, or
   - run **Robot Viewer: Preview Robot Model** from the Command Palette, or
   - right-click the file in the Explorer and choose **Robot Viewer: Preview Robot Model**.
3. Use the side panel to move joints, adjust rendering, save/load scenes, and connect live sync.

A ready-to-run example lives in [`samples/simple_arm.urdf`](samples/simple_arm.urdf) — it uses only primitive geometry, so no external meshes are required.

## Commands

| Command | Description |
| --- | --- |
| `Robot Viewer: Preview Robot Model` | Open the 3D preview for the active/selected model file. |
| `Robot Viewer: Open Model File...` | Pick a model file from disk and preview it. |
| `Robot Viewer: Load Scene Configuration...` | Load a saved `*.robotscene.json` into the active preview. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `robotViewer.packages` | `{}` | Map ROS package names to folders for `package://` resolution. |
| `robotViewer.backgroundColor` | `#263238` | Viewer background color. |
| `robotViewer.showGrid` | `true` | Show the ground grid by default. |
| `robotViewer.upAxis` | `+Z` | Up axis used to orient the model. |
| `robotViewer.reRenderOnSave` | `true` | Re-render when the previewed file is saved. |
| `robotViewer.opcua.endpoint` | `opc.tcp://localhost:4840` | Default OPC UA endpoint. |
| `robotViewer.opcua.nodeIdTemplate` | `ns=2;s=Joints/{joint}` | NodeId template per joint (`{joint}` is substituted). |

> Tip: even without configuring `robotViewer.packages`, the extension automatically treats the URDF's own directory and its parent as implicit package roots when searching for meshes.

### OPC UA live sync

Open the **Live Sync (OPC UA)** panel in the sidebar and configure the connection through its six sections:

1. **Connection** — server host/IP and port.
2. **Security** — security mode, policy, and optional username/password (leave the username empty for anonymous access).
3. **Address Space** — namespace index and NodeId identifier type (string / numeric / GUID / opaque).
4. **Variable Naming** — an identifier template (`{joint}` is substituted with each joint name) plus an *Apply to all joints* button.
5. **Joint Mapping** — a per-joint table: enable/disable, edit the NodeId identifier, and set a `scale` / `offset` applied to each incoming value.
6. **Runtime** — monitored-item sampling interval, incoming value unit (radians or degrees), and the **Connect / Disconnect** button with live status.

`robotViewer.opcua.endpoint` and `robotViewer.opcua.nodeIdTemplate` seed the panel's initial values; anything you change in the panel is remembered per preview. Passwords are never written to disk.

## Development

```powershell
npm install
npm run compile     # one-off build
npm run watch       # rebuild on change
```

Press <kbd>F5</kbd> (Run Extension) to launch an Extension Development Host.

Build output goes to `dist/` (`extension.js` for the host, `webview.js` for the 3D viewer).

## License

MIT
