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
    identifierTemplate: "{joint}",
    valueUnit: "rad",
    samplingInterval: 100,
    securityMode: "None",
    securityPolicy: "None",
    username: "",
    password: "",
    mappings: [],
  };
}

export class UI {
  private sidebar!: HTMLElement;
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
  private mappingRows: {
    identifier: HTMLInputElement;
    enabled: HTMLInputElement;
    scale: HTMLInputElement;
    offset: HTMLInputElement;
  }[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly viewer: Viewer,
    private readonly cb: UICallbacks
  ) {
    this.build();
  }

  private build(): void {
    const toggle = el("button", { id: "sidebar-toggle" }, ["☰ Panel"]);
    toggle.addEventListener("click", () => this.sidebar.classList.toggle("collapsed"));
    this.root.appendChild(toggle);

    this.sidebar = el("div", { id: "sidebar" });
    this.root.appendChild(this.sidebar);

    this.sidebar.appendChild(this.buildJointsSection());
    this.sidebar.appendChild(this.buildCameraSection());
    this.sidebar.appendChild(this.buildRenderSection());
    this.sidebar.appendChild(this.buildSceneSection());
    this.sidebar.appendChild(this.buildSyncSection());

    const hint = el("div", { class: "hint" }, [
      "Left-drag: rotate • Right-drag: pan • Wheel: zoom",
    ]);
    this.root.appendChild(hint);
  }

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

  private buildJointsSection(): HTMLElement {
    const { section, body } = this.section("Joints");
    this.jointBody = body;
    body.appendChild(el("div", { class: "empty" }, ["No model loaded."]));
    return section;
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
      const row = el("div", { class: "joint-row" });
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

      row.appendChild(head);
      row.appendChild(slider);
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

  /** Reflect externally-driven joint values into the sliders. */
  updateJointValues(values: JointValues): void {
    for (const [name, value] of Object.entries(values)) {
      const slider = this.sliders.get(name);
      const label = this.valueLabels.get(name);
      if (slider) {
        slider.value = String(value);
      }
      if (label) {
        // Prismatic joints are rare in sync; assume revolute for label unit.
        label.textContent = `${(value * RAD2DEG).toFixed(1)}°`;
      }
    }
  }

  private buildCameraSection(): HTMLElement {
    const { section, body } = this.section("Camera");
    const reset = el("button", { class: "action secondary" }, ["Reset / Fit View"]);
    reset.addEventListener("click", () => this.cb.onResetCamera());
    body.appendChild(el("div", { class: "row" }, [reset]));
    return section;
  }

  private buildRenderSection(): HTMLElement {
    const { section, body } = this.section("Rendering");
    const s = this.viewer.getSettings();

    const bg = el("input", { type: "color", value: s.backgroundColor }) as HTMLInputElement;
    bg.addEventListener("input", () =>
      this.cb.onSettingsChange({ backgroundColor: bg.value })
    );
    body.appendChild(el("div", { class: "row" }, [el("label", {}, ["Background"]), bg]));

    body.appendChild(
      this.checkbox("Show grid", s.showGrid, (v) =>
        this.cb.onSettingsChange({ showGrid: v })
      )
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
      this.checkbox("Wireframe", s.wireframe, (v) =>
        this.cb.onSettingsChange({ wireframe: v })
      )
    );

    body.appendChild(
      this.slider("Ambient", 0, 3, s.ambientIntensity, (v) =>
        this.cb.onSettingsChange({ ambientIntensity: v })
      )
    );
    body.appendChild(
      this.slider("Key light", 0, 5, s.directionalIntensity, (v) =>
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

    return section;
  }

  private buildSceneSection(): HTMLElement {
    const { section, body } = this.section("Scene");
    const save = el("button", { class: "action" }, ["Save"]);
    const load = el("button", { class: "action secondary" }, ["Load"]);
    save.addEventListener("click", () => this.cb.onSaveScene());
    load.addEventListener("click", () => this.cb.onLoadScene());
    body.appendChild(el("div", { class: "row" }, [save, load]));

    const resetJoints = el("button", { class: "action secondary" }, ["Reset joints to 0"]);
    resetJoints.addEventListener("click", () => this.cb.onResetJoints());
    body.appendChild(el("div", { class: "row" }, [resetJoints]));
    return section;
  }

  private buildSyncSection(): HTMLElement {
    const { section, body } = this.section("Live Sync (OPC UA)");

    body.appendChild(this.opcuaConnectionSection());
    body.appendChild(this.opcuaSecuritySection());
    body.appendChild(this.opcuaAddressSpaceSection());
    body.appendChild(this.opcuaNamingSection());
    body.appendChild(this.opcuaMappingSection());
    body.appendChild(this.opcuaRuntimeSection());

    return section;
  }

  // 1 · Connection ------------------------------------------------------------
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

  // 2 · Security --------------------------------------------------------------
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
      this.textField("Username", this.opcua.username, (v) =>
        this.updateOpcua({ username: v })
      )
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
    body.appendChild(
      el("div", { class: "note" }, ["Leave username empty for anonymous access."])
    );
    return section;
  }

  // 3 · Address space ---------------------------------------------------------
  private opcuaAddressSpaceSection(): HTMLElement {
    const { section, body } = this.section("3 · Address Space", true);
    body.appendChild(
      this.numberField(
        "Namespace",
        this.opcua.namespace,
        { min: 0, max: 255, step: 1 },
        (v) => this.updateOpcua({ namespace: v })
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
    this.opcuaFields.identifierType = body.querySelector<HTMLSelectElement>('[data-field="Id type"]')!;
    return section;
  }

  // 4 · Variable naming -------------------------------------------------------
  private opcuaNamingSection(): HTMLElement {
    const { section, body } = this.section("4 · Variable Naming", true);
    body.appendChild(
      this.textField("Template", this.opcua.identifierTemplate, (v) =>
        this.updateOpcua({ identifierTemplate: v })
      )
    );
    body.appendChild(
      el("div", { class: "note" }, ["'{joint}' is replaced by each joint name."])
    );
    const apply = el("button", { class: "action secondary" }, ["Apply template to all joints"]);
    apply.addEventListener("click", () => this.applyTemplateToMappings());
    body.appendChild(el("div", { class: "row" }, [apply]));
    this.opcuaFields.identifierTemplate =
      body.querySelector<HTMLInputElement>('[data-field="Template"]')!;
    return section;
  }

  // 5 · Joint mapping ---------------------------------------------------------
  private opcuaMappingSection(): HTMLElement {
    const { section, body } = this.section("5 · Joint Mapping", true);
    this.mappingBody = el("div", { class: "mapping" });
    body.appendChild(this.mappingBody);
    this.rebuildJointMappings(this.opcua.mappings.map((m) => m.joint));
    return section;
  }

  // 6 · Runtime + connection controls ----------------------------------------
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
    // Merge: keep existing overrides, add new joints, drop stale ones.
    const existing = new Map(this.opcua.mappings.map((m) => [m.joint, m]));
    this.opcua.mappings = jointNames.map(
      (joint): OpcuaJointMapping =>
        existing.get(joint) ?? {
          joint,
          identifier: this.opcua.identifierTemplate.replace(/\{joint\}/g, joint),
          enabled: true,
          scale: 1,
          offset: 0,
        }
    );

    this.mappingBody.innerHTML = "";
    this.mappingRows = [];

    if (jointNames.length === 0) {
      this.mappingBody.appendChild(el("div", { class: "empty" }, ["Load a model to bind joints."]));
      return;
    }

    const header = el("div", { class: "map-head" }, [
      el("span", {}, ["On"]),
      el("span", {}, ["Joint"]),
      el("span", {}, ["Identifier"]),
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
        title: m.joint,
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
      this.mappingRows.push({ identifier, enabled, scale, offset });
    }
  }

  private applyTemplateToMappings(): void {
    for (let i = 0; i < this.opcua.mappings.length; i++) {
      const m = this.opcua.mappings[i];
      m.identifier = this.opcua.identifierTemplate.replace(/\{joint\}/g, m.joint);
      const row = this.mappingRows[i];
      if (row) {
        row.identifier.value = m.identifier;
      }
    }
    this.emitOpcuaChange();
  }

  private updateOpcua(patch: Partial<OpcuaConfig>): void {
    this.opcua = { ...this.opcua, ...patch };
    this.opcuaUserModified = true;
    this.emitOpcuaChange();
  }

  private emitOpcuaChange(): void {
    this.cb.onOpcuaConfigChange?.(this.getOpcuaConfig());
  }

  /** Current OPC UA configuration, mappings included. */
  getOpcuaConfig(): OpcuaConfig {
    return { ...this.opcua, mappings: this.opcua.mappings.map((m) => ({ ...m })) };
  }

  /** Apply host-provided defaults unless the user already edited the panel. */
  setOpcuaDefaults(partial: Partial<OpcuaConfig>): void {
    if (this.opcuaUserModified) {
      return;
    }
    this.opcua = { ...this.opcua, ...partial };
    this.refreshOpcuaFields();
    this.applyTemplateToMappings();
  }

  /** Restore a full saved configuration (takes precedence over defaults). */
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
    set("identifierTemplate", this.opcua.identifierTemplate);
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

  private slider(
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
