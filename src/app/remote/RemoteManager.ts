import QRCode from "qrcode";
import type { RemoteHostElements } from "../ui/createVjUi";
import { RemoteInputAdapter } from "./RemoteInputAdapter";
import {
  createRoomResponseSchema,
  DEFAULT_REMOTE_PERMISSIONS,
  parseServerMessage,
  remoteSessionTimeoutMs,
  type HostClientMessage,
  type RemotePermissions,
  type ServerMessage,
} from "./RemoteProtocol";
import { estimatedOneWay } from "./RemoteStats";
import { WebSocketTransport, type RemoteTransport } from "./WebSocketTransport";

interface PendingRequest {
  resolve: (message: Extract<ServerMessage, { type: "hostAck" }>) => void;
  reject: (error: Error) => void;
  timer: number;
}

/** Host remote session、QR、権限、RTTを管理し操作はadapterへだけ渡す */
export class RemoteManager {
  private readonly ui: RemoteHostElements;
  private readonly adapter: RemoteInputAdapter;
  private readonly log: (message: string) => void;
  private readonly baseUrl = import.meta.env.VITE_REMOTE_BASE_URL?.trim() ?? "";
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
  private readonly readyWaiters = new Set<() => void>();
  private pingTimer: number | null = null;
  private expiryTimer: number | null = null;

  /** Host UIと既存AppAction adapterへremote sessionを接続する */
  constructor(
    ui: RemoteHostElements,
    adapter: RemoteInputAdapter,
    log: (message: string) => void,
    signal: AbortSignal,
  ) {
    this.ui = ui;
    this.adapter = adapter;
    this.log = log;
    this.adapter.setPermissions(this.permissions);
    this.ui.showQrButton.addEventListener("click", () => void this.showQr(), { signal });
    this.ui.closeQrButton.addEventListener("click", () => void this.closeQr(), { signal });
    for (const input of Object.values(this.ui.permissionInputs)) {
      input.addEventListener("change", () => void this.updatePermissionsFromUi(), { signal });
    }
    if (!this.baseUrl) {
      this.ui.status.textContent = "NOT CONFIGURED";
      this.ui.showQrButton.disabled = true;
      this.ui.showQrButton.title = "Set VITE_REMOTE_BASE_URL at build time";
    }
  }

  /** JOINを閉じてtransportとpending stateを破棄する */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ready && this.joinOpen) {
      this.transport?.sendReliable({ v: 1, type: "closeJoin", requestId: crypto.randomUUID() });
    }
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.adapter.resetSession();
    this.transport?.close();
    this.transport = null;
    for (const request of this.pendingRequests.values()) {
      window.clearTimeout(request.timer);
      request.reject(new Error("Remote manager destroyed"));
    }
    this.pendingRequests.clear();
  }

  /** OPEN JOIN ACK後だけQRを生成して表示する */
  private async showQr(): Promise<void> {
    if (this.destroyed || !this.baseUrl || this.joinVisible) return;
    this.ui.showQrButton.disabled = true;
    this.ui.status.textContent = "CONNECTING";
    try {
      await this.ensureSession();
      await this.waitUntilReady();
      const requestId = crypto.randomUUID();
      const ack = await this.request({ v: 1, type: "openJoin", requestId });
      if (!ack.ok || !ack.joinSecret || !this.session) throw new Error(ack.error ?? "OPEN JOIN failed");
      this.joinOpen = true;

      const controllerUrl = new URL(`${import.meta.env.BASE_URL}controller.html`, window.location.origin);
      const fragment = new URLSearchParams({ room: this.session.roomId, join: ack.joinSecret });
      controllerUrl.hash = fragment.toString();
      const qrDataUrl = await QRCode.toDataURL(controllerUrl.toString(), { width: 420, margin: 2, errorCorrectionLevel: "M" });
      if (this.destroyed) return;
      this.ui.qrImage.src = qrDataUrl;
      this.ui.qrRoom.textContent = `ROOM ${this.session.roomId}`;
      this.ui.qrStatus.textContent = "JOIN OPEN";
      this.ui.qrOverlay.hidden = false;
      this.joinVisible = true;
      this.ui.showQrButton.textContent = "QR SHOWN";
      this.ui.status.textContent = "JOIN OPEN";
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
      this.hideQrView();
      const message = error instanceof Error ? error.message : "Remote connection failed";
      this.ui.status.textContent = "ERROR";
      this.log(`REMOTE ERROR / ${message}`);
    } finally {
      this.ui.showQrButton.disabled = this.joinVisible || !this.baseUrl;
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
      this.hideQrView();
      this.ui.status.textContent = "CONNECTED";
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
    const response = await fetch(new URL("v1/rooms", this.withTrailingSlash(this.baseUrl)), {
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
    this.transport = new WebSocketTransport({
      baseUrl: this.baseUrl,
      roomId: this.session.roomId,
      sessionTicket,
      events: {
        onOpen: () => { this.ui.status.textContent = "AUTHENTICATING"; },
        onClose: (event) => this.handleClose(event),
        onMessage: (data) => this.handleMessage(data),
        onError: () => { if (!this.destroyed) this.ui.status.textContent = "RECONNECTING"; },
      },
    });
  }

  /** 切断時にholdとQRを安全側へ解放する */
  private handleClose(event: CloseEvent): void {
    if (this.destroyed || (!this.transport && !this.session)) return;
    const terminal = event.code === 4001 || event.code === 4003 || event.code === 4401 || event.code === 4403;
    if (terminal) {
      this.endSession(event.code === 4001 ? "HOST REPLACED" : "SESSION EXPIRED");
      return;
    }
    this.ready = false;
    this.joinOpen = false;
    this.adapter.releaseAllControllers();
    this.controllers.clear();
    this.rttByController.clear();
    this.pendingPings.clear();
    this.renderControllerState();
    this.rejectPending("Remote connection closed");
    this.ui.status.textContent = "RECONNECTING";
    if (this.joinVisible) {
      this.ui.qrStatus.textContent = "CONNECTION LOST — JOIN CLOSE UNCONFIRMED";
      this.ui.closeQrButton.disabled = true;
    }
  }

  /** 絶対期限でHost PartySocket再接続を停止する */
  private scheduleExpiry(expiresAt: number): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    const remaining = remoteSessionTimeoutMs(expiresAt);
    if (remaining <= 0) {
      this.endSession("SESSION EXPIRED");
      return;
    }
    this.expiryTimer = window.setTimeout(() => this.endSession("SESSION EXPIRED"), remaining);
  }

  /** terminal sessionを解放して新規Room作成へ戻す */
  private endSession(status: string): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ready = false;
    this.joinOpen = false;
    this.adapter.resetSession();
    this.controllers.clear();
    this.rttByController.clear();
    this.pendingPings.clear();
    this.renderControllerState();
    this.rejectPending("Remote session ended");
    this.hideQrView();
    const transport = this.transport;
    this.transport = null;
    this.session = null;
    transport?.close();
    this.ui.status.textContent = status;
    this.ui.showQrButton.disabled = !this.baseUrl;
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
        this.ui.status.textContent = "CONNECTED";
        this.ui.closeQrButton.disabled = false;
        for (const resolve of this.readyWaiters) resolve();
        this.readyWaiters.clear();
        this.startPings();
        this.transport?.sendReliable({ v: 1, type: "requestState", requestId: crypto.randomUUID() });
        return;
      case "hostAck": {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pendingRequests.delete(message.requestId);
        pending.resolve(message);
        return;
      }
      case "state":
        this.joinOpen = message.joinOpen;
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
      const timer = window.setTimeout(() => {
        this.pendingRequests.delete(message.requestId);
        reject(new Error("Remote ACK timeout"));
      }, 6_000);
      this.pendingRequests.set(message.requestId, { resolve, reject, timer });
      if (!this.transport?.sendReliable(message)) {
        window.clearTimeout(timer);
        this.pendingRequests.delete(message.requestId);
        reject(new Error("Remote socket is not open"));
      }
    });
  }

  /** 認証済みready messageまでQR操作を待機する */
  private waitUntilReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.readyWaiters.delete(onReady);
        reject(new Error("Remote connection timeout"));
      }, 8_000);
      const onReady = (): void => {
        window.clearTimeout(timer);
        resolve();
      };
      this.readyWaiters.add(onReady);
    });
  }

  /** controllerごとのRTT pingを1.5秒間隔で送る */
  private startPings(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = window.setInterval(() => {
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
      row.innerHTML = `<b>#${index + 1}</b><span>RTT ${rtt === undefined ? "—" : `${Math.round(rtt)} ms`}</span><span>One-way ${rtt === undefined ? "—" : estimatedOneWay(rtt)}</span>`;
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
    this.ui.showQrButton.disabled = !this.baseUrl;
  }

  /** 切断時に未完了ACK待機をまとめてrejectする */
  private rejectPending(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }

  /** API URLを安全にresolveできる末尾slash付きへ揃える */
  private withTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : `${value}/`;
  }
}
