import {
  commandAllowed,
  DEFAULT_REMOTE_PERMISSIONS,
  joinRoomResponseSchema,
  parseServerMessage,
  type RemoteCommand,
  type RemotePermissions,
} from "../app/remote/RemoteProtocol";
import { WebSocketTransport, type RemoteTransport } from "../app/remote/WebSocketTransport";

export interface ControllerConnectionEvents {
  onStatus(status: "joining" | "connecting" | "connected" | "disconnected" | "error", detail?: string): void;
  onPermissions(permissions: RemotePermissions): void;
  onLatency(rttMs: number): void;
}

/** JOINとPartySocket lifecycleを管理しrealtime commandをOPEN時だけ送る */
export class ControllerConnection {
  private readonly baseUrl = import.meta.env.VITE_REMOTE_BASE_URL?.trim() ?? "";
  private readonly events: ControllerConnectionEvents;
  private transport: RemoteTransport | null = null;
  private permissions: RemotePermissions = { ...DEFAULT_REMOTE_PERMISSIONS };
  private seq = 0;
  private destroyed = false;

  /** Controller UI event callbacksを接続する */
  constructor(events: ControllerConnectionEvents) {
    this.events = events;
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
    if (!response.ok) throw new Error(response.status === 403 ? "JOIN is closed or this QR has expired" : `JOIN failed (${response.status})`);
    const parsed = joinRoomResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.roomId !== roomId) throw new Error("Invalid JOIN response");
    this.permissions = parsed.data.permissions;
    this.events.onPermissions(this.permissions);
    this.connect(roomId, parsed.data.sessionTicket);
  }

  /** permission確認後にseq付きcommandをbufferなしで送る */
  sendCommand(command: RemoteCommand): boolean {
    if (!commandAllowed(command, this.permissions) || !this.transport?.isOpen) return false;
    const envelope = { v: 1 as const, seq: this.seq, command };
    this.seq += 1;
    return this.transport.sendRealtime(envelope);
  }

  /** reconnectを止めてconnection資源を解放する */
  destroy(): void {
    this.destroyed = true;
    this.transport?.close();
    this.transport = null;
  }

  /** 短期ticketをclient payloadやURLへ含めずWebSocket subprotocolへ設定する */
  private connect(roomId: string, sessionTicket: string): void {
    this.events.onStatus("connecting");
    this.transport = new WebSocketTransport({
      baseUrl: this.baseUrl,
      roomId,
      sessionTicket,
      events: {
        onOpen: () => this.events.onStatus("connecting"),
        onClose: (event) => {
          if (this.destroyed) return;
          if (event.code === 4003) {
            this.destroyed = true;
            this.transport?.close();
            this.events.onStatus("error", "Session expired after 1 hour");
          } else {
            this.events.onStatus("disconnected");
          }
        },
        onError: () => { if (!this.destroyed) this.events.onStatus("disconnected"); },
        onMessage: (data) => this.handleMessage(data),
      },
    });
  }

  /** server messageをZod検証してidentity非依存のUI stateだけへ反映する */
  private handleMessage(data: unknown): void {
    const message = parseServerMessage(data);
    if (!message) return;
    if (message.type === "ready" && message.role === "controller") {
      this.permissions = message.permissions;
      this.events.onPermissions(message.permissions);
      this.events.onStatus("connected");
    } else if (message.type === "permissions") {
      this.permissions = message.permissions;
      this.events.onPermissions(message.permissions);
    } else if (message.type === "ping") {
      this.transport?.sendRealtime({ v: 1, type: "pong", nonce: message.nonce });
    } else if (message.type === "latency") {
      this.events.onLatency(message.rttMs);
    } else if (message.type === "error") {
      this.events.onStatus("error", message.message);
    }
  }

  /** base URLへAPI pathを安全にresolveできる形へ揃える */
  private withTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : `${value}/`;
  }
}
