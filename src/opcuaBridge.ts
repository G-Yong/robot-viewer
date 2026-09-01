import type { OpcuaConfig, OpcuaJointMapping, OpcuaJointLiveState } from "./protocol";

const DEG2RAD = Math.PI / 180;

/**
 * Bridges an OPC UA server to the viewer: subscribes to a NodeId per joint and
 * forwards value changes. Loaded lazily so the extension does not pay the
 * node-opcua startup cost unless a connection is requested.
 */
export class OpcuaBridge {
  private client: any;
  private session: any;
  private subscription: any;
  private connected = false;
  private jointStates = new Map<string, OpcuaJointLiveState>();

  constructor(
    private readonly onValues: (values: Record<string, number>) => void,
    private readonly onStatus: (connected: boolean, detail?: string) => void,
    private readonly onJointState: (states: OpcuaJointLiveState[]) => void
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  private emitJointState(): void {
    this.onJointState([...this.jointStates.values()]);
  }

  private buildNodeId(cfg: OpcuaConfig, m: OpcuaJointMapping): string {
    const suffix = m.identifier.trim();
    // Allow a fully-qualified NodeId to be entered directly in the suffix.
    if (/^ns=\d+;/i.test(suffix)) {
      return suffix;
    }
    if (/^(i|s|g|b)=/i.test(suffix)) {
      return `ns=${cfg.namespace};${suffix}`;
    }
    const id = `${cfg.identifierPrefix}${suffix}`;
    return `ns=${cfg.namespace};${cfg.identifierType}=${id}`;
  }

  async connect(cfg: OpcuaConfig): Promise<void> {
    if (this.connected) {
      return;
    }

    let opcua: any;
    try {
      // Loaded dynamically: keeps activation fast and avoids hard failure when
      // the optional dependency is unavailable.
      opcua = require("node-opcua-client");
    } catch (e) {
      this.onStatus(false, "node-opcua-client is not installed");
      throw e;
    }

    const {
      OPCUAClient,
      AttributeIds,
      TimestampsToReturn,
      MessageSecurityMode,
      SecurityPolicy,
      UserTokenType,
    } = opcua;

    const endpoint = `opc.tcp://${cfg.host}:${cfg.port}`;
    const securityMode =
      MessageSecurityMode[cfg.securityMode] ?? MessageSecurityMode.None;
    const securityPolicy =
      SecurityPolicy[cfg.securityPolicy as keyof typeof SecurityPolicy] ??
      SecurityPolicy.None;

    this.client = OPCUAClient.create({
      endpointMustExist: false,
      securityMode,
      securityPolicy,
      connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 2000 },
    });

    this.client.on("backoff", (retry: number) =>
      this.onStatus(false, `retrying (${retry})...`)
    );

    try {
      await this.client.connect(endpoint);

      const userIdentity =
        cfg.username && cfg.username.length > 0
          ? {
              type: UserTokenType.UserName,
              userName: cfg.username,
              password: cfg.password,
            }
          : undefined;
      this.session = await this.client.createSession(userIdentity);

      this.subscription = await this.session.createSubscription2({
        requestedPublishingInterval: Math.max(50, cfg.samplingInterval),
        requestedLifetimeCount: 100,
        requestedMaxKeepAliveCount: 10,
        maxNotificationsPerPublish: 100,
        publishingEnabled: true,
        priority: 10,
      });

      const active = cfg.mappings.filter((m) => m.enabled);
      const unit = cfg.valueUnit === "deg" ? DEG2RAD : 1;
      let subscribedCount = 0;

      // Subscribe per joint; a bad NodeId must not tear down the whole
      // connection, so each monitor is guarded individually.
      for (const m of active) {
        const joint = m.joint;
        const nodeId = this.buildNodeId(cfg, m);
        this.jointStates.set(joint, { joint, nodeId, status: "pending" });

        try {
          const item = await this.subscription.monitor(
            { nodeId, attributeId: AttributeIds.Value },
            { samplingInterval: cfg.samplingInterval, discardOldest: true, queueSize: 10 },
            TimestampsToReturn.Both
          );
          subscribedCount += 1;
          this.jointStates.set(joint, { joint, nodeId, status: "subscribed" });

          item.on("changed", (dataValue: any) => {
            const raw = dataValue?.value?.value;
            if (typeof raw === "number" && !Number.isNaN(raw)) {
              const value = raw * unit * m.scale + m.offset;
              this.jointStates.set(joint, { joint, nodeId, status: "subscribed", value });
              this.emitJointState();
              this.onValues({ [joint]: value });
            }
          });
          item.on("err", (msg: string) => {
            const st = this.jointStates.get(joint);
            this.jointStates.set(joint, {
              joint,
              nodeId,
              status: "error",
              value: st?.value,
              error: String(msg),
            });
            this.emitJointState();
          });

          // node-opcua may defer the initial 'changed' event, so read the
          // current value once so the UI shows a value immediately.
          try {
            const dv = await this.session.readValue({
              nodeId,
              attributeId: AttributeIds.Value,
            });
            const raw = dv?.value?.value;
            if (typeof raw === "number" && !Number.isNaN(raw)) {
              const value = raw * unit * m.scale + m.offset;
              this.jointStates.set(joint, { joint, nodeId, status: "subscribed", value });
              this.emitJointState();
              this.onValues({ [joint]: value });
            }
          } catch {
            /* keep the subscribed state; no initial value yet */
          }
        } catch (e: any) {
          const st = this.jointStates.get(joint);
          this.jointStates.set(joint, {
            joint,
            nodeId,
            status: "error",
            value: st?.value,
            error: e?.message ?? String(e),
          });
        }
      }

      this.emitJointState();
      this.connected = true;
      this.onStatus(
        true,
        `connected to ${endpoint} (${subscribedCount}/${active.length} joints)`
      );
    } catch (e: any) {
      await this.safeCleanup();
      this.onStatus(false, e?.message ?? String(e));
      throw e;
    }
  }

  private async safeCleanup(): Promise<void> {
    try {
      await this.subscription?.terminate();
    } catch {
      /* ignore */
    }
    try {
      await this.session?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.client?.disconnect();
    } catch {
      /* ignore */
    }
    this.subscription = undefined;
    this.session = undefined;
    this.client = undefined;
    this.connected = false;
  }

  async disconnect(): Promise<void> {
    await this.safeCleanup();
    for (const [joint, st] of this.jointStates) {
      this.jointStates.set(joint, { ...st, status: "closed" });
    }
    this.emitJointState();
    this.onStatus(false, "disconnected");
  }

  dispose(): void {
    void this.safeCleanup();
  }
}
