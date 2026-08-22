import {
  iceServersResponseSchema,
  isTerminalControllerClose,
  joinRoomResponseSchema,
  parseServerMessage,
  remoteInitialConnectTimeoutMs,
  remoteSessionTimeoutMs,
  type RemoteConnectionMode,
  type RemoteCommand,
  type RemoteIceServers,
  type RemotePath,
  type RemotePermissions,
} from "../app/remote/RemoteProtocol.ts";
import { WebSocketTransport, type RemoteTransport } from "../app/remote/WebSocketTransport.ts";
import { ControllerCommandSender } from "./ControllerCommandSender.ts";
import { WebRtcController } from "./WebRtcController.ts";

export interface ControllerConnectionEvents {
  onStatus(status: "joining" | "connecting" | "connected" | "disconnected" | "error", detail?: string): void;
  onPermissions(permissions: RemotePermissions): void;
  onLatency(rttMs: number): void;
  onWebRtcState(connected: boolean, path: RemotePath): void;
  onConnectionMode(mode: RemoteConnectionMode): void;
}

/** JOIN/WS control planeとHost指定のWebRTC data planeを管理する */
export class ControllerConnection {
  private readonly baseUrl = import.meta.env.VITE_REMOTE_BASE_URL?.trim() ?? "";
  private readonly events: ControllerConnectionEvents;
  private transport: RemoteTransport | null = null;
  private readonly commands: ControllerCommandSender;
  private readonly webRtc: WebRtcController;
  private connectionMode: RemoteConnectionMode = "ws";
  private webRtcConnected = false;
  private roomId: string | null = null;
  private sessionTicket: string | null = null;
  private controllerSessionId: string | null = null;
  private destroyed = false;
  private expiryTimer: number | null = null;
  private readyTimer: number | null = null;
  private modeGeneration = 0;
  private cachedIceServers: RemoteIceServers | null = null;

  constructor(events: ControllerConnectionEvents) {
    this.events = events;
    this.webRtc = new WebRtcController({
      sendSignal: (message) => this.transport?.sendReliable(message) ?? false,
      onState: (connected, path) => {
        this.webRtcConnected = connected;
        this.events.onWebRtcState(connected, path);
      },
    });
    this.commands = new ControllerCommandSender((envelope) => {
      if (this.connectionMode === "ws") return this.transport?.sendRealtime(envelope) ?? false;
      if (this.connectionMode === "auto") {
        if (this.webRtcConnected && this.webRtc.send(envelope)) return true;
        return this.transport?.sendRealtime(envelope) ?? false;
      }
      return this.webRtc.send(envelope);
    });
  }

  /** QR secretを短期session ticketへ交換してWebSocket control planeへ接続する */
  async join(roomId: string, joinSecret: string): Promise<void> {
    if (!this.baseUrl) throw new Error("VITE_REMOTE_BASE_URL is not configured");
    this.events.onStatus("joining");
    const response = await fetch(new URL(`v1/rooms/${encodeURIComponent(roomId)}/join`, this.withTrailingSlash(this.baseUrl)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinSecret }),
    });
    if (!response.ok) {
      throw new Error(response.status === 403
        ? "QR expired, JOIN closed, or room expired"
        : `JOIN failed (${response.status})`);
    }
    const parsed = joinRoomResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.roomId !== roomId) throw new Error("Invalid JOIN response");
    this.commands.setPermissions(parsed.data.permissions);
    this.roomId = roomId;
    this.sessionTicket = parsed.data.sessionTicket;
    this.controllerSessionId = parsed.data.controllerSessionId;
    this.events.onPermissions(parsed.data.permissions);
    this.connect(roomId, parsed.data.sessionTicket);
    this.scheduleExpiry(parsed.data.expiresAt);
    this.scheduleReadyDeadline(parsed.data.connectBy);
  }

  sendCommand(command: RemoteCommand): boolean {
    return this.commands.send(command);
  }

  /** Controller sessionの接続資源を破棄する */
  destroy(): void {
    this.destroyed = true;
    this.cleanupConnection();
  }

  private connect(roomId: string, sessionTicket: string): void {
    this.events.onStatus("connecting");
    this.transport = new WebSocketTransport({
      baseUrl: this.baseUrl,
      roomId,
      sessionTicket,
      autoReconnect: false,
      events: {
        onOpen: () => this.events.onStatus("connecting"),
        onClose: (event) => {
          if (this.destroyed) return;
          if (isTerminalControllerClose(event.code)) this.endSession(event.code === 4002 ? "Remote session opened elsewhere" : "Remote session expired");
          else this.disconnectSession("Re-scan the QR to reconnect");
        },
        onError: () => { if (!this.destroyed) this.events.onStatus("disconnected"); },
        onMessage: (data) => this.handleMessage(data),
      },
    });
  }

  private scheduleExpiry(expiresAt: number): void {
    const remaining = remoteSessionTimeoutMs(expiresAt);
    if (remaining <= 0) return this.endSession("Remote session expired");
    this.expiryTimer = window.setTimeout(() => this.endSession("Remote session expired"), remaining);
  }

  private scheduleReadyDeadline(connectBy: number): void {
    const remaining = remoteInitialConnectTimeoutMs(connectBy);
    if (remaining <= 0) return this.endSession("Remote connection ticket expired");
    this.readyTimer = window.setTimeout(() => this.endSession("Remote connection ticket expired"), remaining);
  }

  /** terminal errorとしてsessionを終了する */
  private endSession(detail: string): void {
    this.finishSession("error", detail);
  }

  /** 再JOINが必要な切断としてsessionを終了する */
  private disconnectSession(detail: string): void {
    this.finishSession("disconnected", detail);
  }

  /** cleanup後に終了理由ごとのstatusを一度だけ通知する */
  private finishSession(status: "error" | "disconnected", detail: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cleanupConnection();
    this.events.onStatus(status, detail);
  }

  /** session timerと全transportを同じ順序で解放する */
  private cleanupConnection(): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    if (this.readyTimer !== null) window.clearTimeout(this.readyTimer);
    this.expiryTimer = null;
    this.readyTimer = null;
    const transport = this.transport;
    this.transport = null;
    transport?.close();
    this.webRtc.close();
  }

  /** server stateをHost authorityとして適用する */
  private handleMessage(data: unknown): void {
    const message = parseServerMessage(data);
    if (!message) return;
    if (message.type === "ready" && message.role === "controller") {
      if (this.readyTimer !== null) window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.commands.setPermissions(message.permissions);
      this.events.onPermissions(message.permissions);
      this.events.onStatus("connected");
      void this.applyConnectionMode(message.connectionMode);
    } else if (message.type === "connectionMode") {
      void this.applyConnectionMode(message.mode);
    } else if (message.type === "permissions") {
      this.commands.setPermissions(message.permissions);
      this.events.onPermissions(message.permissions);
    } else if (message.type === "ping") {
      this.transport?.sendRealtime({ v: 1, type: "pong", nonce: message.nonce });
    } else if (message.type === "latency") {
      this.events.onLatency(message.rttMs);
    } else if (message.type === "rtcOffer" && message.controllerSessionId === this.controllerSessionId) {
      void this.webRtc.handleOffer(message);
    } else if (message.type === "rtcIceCandidate" && message.controllerSessionId === this.controllerSessionId) {
      void this.webRtc.handleCandidate(message);
    } else if (message.type === "error") {
      this.events.onStatus("error", message.message);
    }
  }

  /** AUTO/TURNだけ短期Cloudflare ICE credentialを取得する */
  private async applyConnectionMode(mode: RemoteConnectionMode): Promise<void> {
    const generation = ++this.modeGeneration;
    this.connectionMode = mode;
    this.webRtcConnected = false;
    this.events.onConnectionMode(mode);
    this.webRtc.prepareMode(mode);
    if (mode === "ws") {
      this.webRtc.setMode("ws");
      return;
    }
    try {
      const iceServers = mode === "direct" ? [] : await this.getIceServers();
      if (this.destroyed || generation !== this.modeGeneration || this.connectionMode !== mode) return;
      this.webRtc.setMode(mode, iceServers);
    } catch (error) {
      if (generation !== this.modeGeneration) return;
      this.webRtc.setMode("ws");
      this.webRtcConnected = false;
      this.events.onWebRtcState(false, "UNKNOWN");
      if (mode !== "auto") this.events.onStatus("error", error instanceof Error ? error.message : "TURN credential failed");
    }
  }

  private async getIceServers(): Promise<RemoteIceServers> {
    if (this.cachedIceServers) return this.cachedIceServers;
    if (!this.roomId || !this.sessionTicket) throw new Error("Remote session is not ready");
    const response = await fetch(new URL(`v1/rooms/${encodeURIComponent(this.roomId)}/ice-servers`, this.withTrailingSlash(this.baseUrl)), {
      method: "POST",
      headers: { authorization: `Bearer ${this.sessionTicket}` },
    });
    if (!response.ok) throw new Error(`TURN credential failed (${response.status})`);
    const parsed = iceServersResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid TURN credential response");
    this.cachedIceServers = parsed.data.iceServers;
    return this.cachedIceServers;
  }

  private withTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : `${value}/`;
  }
}
