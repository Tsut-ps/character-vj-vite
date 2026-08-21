import QRCode from "qrcode";
import type { RemoteHostElements } from "../ui/createVjUi";
import { RemoteInputAdapter } from "./RemoteInputAdapter.ts";
import {
  createRoomResponseSchema,
  DEFAULT_REMOTE_PERMISSIONS,
  hostTicketResponseSchema,
  parseServerMessage,
  remoteSessionTimeoutMs,
  type HostClientMessage,
  type RemotePermissions,
  type ServerMessage,
} from "./RemoteProtocol.ts";
import {
  WebSocketTransport,
  type RemoteTransport,
  type RemoteTransportFactory,
  type WebSocketTransportOptions,
} from "./WebSocketTransport.ts";

interface PendingRequest {
  resolve: (message: Extract<ServerMessage, { type: "hostAck" }>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RemoteManagerDependencies {
  baseUrl?: string;
  fetch?: typeof fetch;
  transportFactory?: RemoteTransportFactory;
  createQr?: (value: string) => Promise<string>;
  controllerUrl?: () => URL;
}

/** Host remote session、QR、権限、RTTを管理し操作はadapterへだけ渡す */
export class RemoteManager {
  private readonly ui: RemoteHostElements;
  private readonly adapter: RemoteInputAdapter;
  private readonly log: (message: string) => void;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transportFactory: RemoteTransportFactory;
  private readonly createQr: (value: string) => Promise<string>;
  private readonly controllerUrl: () => URL;
  private permissions: RemotePermissions = { ...DEFAULT_REMOTE_PERMISSIONS };
  private session: { roomId: string; hostToken: string; expiresAt: number } | null = null;
  private transport: RemoteTransport | null = null;
  private ready = false;
  private joinOpen = false;
  private joinVisible = false;
  private destroyed = false;
  private readonly controllers = new Set<string>();
  private readonly rttByController = new Map<string, number>();
  private readonly pendingPings = new Map<string, { controllerSessionId: string; sentAt: number }>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;

  /** Host UIと既存AppAction adapterへremote sessionを接続する */
  constructor(
    ui: RemoteHostElements,
    adapter: RemoteInputAdapter,
    log: (message: string) => void,
    signal: AbortSignal,
    dependencies: RemoteManagerDependencies = {},
  ) {
    this.ui = ui;
    this.adapter = adapter;
    this.log = log;
    this.baseUrl = dependencies.baseUrl ?? import.meta.env.VITE_REMOTE_BASE_URL?.trim() ?? "";
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.transportFactory = dependencies.transportFactory ?? ((options: WebSocketTransportOptions) => new WebSocketTransport(options));
    this.createQr = dependencies.createQr ?? ((value) => QRCode.toDataURL(value, { width: 420, margin: 2, errorCorrectionLevel: "M" }));
    this.controllerUrl = dependencies.controllerUrl ?? (() => new URL(`${import.meta.env.BASE_URL}controller.html`, window.location.origin));
    this.adapter.setPermissions(this.permissions);
    this.ui.startButton.addEventListener("click", () => void this.startRemote(), { signal });
    this.ui.showQrButton.addEventListener("click", () => void this.showQr(), { signal });
    this.ui.closeQrButton.addEventListener("click", () => void this.closeQr(), { signal });
    for (const input of Object.values(this.ui.permissionInputs)) {
      input.addEventListener("change", () => void this.updatePermissionsFromUi(), { signal });
    }
    if (!this.baseUrl) {
      this.ui.status.textContent = "NOT CONFIGURED";
      this.ui.startButton.disabled = true;
      this.ui.showQrButton.disabled = true;
      this.ui.startButton.title = "Set VITE_REMOTE_BASE_URL at build time";
    } else {
      this.ui.showQrButton.disabled = true;
    }
  }

  /** JOINを閉じてtransportとpending stateを破棄する */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ready && this.joinOpen) {
      this.transport?.sendReliable({ v: 1, type: "closeJoin", requestId: crypto.randomUUID() });
    }
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.adapter.resetSession();
    const transport = this.transport;
    this.transport = null;
    transport?.close();
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Remote manager destroyed"));
    }
    this.pendingRequests.clear();
    this.rejectReadyWaiters("Remote manager destroyed");
  }

  /** roomを作成して認証済みHost WebSocketがreadyになるまで待つ */
  private async startRemote(): Promise<void> {
    if (this.destroyed || !this.baseUrl || this.session || this.transport) return;
    this.ui.startButton.disabled = true;
    this.ui.status.textContent = "STARTING";
    try {
      await this.ensureSession();
      await this.waitUntilReady();
      this.ui.status.textContent = "ONLINE";
      this.ui.showQrButton.disabled = false;
      this.log("REMOTE ONLINE");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Remote start failed";
      this.endSession("ERROR");
      this.log(`REMOTE ERROR / ${message}`);
    } finally {
      this.ui.startButton.disabled = Boolean(this.session) || !this.baseUrl;
    }
  }

  /** OPEN JOIN ACK後だけQRを生成して表示する */
  private async showQr(): Promise<void> {
    if (this.destroyed || !this.ready || !this.session || this.joinVisible) return;
    this.ui.showQrButton.disabled = true;
    try {
      const requestId = crypto.randomUUID();
      const ack = await this.request({ v: 1, type: "openJoin", requestId });
      if (!ack.ok || !ack.joinSecret || !this.session) throw new Error(ack.error ?? "OPEN JOIN failed");
      this.joinOpen = true;
      this.ui.join.textContent = "OPEN";

      const controllerUrl = this.controllerUrl();
      const fragment = new URLSearchParams({ room: this.session.roomId, join: ack.joinSecret });
      controllerUrl.hash = fragment.toString();
      const qrDataUrl = await this.createQr(controllerUrl.toString());
      if (this.destroyed) return;
      this.ui.qrImage.src = qrDataUrl;
      this.ui.qrRoom.textContent = `ROOM ${this.session.roomId}`;
      this.ui.qrStatus.textContent = "JOIN OPEN";
      this.ui.qrOverlay.hidden = false;
      this.joinVisible = true;
      this.ui.showQrButton.textContent = "QR SHOWN";
      this.log("REMOTE JOIN OPEN");
    } catch (error) {
      if (this.joinOpen && this.ready) {
        try {
          await this.request({ v: 1, type: "closeJoin", requestId: crypto.randomUUID() });
        } catch {
          // Host切断時もserver側でjoinを閉じるためlocal cleanupを継続する
        }
      }
      this.joinOpen = false;
      this.ui.join.textContent = "CLOSED";
      this.hideQrView();
      const message = error instanceof Error ? error.message : "Remote connection failed";
      this.log(`REMOTE ERROR / ${message}`);
    } finally {
      this.ui.showQrButton.disabled = this.joinVisible || !this.ready;
    }
  }

  /** CLOSE JOIN ACK後だけQRを非表示にする */
  private async closeQr(): Promise<void> {
    if (!this.joinVisible || !this.ready) return;
    this.ui.closeQrButton.disabled = true;
    this.ui.qrStatus.textContent = "CLOSING JOIN…";
    try {
      const ack = await this.request({ v: 1, type: "closeJoin", requestId: crypto.randomUUID() });
      if (!ack.ok) throw new Error(ack.error ?? "CLOSE JOIN failed");
      this.joinOpen = false;
      this.ui.join.textContent = "CLOSED";
      this.hideQrView();
      this.ui.status.textContent = "ONLINE";
      this.log("REMOTE JOIN CLOSED");
    } catch (error) {
      this.ui.qrStatus.textContent = error instanceof Error ? error.message : "CLOSE FAILED";
    } finally {
      this.ui.closeQrButton.disabled = false;
    }
  }

  /** 未作成時だけroomとHost sessionを作成する */
  private async ensureSession(): Promise<void> {
    if (this.transport) return;
    const response = await this.fetchImpl(new URL("v1/rooms", this.withTrailingSlash(this.baseUrl)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`Room create failed (${response.status})`);
    const parsed = createRoomResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid room create response");
    this.session = { roomId: parsed.data.roomId, hostToken: parsed.data.hostToken, expiresAt: parsed.data.expiresAt };
    this.connect(parsed.data.sessionTicket);
    this.scheduleExpiry(parsed.data.expiresAt);
  }

  /** 短期Host ticketでbufferなしtransportへ接続する */
  private connect(sessionTicket: string): void {
    if (!this.session) throw new Error("Missing room id");
    let transport: RemoteTransport;
    transport = this.transportFactory({
      baseUrl: this.baseUrl,
      roomId: this.session.roomId,
      sessionTicket,
      autoReconnect: false,
      events: {
        onOpen: () => {
          if (this.transport === transport) this.ui.status.textContent = "AUTHENTICATING";
        },
        onClose: (event) => {
          if (this.transport === transport) this.handleClose(event);
        },
        onMessage: (data) => {
          if (this.transport === transport) this.handleMessage(data);
        },
        onError: () => {
          if (!this.destroyed && this.transport === transport) this.ui.status.textContent = "RECONNECTING";
        },
      },
    });
    this.transport = transport;
  }

  /** 切断時にholdとQRを安全側へ解放する */
  private handleClose(event: CloseEvent): void {
    if (this.destroyed || !this.transport || !this.session) return;
    const terminal = event.code === 4001 || event.code === 4003 || event.code === 4401 || event.code === 4403;
    if (terminal) {
      this.endSession(event.code === 4001 ? "HOST REPLACED" : "SESSION EXPIRED");
      return;
    }
    this.transport = null;
    this.ready = false;
    this.joinOpen = false;
    this.ui.join.textContent = "CLOSED";
    this.adapter.releaseAllControllers();
    this.controllers.clear();
    this.rttByController.clear();
    this.pendingPings.clear();
    this.renderControllerState();
    this.rejectPending("Remote connection closed");
    this.hideQrView();
    this.ui.status.textContent = "RECONNECTING";
    this.ui.showQrButton.disabled = true;
    void this.reconnectHost();
  }

  /** memory上のHost tokenを新しいticketへ交換して一度だけ再接続する */
  private async reconnectHost(): Promise<void> {
    if (this.reconnecting || this.destroyed || !this.session) return;
    this.reconnecting = true;
    const session = this.session;
    try {
      const response = await this.fetchImpl(
        new URL(`v1/rooms/${encodeURIComponent(session.roomId)}/host-ticket`, this.withTrailingSlash(this.baseUrl)),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hostToken: session.hostToken }),
        },
      );
      if (!response.ok) throw new Error(`Host reconnect failed (${response.status})`);
      const parsed = hostTicketResponseSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.roomId !== session.roomId || this.session !== session) {
        throw new Error("Invalid host ticket response");
      }
      this.connect(parsed.data.sessionTicket);
    } catch (error) {
      if (this.session === session) {
        this.log(error instanceof Error ? `REMOTE ERROR / ${error.message}` : "REMOTE RECONNECT ERROR");
        this.endSession("DISCONNECTED");
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /** 絶対期限でHost PartySocket再接続を停止する */
  private scheduleExpiry(expiresAt: number): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    const remaining = remoteSessionTimeoutMs(expiresAt);
    if (remaining <= 0) {
      this.endSession("SESSION EXPIRED");
      return;
    }
    this.expiryTimer = setTimeout(() => this.endSession("SESSION EXPIRED"), remaining);
  }

  /** terminal sessionを解放して新規Room作成へ戻す */
  private endSession(status: string): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ready = false;
    this.joinOpen = false;
    this.ui.join.textContent = "CLOSED";
    this.adapter.resetSession();
    this.controllers.clear();
    this.rttByController.clear();
    this.pendingPings.clear();
    this.renderControllerState();
    this.rejectPending("Remote session ended");
    this.rejectReadyWaiters("Remote session ended");
    this.hideQrView();
    const transport = this.transport;
    this.transport = null;
    this.session = null;
    transport?.close();
    this.ui.status.textContent = status;
    this.ui.startButton.disabled = !this.baseUrl;
    this.ui.showQrButton.disabled = true;
  }

  /** Zod検証済みserver messageをHost stateかadapterへ振り分ける */
  private handleMessage(data: unknown): void {
    const message = parseServerMessage(data);
    if (!message) return;
    switch (message.type) {
      case "ready":
        if (message.role !== "host") return;
        this.ready = true;
        this.permissions = message.permissions;
        this.adapter.setPermissions(message.permissions);
        this.syncPermissionInputs();
        this.ui.status.textContent = "ONLINE";
        this.ui.startButton.disabled = true;
        this.ui.showQrButton.disabled = false;
        this.ui.closeQrButton.disabled = false;
        for (const waiter of this.readyWaiters) {
          if (waiter.timer !== null) clearTimeout(waiter.timer);
          waiter.resolve();
        }
        this.readyWaiters.clear();
        this.startPings();
        this.transport?.sendReliable({ v: 1, type: "requestState", requestId: crypto.randomUUID() });
        return;
      case "hostAck": {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.requestId);
        pending.resolve(message);
        return;
      }
      case "state":
        this.joinOpen = message.joinOpen;
        this.ui.join.textContent = message.joinOpen ? "OPEN" : "CLOSED";
        this.permissions = message.permissions;
        this.adapter.setPermissions(message.permissions);
        this.syncPermissionInputs();
        this.controllers.clear();
        message.controllers.forEach((controller) => this.controllers.add(controller.controllerSessionId));
        if (!message.joinOpen) this.hideQrView();
        this.renderControllerState();
        return;
      case "controllerConnected":
        this.controllers.add(message.controllerSessionId);
        this.renderControllerState();
        return;
      case "controllerDisconnected":
        this.controllers.delete(message.controllerSessionId);
        this.rttByController.delete(message.controllerSessionId);
        this.adapter.releaseController(message.controllerSessionId);
        this.renderControllerState();
        return;
      case "remote":
        this.adapter.handle(message.controllerSessionId, message.envelope);
        return;
      case "pong":
        this.handlePong(message.controllerSessionId, message.nonce);
        return;
      case "error":
        this.log(`REMOTE ${message.code} / ${message.message}`);
        return;
      default:
        return;
    }
  }

  /** checkbox stateをserver ACK付きpermissions更新へ変換する */
  private async updatePermissionsFromUi(): Promise<void> {
    const next: RemotePermissions = {
      cue: this.ui.permissionInputs.cue.checked,
      tapSync: this.ui.permissionInputs.tapSync.checked,
      record: this.ui.permissionInputs.record.checked,
      clear: this.ui.permissionInputs.clear.checked,
    };
    if (!this.ready) {
      this.permissions = next;
      this.adapter.setPermissions(next);
      return;
    }
    const previous = this.permissions;
    this.permissions = next;
    this.adapter.setPermissions(next);
    try {
      const ack = await this.request({
        v: 1,
        type: "setPermissions",
        requestId: crypto.randomUUID(),
        permissions: next,
      });
      if (!ack.ok) throw new Error(ack.error ?? "Permission update failed");
      this.log("REMOTE PERMISSIONS UPDATED");
    } catch (error) {
      this.permissions = previous;
      this.adapter.setPermissions(previous);
      this.syncPermissionInputs();
      this.log(error instanceof Error ? `REMOTE ERROR / ${error.message}` : "REMOTE PERMISSION ERROR");
    }
  }

  /** requestIdに対応するHost ACKをtimeout付きで待つ */
  private request(message: HostClientMessage): Promise<Extract<ServerMessage, { type: "hostAck" }>> {
    if (!("requestId" in message)) return Promise.reject(new Error("Message has no request id"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(message.requestId);
        reject(new Error("Remote ACK timeout"));
      }, 6_000);
      this.pendingRequests.set(message.requestId, { resolve, reject, timer });
      if (!this.transport?.sendReliable(message)) {
        clearTimeout(timer);
        this.pendingRequests.delete(message.requestId);
        reject(new Error("Remote socket is not open"));
      }
    });
  }

  /** 認証済みready messageまでQR操作を待機する */
  private waitUntilReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: ReadyWaiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(new Error("Remote connection timeout"));
      }, 8_000);
      this.readyWaiters.add(waiter);
    });
  }

  /** controllerごとのRTT pingを1.5秒間隔で送る */
  private startPings(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = setInterval(() => {
      if (!this.ready) return;
      for (const controllerSessionId of this.controllers) {
        const nonce = crypto.randomUUID();
        const sent = this.transport?.sendRealtime({ v: 1, type: "ping", controllerSessionId, nonce });
        if (sent) this.pendingPings.set(nonce, { controllerSessionId, sentAt: performance.now() });
      }
      const cutoff = performance.now() - 10_000;
      for (const [nonce, ping] of this.pendingPings) if (ping.sentAt < cutoff) this.pendingPings.delete(nonce);
    }, 1_500);
  }

  /** Host performance.nowだけでRTTを算出して両UIへ反映する */
  private handlePong(controllerSessionId: string, nonce: string): void {
    const ping = this.pendingPings.get(nonce);
    if (!ping || ping.controllerSessionId !== controllerSessionId) return;
    this.pendingPings.delete(nonce);
    const rttMs = Math.max(0, performance.now() - ping.sentAt);
    this.rttByController.set(controllerSessionId, rttMs);
    this.transport?.sendRealtime({ v: 1, type: "latency", controllerSessionId, rttMs });
    this.renderControllerState();
  }

  /** controller数と個別RTT/one-way推定を描画する */
  private renderControllerState(): void {
    this.ui.count.textContent = String(this.controllers.size);
    if (this.controllers.size === 0) {
      this.ui.stats.innerHTML = "<span>NO CONTROLLERS</span>";
      return;
    }
    this.ui.stats.replaceChildren(...[...this.controllers].map((id, index) => {
      const row = document.createElement("div");
      const rtt = this.rttByController.get(id);
      row.innerHTML = `<b>#${index + 1}</b><span>RTT ${rtt === undefined ? "—" : `${Math.round(rtt)} ms`}</span><span>One-way ${rtt === undefined ? "—" : `~${Math.round(rtt / 2)} ms`}</span>`;
      return row;
    }));
  }

  /** server確定permissionsをcheckboxへ同期する */
  private syncPermissionInputs(): void {
    this.ui.permissionInputs.cue.checked = this.permissions.cue;
    this.ui.permissionInputs.tapSync.checked = this.permissions.tapSync;
    this.ui.permissionInputs.record.checked = this.permissions.record;
    this.ui.permissionInputs.clear.checked = this.permissions.clear;
  }

  /** QR画像と表示stateをlocal UIから破棄する */
  private hideQrView(): void {
    this.joinVisible = false;
    this.ui.qrOverlay.hidden = true;
    this.ui.qrImage.removeAttribute("src");
    this.ui.showQrButton.textContent = "SHOW QR";
    this.ui.showQrButton.disabled = !this.ready;
  }

  /** 切断時に未完了ACK待機をまとめてrejectする */
  private rejectPending(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }

  /** session終了時にready待機をtimeoutまで残さず失敗させる */
  private rejectReadyWaiters(message: string): void {
    for (const waiter of this.readyWaiters) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    this.readyWaiters.clear();
  }

  /** API URLを安全にresolveできる末尾slash付きへ揃える */
  private withTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : `${value}/`;
  }
}
