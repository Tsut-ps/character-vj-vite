import type { RemotePermissions } from "../app/remote/RemoteProtocol";
import { DEFAULT_REMOTE_PERMISSIONS } from "../app/remote/RemoteProtocol";
import { ControllerConnection } from "./ControllerConnection";

type ControllerStatus = "joining" | "connecting" | "connected" | "disconnected" | "error";

/** 観客向けtouch UIとpointer lifecycleをRemoteCommandへ変換する */
export class ControllerApp {
  private readonly host: HTMLElement;
  private readonly connection: ControllerConnection;
  private readonly activePointers = new Map<number, number>();
  private permissions: RemotePermissions = { ...DEFAULT_REMOTE_PERMISSIONS };
  private status: ControllerStatus = "joining";

  /** Controller DOMを生成してQR fragmentからJOINを開始する */
  constructor(host: HTMLElement) {
    this.host = host;
    this.host.innerHTML = this.template();
    this.connection = new ControllerConnection({
      onStatus: (status, detail) => this.setStatus(status, detail),
      onPermissions: (permissions) => this.setPermissions(permissions),
      onLatency: (rttMs) => this.setLatency(rttMs),
    });
    this.bindControls();
  }

  /** roomとjoin secretが揃った場合だけJOIN requestを送る */
  async start(): Promise<void> {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const roomId = fragment.get("room");
    const joinSecret = fragment.get("join");
    if (!roomId || !joinSecret) {
      this.setStatus("error", "Invalid or incomplete QR URL");
      return;
    }
    window.history.replaceState(null, "", `${window.location.pathname}#room=${encodeURIComponent(roomId)}`);
    try {
      await this.connection.join(roomId, joinSecret);
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : "JOIN failed");
    }
  }

  /** reconnectとpointer stateを破棄する */
  destroy(): void {
    this.releaseLocalPointers();
    this.connection.destroy();
  }

  /** cueとtransport表示を含むcontroller markupを返す */
  private template(): string {
    const cueButtons = Array.from({ length: 9 }, (_, index) => {
      const cue = index + 1;
      return `<button class="cue cue-${cue}" data-cue="${cue}" aria-label="Cue ${cue}">${cue}</button>`;
    }).join("");
    return `
      <section class="controller-shell">
        <header><h1>Character VJ Remote</h1><div class="connection-line"><b data-status>● JOINING</b><span data-latency>— ms</span></div></header>
        <div class="cue-grid">${cueButtons}</div>
        <div class="utility-grid">
          <button data-command="tap">TAP</button>
          <button data-command="sync">SYNC</button>
          <button data-command="record">REC</button>
        </div>
        <button class="clear" data-command="clear">CLEAR</button>
        <div class="controller-path"><span>Transport</span><b>WebSocket</b><span>Path</span><b>WS RELAY</b></div>
        <p data-detail></p>
      </section>
    `;
  }

  /** pointer captureを使いdownと全release eventを対称に接続する */
  private bindControls(): void {
    this.host.addEventListener("contextmenu", (event) => event.preventDefault());
    for (const button of this.host.querySelectorAll<HTMLButtonElement>("[data-cue]")) {
      button.addEventListener("pointerdown", (event) => this.onCueDown(event, button));
      button.addEventListener("pointerup", (event) => this.onCueRelease(event));
      button.addEventListener("pointercancel", (event) => this.onCueRelease(event));
      button.addEventListener("lostpointercapture", (event) => this.onCueRelease(event));
    }
    for (const button of this.host.querySelectorAll<HTMLButtonElement>("[data-command]")) {
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        if (button.disabled) return;
        const type = button.dataset.command;
        if (type === "tap" || type === "sync" || type === "record" || type === "clear") {
          this.connection.sendCommand({ type });
        }
      });
    }
  }

  /** pointerdownをcue downへ変換して送信成功時だけactive表示にする */
  private onCueDown(event: PointerEvent, button: HTMLButtonElement): void {
    event.preventDefault();
    const cue = Number(button.dataset.cue);
    if (button.disabled || !Number.isInteger(cue) || cue < 1 || cue > 9) return;
    if (!this.connection.sendCommand({ type: "cue", cue: cue as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, state: "down" })) return;
    this.activePointers.set(event.pointerId, cue);
    button.classList.add("active");
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      this.onCueRelease(event);
    }
  }

  /** pointerup系eventを一度だけcue upへ変換する */
  private onCueRelease(event: PointerEvent): void {
    const cue = this.activePointers.get(event.pointerId);
    if (!cue) return;
    this.activePointers.delete(event.pointerId);
    const stillHeld = [...this.activePointers.values()].includes(cue);
    if (!stillHeld) {
      this.connection.sendCommand({ type: "cue", cue: cue as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, state: "up" });
      this.host.querySelector<HTMLButtonElement>(`[data-cue="${cue}"]`)?.classList.remove("active");
    }
  }

  /** connection切断時にstale hold表示をlocalだけで解除する */
  private releaseLocalPointers(): void {
    this.activePointers.clear();
    for (const button of this.host.querySelectorAll(".cue.active")) button.classList.remove("active");
  }

  /** 接続状態と補足errorをheaderへ反映する */
  private setStatus(status: ControllerStatus, detail?: string): void {
    this.status = status;
    const label = this.required<HTMLElement>("[data-status]");
    const text = status === "connected" ? "CONNECTED" : status.toUpperCase();
    label.textContent = `● ${text}`;
    label.dataset.state = status;
    this.required<HTMLElement>("[data-detail]").textContent = detail ?? "";
    if (status !== "connected") this.releaseLocalPointers();
    this.applyDisabledState();
  }

  /** server配布permissionsを各操作buttonのdisabledへ反映する */
  private setPermissions(permissions: RemotePermissions): void {
    if (this.permissions.cue && !permissions.cue) this.releaseLocalPointers();
    this.permissions = permissions;
    this.applyDisabledState();
  }

  /** Host performance.nowで測ったRTTをcontroller headerへ表示する */
  private setLatency(rttMs: number): void {
    this.required<HTMLElement>("[data-latency]").textContent = `${Math.round(rttMs)} ms`;
  }

  /** connectionとpermissionsの両方を満たす操作だけ有効化する */
  private applyDisabledState(): void {
    const connected = this.status === "connected";
    for (const button of this.host.querySelectorAll<HTMLButtonElement>("[data-cue]")) button.disabled = !connected || !this.permissions.cue;
    this.required<HTMLButtonElement>("[data-command=tap]").disabled = !connected || !this.permissions.tapSync;
    this.required<HTMLButtonElement>("[data-command=sync]").disabled = !connected || !this.permissions.tapSync;
    this.required<HTMLButtonElement>("[data-command=record]").disabled = !connected || !this.permissions.record;
    this.required<HTMLButtonElement>("[data-command=clear]").disabled = !connected || !this.permissions.clear;
  }

  /** 必須elementを取得してtemplate不整合を早期検出する */
  private required<T extends Element>(selector: string): T {
    const element = this.host.querySelector<T>(selector);
    if (!element) throw new Error(`Controller element not found: ${selector}`);
    return element;
  }
}
