import type { EffectId } from "../types";
import { createVjUi, type VjUiElements } from "./createVjUi";

interface HudState {
  bpm: number;
  bar: number;
  beat: number;
  phase: number;
  quantize: string;
  liveCue: string;
  autoCues: string;
  mode: string;
  scale: number;
  anchorX: number;
  anchorY: number;
}

/** VJ画面のDOM生成と表示更新を一か所で管理する */
export class VjUiController {
  readonly elements: VjUiElements;

  private actionMessages: string[] = [];
  private bpmHistory: Array<{ time: number; bpm: number }> = [{ time: performance.now(), bpm: 128 }];
  private lastBpmSample = 0;
  private lastHudHtml = "";
  private flashFrame: number | null = null;
  private flashTimer: number | null = null;
  private readonly host: HTMLElement;

  /** ホストへVJ用DOMを生成する */
  constructor(host: HTMLElement) {
    this.host = host;
    this.elements = createVjUi(host);
  }

  /** 直近8件の操作ログを新しいほど濃く表示する */
  log(message: string): void {
    this.actionMessages.push(message);
    if (this.actionMessages.length > 8) this.actionMessages.shift();
    const actionLog = this.elements.actionLog;
    // 操作のたびにDOMを増減させず固定行を再利用する
    while (actionLog.children.length < 8) {
      const row = document.createElement("div");
      row.className = "action-log-entry";
      actionLog.appendChild(row);
    }
    const rows = actionLog.children;
    const empty = 8 - this.actionMessages.length;
    for (let index = 0; index < 8; index += 1) {
      const row = rows[index] as HTMLElement;
      const messageIndex = index - empty;
      if (messageIndex < 0) {
        row.textContent = "";
        row.style.opacity = "0";
        continue;
      }
      row.textContent = this.actionMessages[messageIndex];
      row.style.opacity = String(0.16 + 0.84 * ((messageIndex + 1) / this.actionMessages.length));
    }
  }

  /** 実キーまたは仮想キーの押下状態をガイドへ反映する */
  setKeyVisual(code: string, active: boolean): void {
    const visualCode = code === "ShiftRight" ? "ShiftLeft" : code;
    for (const element of this.elements.keyGuide.querySelectorAll<HTMLElement>(`[data-code="${visualCode}"]`)) {
      element.classList.toggle("active", active);
    }
  }

  /** クリック操作用のShift表示を更新する */
  setVirtualShift(active: boolean): void {
    for (const element of this.elements.keyGuide.querySelectorAll<HTMLElement>('[data-code="ShiftLeft"]')) {
      element.classList.toggle("virtual-shift", active);
    }
  }

  /** クオンタイズ待ちの前に入力受付を短い枠線アニメーションで示す */
  immediateFeedback(effect: EffectId): void {
    const beatPulse = this.elements.beatPulse;
    beatPulse.dataset.effect = effect;
    beatPulse.getAnimations().forEach((animation) => animation.cancel());
    beatPulse.animate(
      [
        { borderWidth: "5px", borderColor: "rgba(255,255,255,.9)" },
        { borderWidth: "1px", borderColor: "rgba(255,255,255,.12)" },
      ],
      { duration: 140, easing: "ease-out" },
    );
  }

  /** 画面を瞬時に明るくしてフェードアウトさせる */
  flash(amount = 0.55): void {
    const flashElement = this.elements.flashElement;
    if (this.flashFrame !== null) cancelAnimationFrame(this.flashFrame);
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    flashElement.style.transition = "none";
    flashElement.style.opacity = String(Math.min(0.9, amount));
    // 不透明状態を一度描画してから遷移を付けないとフェードが開始されない
    this.flashFrame = requestAnimationFrame(() => {
      this.flashFrame = null;
      flashElement.style.transition = "opacity 180ms ease-out";
      flashElement.style.opacity = "0";
      this.flashTimer = window.setTimeout(() => {
        this.flashTimer = null;
        flashElement.style.transition = "none";
      }, 200);
    });
  }

  /** ラッチ状態を対応するキューボタンへ反映する */
  setLatchState(cue: number, active: boolean): void {
    this.elements.cueButtons[cue]?.classList.toggle("latched", active);
  }

  /** TAPなど外部操作で変わったBPMをパネル入力欄へ反映する */
  setBpmInput(bpm: number): void {
    const input = this.elements.panel.querySelector<HTMLInputElement>("[data-field=bpm]");
    if (input) input.value = bpm.toFixed(2);
  }

  /** 録音とループ状態を操作ボタンへ反映する */
  setRecordState(recording: boolean, looping: boolean): void {
    const button = this.elements.panel.querySelector<HTMLButtonElement>("[data-action=record]");
    if (!button) return;
    button.classList.toggle("recording", recording);
    button.textContent = recording ? "● REC 2 BARS [R]" : looping ? "LOOP 2 BARS [R]" : "REC [R]";
  }

  /** 直近12秒のBPM履歴を100ms間隔でグラフへ反映する */
  updateBpmGraph(now: number, bpm: number): void {
    if (now - this.lastBpmSample < 100) return;
    this.lastBpmSample = now;
    this.bpmHistory.push({ time: now, bpm });
    while (this.bpmHistory.length > 1 && this.bpmHistory[0].time < now - 12000) this.bpmHistory.shift();
    const values = this.bpmHistory.map((point) => point.bpm);
    const low0 = Math.min(...values);
    const high0 = Math.max(...values);
    // BPMが一定でも線が端へ張り付かないよう最低2 BPMの上下余白を設ける
    const padding = Math.max(2, (high0 - low0) * 0.25);
    const low = Math.max(0, low0 - padding);
    const span = Math.max(1, high0 + padding - low);
    const path = this.bpmHistory.map((point, index) => {
      const x = Math.max(0, Math.min(260, 260 - ((now - point.time) / 12000) * 260));
      const y = 70 - ((point.bpm - low) / span) * 64;
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    this.elements.bpmGraphPath.setAttribute("d", path);
    this.elements.bpmGraphValue.textContent = bpm.toFixed(2);
  }

  /** ライブ状態をHUDへ反映する */
  updateHud(state: HudState): void {
    const html = `<b>${state.bpm.toFixed(2)} BPM</b><span>BAR ${state.bar} · BEAT ${state.beat}</span><span>Q ${state.quantize.toUpperCase()}</span><span>CUE ${state.liveCue}</span><span>AUTO ${state.autoCues}</span><span>${state.mode}</span><span>SIZE ${Math.round(state.scale * 100)}%</span><span>POS ${Math.round(state.anchorX * 100)},${Math.round(state.anchorY * 100)}</span>`;
    // 内容が同じ場合はレイアウト再計算を発生させない
    if (html !== this.lastHudHtml) {
      this.lastHudHtml = html;
      this.elements.hud.innerHTML = html;
    }
    this.elements.beatPulse.style.setProperty("--phase", String(state.phase));
  }

  /** フラッシュと拍フィードバックを初期状態へ戻す */
  clearFeedback(): void {
    if (this.flashFrame !== null) cancelAnimationFrame(this.flashFrame);
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.flashFrame = null;
    this.flashTimer = null;
    this.elements.flashElement.style.transition = "none";
    this.elements.flashElement.style.opacity = "0";
    this.elements.beatPulse.getAnimations().forEach((animation) => animation.cancel());
    this.elements.beatPulse.classList.remove("hit");
  }

  /** 生成したDOM要素をホストから取り除く */
  destroy(): void {
    this.clearFeedback();
    const bpmGraph = this.elements.bpmGraphPath.closest(".bpm-graph");
    const roots: Array<Element | null> = [
      this.elements.flashElement,
      this.elements.beatPulse,
      this.elements.hud,
      bpmGraph,
      this.elements.keyGuide,
      this.elements.actionLog,
      this.elements.panel,
      this.elements.assignOverlay,
    ];
    roots.forEach((element) => element?.remove());
    this.host.classList.remove("background-hidden");
  }
}
