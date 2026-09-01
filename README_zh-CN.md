# Robot Viewer（机器人查看器）

[English](README.md) | **简体中文**

一个用于在 VS Code 编辑器中直接导入并可视化机器人模型（URDF / Xacro）的扩展。可在交互式 3D 视图中查看模型、实时调整关节角度、修改渲染效果、保存/加载场景配置，并可通过 OPC UA 与外部系统实时同步关节状态。

## 功能特性

- **模型导入** —— 预览 `.urdf` 和 `.xacro` 文件。Xacro 文件会在扩展端先展开再渲染。
- **3D 交互** —— 摄像机的旋转、平移与缩放；自动适配模型大小的取景。
- **关节控制** —— 每个可动关节一个滑块，并实时显示数值（旋转/连续关节用角度，移动关节用米）。
- **渲染设置** —— 背景颜色、地面网格、环境光/主光强度、视觉/碰撞几何体切换、线框模式、上方向轴（URDF 约定的 `+Z` 或 `+Y`）、**着色模式**（*原始* 或 *交替*），以及**坐标轴**（可切换世界原点坐标系和每个关节的坐标系，并配有坐标轴大小滑块）。
- **场景保存/加载** —— 将关节数值、摄像机位姿和渲染设置保存为 `*.robotscene.json` 文件，之后可再次加载还原。
- **可收起的选项卡面板** —— 停靠在侧边的面板，用选项卡（关节、摄像机、渲染、场景、OPC UA）切换功能；可通过边缘的拉手收起/拉出。
- **实时同步（OPC UA）** —— 提供六个配置分区（连接、安全、地址空间、变量命名、关节映射、运行）的面板，为每个关节订阅一个 NodeId，并将外部关节状态实时映射到视图中。
- **包路径解析** —— 通过 `robotViewer.packages` 设置解析 `package://<包名>/...` 形式的网格引用。同时始终会搜索模型自身所在目录及其上一级目录，因此即使 `package://` 里的包名与真实文件夹不一致，网格也能被找到。

支持的网格格式：**STL**、**Collada (.dae)**、**OBJ**、**glTF/GLB**。

## 使用方法

1. 打开包含机器人描述文件的**文件夹**（以便网格资源能被解析）。
2. 打开 `.urdf` / `.xacro` 文件，然后任选其一：
   - 点击编辑器标题栏的 **预览** 图标；
   - 通过命令面板运行 **Robot Viewer: Preview Robot Model**；
   - 在资源管理器中右键文件并选择 **Robot Viewer: Preview Robot Model**。
3. 使用侧边面板移动关节、调整渲染、保存/加载场景，以及连接实时同步。

仓库中的 [`samples/simple_arm.urdf`](samples/simple_arm.urdf) 是一个可直接运行的示例——它只用基本几何体，无需任何外部网格文件。

## 命令

| 命令 | 说明 |
| --- | --- |
| `Robot Viewer: Preview Robot Model` | 为当前/选中的模型文件打开 3D 预览。 |
| `Robot Viewer: Open Model File...` | 从磁盘选择一个模型文件并预览。 |
| `Robot Viewer: Load Scene Configuration...` | 将已保存的 `*.robotscene.json` 加载到当前预览。 |

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `robotViewer.packages` | `{}` | 将 ROS 包名映射到本地文件夹，用于 `package://` 解析。 |
| `robotViewer.backgroundColor` | `#263238` | 视图背景颜色。 |
| `robotViewer.showGrid` | `true` | 默认显示地面网格。 |
| `robotViewer.upAxis` | `+Z` | 用于确定模型朝向的上方向轴。 |
| `robotViewer.reRenderOnSave` | `true` | 保存被预览的文件时重新渲染。 |
| `robotViewer.opcua.endpoint` | `opc.tcp://localhost:4840` | OPC UA 默认端点（用于初始化面板）。 |
| `robotViewer.opcua.nodeIdTemplate` | `ns=2;s=Joints/{joint}` | 每个关节的 NodeId 模板（`{joint}` 会被替换为关节名）。 |

> 提示：即使不配置 `robotViewer.packages`，扩展也会自动把 URDF 所在目录及其上一级目录作为“隐式包根”来搜索网格文件。

### OPC UA 实时同步

在侧边栏打开 **Live Sync (OPC UA)** 面板，通过其六个分区完成配置：

1. **连接（Connection）** —— 服务器主机/IP 与端口。
2. **安全（Security）** —— 安全模式、安全策略，以及可选的用户名/密码（用户名留空即为匿名访问）。
3. **地址空间（Address Space）** —— 命名空间索引与 NodeId 标识符类型（字符串 / 数字 / GUID / 不透明）。
4. **变量命名（Variable Naming）** —— 所有关节共有的标识符**前缀**（例如 `Joints/`）。完整 NodeId 为 `ns=<n>;<类型>=<前缀><后缀>`。
5. **关节映射（Joint Mapping）** —— 每个关节一行的表格，只需填写各自不同的**后缀**（默认为关节名），并可启用/禁用及设置对每个输入值应用的 `scale`（缩放）/ `offset`（偏移）。
6. **运行（Runtime）** —— 监视项采样间隔、输入值单位（弧度或角度），以及带实时状态的 **连接 / 断开** 按钮。

`robotViewer.opcua.endpoint` 与 `robotViewer.opcua.nodeIdTemplate` 用于初始化面板的默认值；你在面板中所做的更改会按预览分别记住。密码不会写入磁盘。

## 开发

```powershell
npm install
npm run compile     # 单次构建
npm run watch       # 变更时自动重建
```

按 <kbd>F5</kbd>（Run Extension）启动扩展开发宿主。

构建产物位于 `dist/`（宿主端为 `extension.js`，3D 视图为 `webview.js`）。

## 许可证

MIT
