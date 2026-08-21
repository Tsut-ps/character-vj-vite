import {
  isTerminalControllerClose,
  joinRoomResponseSchema,
  parseServerMessage,
  remoteInitialConnectTimeoutMs,
  remoteSessionTimeoutMs,
  type RemoteConnectionMode,
  type RemoteCommand,
  type RemotePermissions,
} from "../app/remote/RemoteProtocol";
import { WebSocketTransport, type RemoteTransport } from "../app/remote/WebSocketTransport";
import { ControllerCommandSender } from "./ControllerCommandSender";
import { WebRtcController } from "./WebRtcController.ts";

export interface ControllerConnectionEvents {
  onStatus(status: "joining" | "connecting" | "connected" | "disconnected" | "error", detail?: string): void;
  onPermissions(permissions: RemotePermissions): void;
  onLatency(rttMs: number): void;
  onWebRtcState(connected: boolean): void;
}

/** JOINとPartySocket lifecycleを管理しrealtime commandをOPEN時だけ送る */
export class ControllerConnection {
  private readonly baseUrl = import.meta.env.VITE_REMOTE_BASE_URL?.trim() ?? "";
  private readonly events: ControllerConnectionEvents;
  private transport: RemoteTransport | null = null;
  private readonly commands: ControllerCommandSender;
  private readonly webRtc: WebRtcController;
  private connectionMode: RemoteConnectionMode = "ws";
  private controllerSessionId: string | null = null;
  private destroyed = false;
  private expiryTimer: number | null = null;
  private readyTimer: number | null = null;

  /** Controller UI event callbacksを接続する */
  constructor(events: ControllerConnectionEvents) {
    this.events = events;
    this.webRtc = new WebRtcController({
      sendSignal: (message) => this.transport?.sendReliable(message) ?? false,
      onState: (connected) => this.events.onWebRtcState(connected),
    });
    this.commands = new ControllerCommandSender((envelope) => (
      this.connectionMode === "ws"
        ? this.transport?.sendRealtime(envelope) ?? false
        : this.webRtc.send(envelope)
    ));
  }

  /** QR fragmentのsecretをPOSTして短期session ticketでWebSocketへ接続する */
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
    this.controllerSessionId = parsed.data.controllerSessionId;
    this.events.onPermissions(parsed.data.permissions);
    this.connect(roomId, parsed.data.sessionTicket);
    this.scheduleExpiry(parsed.data.expiresAt);
    this.scheduleReadyDeadline(parsed.data.connectBy);
  }

  /** permission確認後にseq付きcommandをbufferなしで送る */
  sendCommand(command: RemoteCommand): boolean {
    return this.commands.send(command);
  }

  /** Controllerが明示選択した送信transportへ切り替える */
  setConnectionMode(mode: RemoteConnectionMode): void {
    this.connectionMode = mode;
  }

  /** reconnectを止めてconnection資源を解放する */
  destroy(): void {
    this.destroyed = true;
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.readyTimer !== null) window.clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.transport?.close();
    this.transport = null;
    this.webRtc.close();
  }

  /** 短期ticketをclient payloadやURLへ含めずWebSocket subprotocolへ設定する */
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

  /** 絶対期限でPartySocket再接続を停止する */
  private scheduleExpiry(expiresAt: number): void {
    const remaining = remoteSessionTimeoutMs(expiresAt);
    if (remaining <= 0) {
      this.endSession("Remote session expired");
      return;
    }
    this.expiryTimer = window.setTimeout(() => this.endSession("Remote session expired"), remaining);
  }

  /** 初回readyがticket期限までに届かなければ再接続を止める */
  private scheduleReadyDeadline(connectBy: number): void {
    const remaining = remoteInitialConnectTimeoutMs(connectBy);
    if (remaining <= 0) {
      this.endSession("Remote connection ticket expired");
      return;
    }
    this.readyTimer = window.setTimeout(() => this.endSession("Remote connection ticket expired"), remaining);
  }

  /** terminal状態へ移行して以後の自動再接続を止める */
  private endSession(detail: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.readyTimer !== null) window.clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.transport?.close();
    this.transport = null;
    this.webRtc.close();
    this.events.onStatus("error", detail);
  }

  /** controller再JOINを行わず切断状態で自動再接続を停止する */
  private disconnectSession(detail: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.readyTimer !== null) window.clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const transport = this.transport;
    this.transport = null;
    this.webRtc.close();
    transport?.close();
    this.events.onStatus("disconnected", detail);
  }

  /** server messageをZod検証してidentity非依存のUI stateだけへ反映する */
  private handleMessage(data: unknown): void {
    const message = parseServerMessage(data);
    if (!message) return;
    if (message.type === "ready" && message.role === "controller") {
      if (this.readyTimer !== null) window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.commands.setPermissions(message.permissions);
      this.events.onPermissions(message.permissions);
      this.events.onStatus("connected");
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

  /** base URLへAPI pathを安全にresolveできる形へ揃える */
  private withTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : `${value}/`;
  }
}
