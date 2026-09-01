import type { Viewer, JointInfo } from "./viewer";
import type {
  ViewerSettings,
  JointValues,
  OpcuaConfig,
  OpcuaJointMapping,
} from "../src/protocol";

export interface UICallbacks {
  onJointInput: (name: string, value: number) => void;
  onSettingsChange: (settings: Partial<ViewerSettings>) => void;
  onResetCamera: () => void;
  onResetJoints: () => void;
  onSaveScene: () => void;
  onLoadScene: () => void;
  onToggleOpcua: () => void;
  onOpcuaConfigChange?: (config: OpcuaConfig) => void;
}

const RAD2DEG = 180 / Math.PI;

function defaultOpcuaConfig(): OpcuaConfig {
  return {
    host: "localhost",
    port: 4840,
    namespace: 2,
    identifierType: "s",
    identifierPrefix: "Joints/",
    valueUnit: "rad",
    samplingInterval: 100,
    securityMode: "None",
    securityPolicy: "None",
    username: "",
    password: "",
    mappings: [],
  };
}

interface Tab {
  btn: HTMLButtonElement;
  body: HTMLElement;
}

export class UI {
  private sidebar!: HTMLElement;
  private tabbar!: HTMLElement;
  private tabContent!: HTMLElement;
  private tabs = new Map<string, Tab>();

  private jointBody!: HTMLElement;
  private statusEl!: HTMLElement;
  private opcuaBtn!: HTMLButtonElement;
  private mappingBody!: HTMLElement;
  private sliders = new Map<string, HTMLInputElement>();
  private valueLabels = new Map<string, HTMLElement>();
  private opcuaConnected = false;

  private opcua: OpcuaConfig = defaultOpcuaConfig();
  private opcuaUserModified = false;
  private opcuaFields: Record<string, HTMLInputElement | HTMLSelectElement> = {};

  constructor(
    private readonly root: HTMLElement,
    private readonly viewer: Viewer,
    private readonly cb: UICallbacks
  ) {
    this.build();
  }

  private build(): void {
    this.sidebar = el("div", { id: "sidebar" });

    const handle = el("button", { id: "sidebar-handle", title: "Collapse / expand" }, [
      "▶",
    ]) as HTMLButtonElement;
    handle.addEventListener("click", () => {
      const collapsed = this.sidebar.classList.toggle("collapsed");
      handle.textContent = collapsed ? "◀" : "▶";
    });
    this.sidebar.appendChild(handle);

    this.tabbar = el("div", { id: "tabs" });
    this.sidebar.appendChild(this.tabbar);

    this.tabContent = el("div", { id: "tab-content" });
    this.sidebar.appendChild(this.tabContent);

    this.root.appendChild(this.sidebar);

    this.addTab("joints", "Joints", (b) => this.fillJoints(b), true);
    this.addTab("camera", "Camera", (b) => this.fillCamera(b));
    this.addTab("render", "Render", (b) => this.fillRender(b));
    this.addTab("scene", "Scene", (b) => this.fillScene(b));
    this.addTab("opcua", "OPC UA", (b) => this.fillOpcua(b));

    const hint = el("div", { class: "hint" }, [
      "Left-drag: rotate • Right-drag: pan • Wheel: zoom",
    ]);
    this.root.appendChild(hint);
  }

  private addTab(
    id: string,
    label: string,
    fill: (body: HTMLElement) => void,
    active = false
  ): void {
    const btn = el("button", { class: "tab-btn" }, [label]) as HTMLButtonElement;
    btn.addEventListener("click", () => this.selectTab(id));
    this.tabbar.appendChild(btn);

    const body = el("div", { class: "tab-body" });
    body.style.display = active ? "block" : "none";
    btn.classList.toggle("active", active);
    fill(body);
    this.tabContent.appendChild(body);

    this.tabs.set(id, { btn, body });
  }

  private selectTab(id: string): void {
    for (const [key, tab] of this.tabs) {
      const on = key === id;
      tab.body.style.display = on ? "block" : "none";
      tab.btn.classList.toggle("active", on);
    }
  }

  // Sub-section (collapsible) used inside the OPC UA tab.
  private section(title: string, collapsed = false): {
    section: HTMLElement;
    body: HTMLElement;
  } {
    const section = el("div", { class: "section" + (collapsed ? " collapsed" : "") });
    const header = el("div", { class: "section-header" }, [title, el("span", {}, ["▾"])]);
    const body = el("div", { class: "section-body" });
    header.addEventListener("click", () => section.classList.toggle("collapsed"));
    section.appendChild(header);
    section.appendChild(body);
    return { section, body };
  }

  // ---- Joints tab -----------------------------------------------------------
  private fillJoints(body: HTMLElement): void {
    this.jointBody = body;
    body.appendChild(el("div", { class: "empty" }, ["No model loaded."]));
  }

  populateJoints(joints: JointInfo[]): void {
    this.jointBody.innerHTML = "";
    this.sliders.clear();
    this.valueLabels.clear();

    if (joints.length === 0) {
      this.jointBody.appendChild(el("div", { class: "empty" }, ["No movable joints."]));
      this.rebuildJointMappings([]);
      return;
    }

    for (const j of joints) {
      const valueLabel = el("span", { class: "joint-value" }, [this.fmt(j)]);
      const head = el("div", { class: "joint-head" }, [
        el("span", { class: "joint-name", title: j.name }, [j.name]),
        valueLabel,
      ]);

      const isContinuous = j.type === "continuous";
      const lower = isContinuous ? -Math.PI : j.lower;
      const upper = isContinuous ? Math.PI : j.upper;
      const slider = el("input", {
        type: "range",
        min: String(lower),
        max: String(upper),
        step: "0.001",
        value: String(j.value),
      }) as HTMLInputElement;

      slider.addEventListener("input", () => {
        const v = Number(slider.value);
        this.cb.onJointInput(j.name, v);
        valueLabel.textContent = this.fmt({ ...j, value: v });
      });

      const row = el("div", { class: "joint-row" }, [head, slider]);
      this.jointBody.appendChild(row);
      this.sliders.set(j.name, slider);
      this.valueLabels.set(j.name, valueLabel);
    }

    this.rebuildJointMappings(joints.map((j) => j.name));
  }

  private fmt(j: JointInfo): string {
    if (j.type === "prismatic") {
      return `${j.value.toFixed(3)} m`;
    }
    return `${(j.value * RAD2DEG).toFixed(1)}°`;
  }

  updateJointValues(values: JointValues): void {
    for (const [name, value] of Object.entries(values)) {
      const slider = this.sliders.get(name);
      const label = this.valueLabels.get(name);
      if (slider) {
        slider.value = String(value);
      }
      if (label) {
        label.textContent = `${(value * RAD2DEG).toFixed(1)}°`;
      }
    }
  }

  // ---- Camera tab -----------------------------------------------------------
  private fillCamera(body: HTMLElement): void {
    const reset = el("button", { class: "action secondary" }, ["Reset / Fit View"]);
    reset.addEventListener("click", () => this.cb.onResetCamera());
    body.appendChild(el("div", { class: "row" }, [reset]));
  }

  // ---- Rendering tab --------------------------------------------------------
  private fillRender(body: HTMLElement): void {
    const s = this.viewer.getSettings();

    const bg = el("input", { type: "color", value: s.backgroundColor }) as HTMLInputElement;
    bg.addEventListener("input", () =>
      this.cb.onSettingsChange({ backgroundColor: bg.value })
    );
    body.appendChild(el("div", { class: "row" }, [el("label", {}, ["Background"]), bg]));

    body.appendChild(
      this.checkbox("Show grid", s.showGrid, (v) => this.cb.onSettingsChange({ showGrid: v }))
    );
    body.appendChild(
      this.checkbox("Show visual", s.showVisual, (v) =>
        this.cb.onSettingsChange({ showVisual: v })
      )
    );
    body.appendChild(
      this.checkbox("Show collision", s.showCollision, (v) =>
        this.cb.onSettingsChange({ showCollision: v })
      )
    );
    body.appendChild(
      this.checkbox("Wireframe", s.wireframe, (v) => this.cb.onSettingsChange({ wireframe: v }))
    );

    body.appendChild(
      this.sliderRow("Ambient", 0, 3, s.ambientIntensity, (v) =>
        this.cb.onSettingsChange({ ambientIntensity: v })
      )
    );
    body.appendChild(
      this.sliderRow("Key light", 0, 5, s.directionalIntensity, (v) =>
        this.cb.onSettingsChange({ directionalIntensity: v })
      )
    );

    const up = el("select", {}, [
      option("+Z", "Z up (URDF)", s.upAxis === "+Z"),
      option("+Y", "Y up", s.upAxis === "+Y"),
    ]) as HTMLSelectElement;
    up.addEventListener("change", () =>
      this.cb.onSettingsChange({ upAxis: up.value as "+Z" | "+Y" })
    );
    body.appendChild(el("div", { class: "row" }, [el("label", {}, ["Up axis"]), up]));

    const colorMode = el("select", {}, [
      option("original", "Original (URDF material)", s.colorMode === "original"),
      option("alternate", "Alternate (distinct per link)", s.colorMode === "alternate"),
    ]) as HTMLSelectElement;
    colorMode.addEventListener("change", () =>
      this.cb.onSettingsChange({ colorMode: colorMode.value as "original" | "alternate" })
    );
    body.appendChild(el("div", { class: "row" }, [el("label", {}, ["Color mode"]), colorMode]));
  }

  // ---- Scene tab ------------------------------------------------------------
  private fillScene(body: HTMLElement): void {
    const save = el("button", { class: "action" }, ["Save"]);
    const load = el("button", { class: "action secondary" }, ["Load"]);
    save.addEventListener("click", () => this.cb.onSaveScene());
    load.addEventListener("click", () => this.cb.onLoadScene());
    body.appendChild(el("div", { class: "row" }, [save, load]));

    const resetJoints = el("button", { class: "action secondary" }, ["Reset joints to 0"]);
    resetJoints.addEventListener("click", () => this.cb.onResetJoints());
    body.appendChild(el("div", { class: "row" }, [resetJoints]));
  }

  // ---- OPC UA tab -----------------------------------------------------------
  private fillOpcua(body: HTMLElement): void {
    body.appendChild(this.opcuaConnectionSection());
    body.appendChild(this.opcuaSecuritySection());
    body.appendChild(this.opcuaAddressSpaceSection());
    body.appendChild(this.opcuaNamingSection());
    body.appendChild(this.opcuaMappingSection());
    body.appendChild(this.opcuaRuntimeSection());
  }

  private opcuaConnectionSection(): HTMLElement {
    const { section, body } = this.section("1 · Connection");
    body.appendChild(
      this.textField("Host / IP", this.opcua.host, (v) => this.updateOpcua({ host: v }))
    );
    body.appendChild(
      this.numberField("Port", this.opcua.port, { min: 1, max: 65535, step: 1 }, (v) =>
        this.updateOpcua({ port: v })
      )
    );
    this.opcuaFields.host = body.querySelector<HTMLInputElement>('[data-field="Host / IP"]')!;
    this.opcuaFields.port = body.querySelector<HTMLInputElement>('[data-field="Port"]')!;
    return section;
  }

  private opcuaSecuritySection(): HTMLElement {
    const { section, body } = this.section("2 · Security", true);
    body.appendChild(
      this.selectField(
        "Mode",
        [
          ["None", "None"],
          ["Sign", "Sign"],
          ["SignAndEncrypt", "Sign & Encrypt"],
        ],
        this.opcua.securityMode,
        (v) => this.updateOpcua({ securityMode: v as OpcuaConfig["securityMode"] })
      )
    );
    body.appendChild(
      this.selectField(
        "Policy",
        [
          ["None", "None"],
          ["Basic256Sha256", "Basic256Sha256"],
          ["Aes128_Sha256_RsaOaep", "Aes128_Sha256_RsaOaep"],
          ["Aes256_Sha256_RsaPss", "Aes256_Sha256_RsaPss"],
        ],
        this.opcua.securityPolicy,
        (v) => this.updateOpcua({ securityPolicy: v })
      )
    );
    body.appendChild(
      this.textField("Username", this.opcua.username, (v) => this.updateOpcua({ username: v }))
    );
    body.appendChild(
      this.textField(
        "Password",
        this.opcua.password,
        (v) => this.updateOpcua({ password: v }),
        "password"
      )
    );
    this.opcuaFields.username = body.querySelector<HTMLInputElement>('[data-field="Username"]')!;
    this.opcuaFields.password = body.querySelector<HTMLInputElement>('[data-field="Password"]')!;
    body.appendChild(el("div", { class: "note" }, ["Leave username empty for anonymous access."]));
    return section;
  }

  private opcuaAddressSpaceSection(): HTMLElement {
    const { section, body } = this.section("3 · Address Space", true);
    body.appendChild(
      this.numberField("Namespace", this.opcua.namespace, { min: 0, max: 255, step: 1 }, (v) =>
        this.updateOpcua({ namespace: v })
      )
    );
    body.appendChild(
      this.selectField(
        "Id type",
        [
          ["s", "String (s)"],
          ["i", "Numeric (i)"],
          ["g", "GUID (g)"],
          ["b", "Opaque (b)"],
        ],
        this.opcua.identifierType,
        (v) => this.updateOpcua({ identifierType: v as OpcuaConfig["identifierType"] })
      )
    );
    this.opcuaFields.namespace = body.querySelector<HTMLInputElement>('[data-field="Namespace"]')!;
    this.opcuaFields.identifierType =
      body.querySelector<HTMLSelectElement>('[data-field="Id type"]')!;
    return section;
  }

  private opcuaNamingSection(): HTMLElement {
    const { section, body } = this.section("4 · Variable Naming");
    body.appendChild(
      this.textField("Common prefix", this.opcua.identifierPrefix, (v) =>
        this.updateOpcua({ identifierPrefix: v })
      )
    );
    body.appendChild(
      el("div", { class: "note" }, [
        "Full NodeId = ns=<n>;<type>=<prefix><suffix>. Enter the shared part here; ",
        "set each joint's differing suffix in Joint Mapping below.",
      ])
    );
    this.opcuaFields.identifierPrefix =
      body.querySelector<HTMLInputElement>('[data-field="Common prefix"]')!;
    return section;
  }

  private opcuaMappingSection(): HTMLElement {
    const { section, body } = this.section("5 · Joint Mapping");
    this.mappingBody = el("div", { class: "mapping" });
    body.appendChild(this.mappingBody);
    this.rebuildJointMappings(this.opcua.mappings.map((m) => m.joint));
    return section;
  }

  private opcuaRuntimeSection(): HTMLElement {
    const { section, body } = this.section("6 · Runtime");
    body.appendChild(
      this.numberField(
        "Sampling (ms)",
        this.opcua.samplingInterval,
        { min: 10, max: 10000, step: 10 },
        (v) => this.updateOpcua({ samplingInterval: v })
      )
    );
    body.appendChild(
      this.selectField(
        "Value unit",
        [
          ["rad", "Radians"],
          ["deg", "Degrees"],
        ],
        this.opcua.valueUnit,
        (v) => this.updateOpcua({ valueUnit: v as OpcuaConfig["valueUnit"] })
      )
    );
    this.opcuaFields.samplingInterval =
      body.querySelector<HTMLInputElement>('[data-field="Sampling (ms)"]')!;
    this.opcuaFields.valueUnit = body.querySelector<HTMLSelectElement>('[data-field="Value unit"]')!;

    this.opcuaBtn = el("button", { class: "action" }, ["Connect"]) as HTMLButtonElement;
    this.opcuaBtn.addEventListener("click", () => this.cb.onToggleOpcua());
    body.appendChild(el("div", { class: "row" }, [this.opcuaBtn]));

    this.statusEl = el("div", { class: "status" }, [
      el("span", { class: "dot" }),
      el("span", { class: "status-text" }, ["Disconnected"]),
    ]);
    body.appendChild(this.statusEl);
    return section;
  }

  private rebuildJointMappings(jointNames: string[]): void {
    if (!this.mappingBody) {
      return;
    }
    const existing = new Map(this.opcua.mappings.map((m) => [m.joint, m]));
    this.opcua.mappings = jointNames.map(
      (joint): OpcuaJointMapping =>
        existing.get(joint) ?? { joint, identifier: joint, enabled: true, scale: 1, offset: 0 }
    );

    this.mappingBody.innerHTML = "";

    if (jointNames.length === 0) {
      this.mappingBody.appendChild(
        el("div", { class: "empty" }, ["Load a model to bind joints."])
      );
      return;
    }

    const header = el("div", { class: "map-head" }, [
      el("span", {}, ["On"]),
      el("span", {}, ["Joint"]),
      el("span", {}, ["Suffix"]),
      el("span", {}, ["×"]),
      el("span", {}, ["+"]),
    ]);
    this.mappingBody.appendChild(header);

    for (const m of this.opcua.mappings) {
      const enabled = el("input", { type: "checkbox" }) as HTMLInputElement;
      enabled.checked = m.enabled;
      const identifier = el("input", {
        type: "text",
        class: "map-id",
        value: m.identifier,
        title: `suffix for ${m.joint}`,
      }) as HTMLInputElement;
      const scale = el("input", {
        type: "number",
        class: "map-num",
        step: "0.001",
        value: String(m.scale),
      }) as HTMLInputElement;
      const offset = el("input", {
        type: "number",
        class: "map-num",
        step: "0.001",
        value: String(m.offset),
      }) as HTMLInputElement;

      const sync = () => {
        m.enabled = enabled.checked;
        m.identifier = identifier.value;
        m.scale = Number(scale.value) || 0;
        m.offset = Number(offset.value) || 0;
        this.emitOpcuaChange();
      };
      enabled.addEventListener("change", sync);
      identifier.addEventListener("input", sync);
      scale.addEventListener("input", sync);
      offset.addEventListener("input", sync);

      const row = el("div", { class: "map-row" }, [
        enabled,
        el("span", { class: "map-joint", title: m.joint }, [m.joint]),
        identifier,
        scale,
        offset,
      ]);
      this.mappingBody.appendChild(row);
    }
  }

  private updateOpcua(patch: Partial<OpcuaConfig>): void {
    this.opcua = { ...this.opcua, ...patch };
    this.opcuaUserModified = true;
    this.emitOpcuaChange();
  }

  private emitOpcuaChange(): void {
    this.cb.onOpcuaConfigChange?.(this.getOpcuaConfig());
  }

  getOpcuaConfig(): OpcuaConfig {
    return { ...this.opcua, mappings: this.opcua.mappings.map((m) => ({ ...m })) };
  }

  setOpcuaDefaults(partial: Partial<OpcuaConfig>): void {
    if (this.opcuaUserModified) {
      return;
    }
    this.opcua = { ...this.opcua, ...partial };
    this.refreshOpcuaFields();
  }

  applyOpcuaConfig(cfg: OpcuaConfig): void {
    this.opcua = { ...defaultOpcuaConfig(), ...cfg };
    this.opcuaUserModified = true;
    this.refreshOpcuaFields();
    this.rebuildJointMappings(this.opcua.mappings.map((m) => m.joint));
  }

  private refreshOpcuaFields(): void {
    const set = (key: string, value: string) => {
      const f = this.opcuaFields[key];
      if (f) {
        f.value = value;
      }
    };
    set("host", this.opcua.host);
    set("port", String(this.opcua.port));
    set("namespace", String(this.opcua.namespace));
    set("identifierType", this.opcua.identifierType);
    set("identifierPrefix", this.opcua.identifierPrefix);
    set("samplingInterval", String(this.opcua.samplingInterval));
    set("valueUnit", this.opcua.valueUnit);
    set("username", this.opcua.username);
    set("password", this.opcua.password);
  }

  setConnectionStatus(connected: boolean, detail?: string): void {
    this.opcuaConnected = connected;
    this.opcuaBtn.textContent = connected ? "Disconnect" : "Connect";
    this.statusEl.classList.toggle("connected", connected);
    const text = this.statusEl.querySelector(".status-text");
    if (text) {
      text.textContent = detail ?? (connected ? "Connected" : "Disconnected");
    }
  }

  isOpcuaConnected(): boolean {
    return this.opcuaConnected;
  }

  // ---- Small input helpers --------------------------------------------------
  private checkbox(
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void
  ): HTMLElement {
    const input = el("input", { type: "checkbox" }) as HTMLInputElement;
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    return el("div", { class: "row" }, [input, el("label", {}, [label])]);
  }

  private sliderRow(
    label: string,
    min: number,
    max: number,
    value: number,
    onChange: (v: number) => void
  ): HTMLElement {
    const input = el("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: "0.05",
      value: String(value),
    }) as HTMLInputElement;
    input.addEventListener("input", () => onChange(Number(input.value)));
    return el("div", { class: "joint-row" }, [
      el("div", { class: "joint-head" }, [el("span", {}, [label])]),
      input,
    ]);
  }

  private textField(
    label: string,
    value: string,
    onChange: (v: string) => void,
    type = "text"
  ): HTMLElement {
    const input = el("input", { type, "data-field": label, value }) as HTMLInputElement;
    input.addEventListener("input", () => onChange(input.value));
    return el("div", { class: "field" }, [el("label", {}, [label]), input]);
  }

  private numberField(
    label: string,
    value: number,
    opts: { min: number; max: number; step: number },
    onChange: (v: number) => void
  ): HTMLElement {
    const input = el("input", {
      type: "number",
      "data-field": label,
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
      value: String(value),
    }) as HTMLInputElement;
    input.addEventListener("input", () => onChange(Number(input.value)));
    return el("div", { class: "field" }, [el("label", {}, [label]), input]);
  }

  private selectField(
    label: string,
    opts: [string, string][],
    value: string,
    onChange: (v: string) => void
  ): HTMLElement {
    const select = el(
      "select",
      { "data-field": label },
      opts.map(([v, l]) => option(v, l, v === value))
    ) as HTMLSelectElement;
    select.addEventListener("change", () => onChange(select.value));
    return el("div", { class: "field" }, [el("label", {}, [label]), select]);
  }
}

type Child = Node | string;

function el(
  tag: string,
  attrs: Record<string, string> = {},
  children: Child[] = []
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function option(value: string, label: string, selected: boolean): HTMLElement {
  const o = el("option", { value }, [label]) as HTMLOptionElement;
  o.selected = selected;
  return o;
}
