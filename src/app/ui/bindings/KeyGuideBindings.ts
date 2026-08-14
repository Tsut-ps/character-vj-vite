import type { VjUiController } from "../VjUiController";
import type { VjUiActions } from "./VjUiActions";

/** 画面内キーボードのクリックと長押し操作を接続する */
export class KeyGuideBindings {
  private virtualShift = false;
  private readonly ui: VjUiController;
  private readonly actions: VjUiActions;
  private readonly signal: AbortSignal;
  private readonly handleEscape: () => void;

  /** キーガイドへ仮想入力処理を設定する */
  constructor(ui: VjUiController, actions: VjUiActions, signal: AbortSignal, handleEscape: () => void) {
    this.ui = ui;
    this.actions = actions;
    this.signal = signal;
    this.handleEscape = handleEscape;
    this.setup();
  }

  /** クリック操作用のShiftトグル状態を更新する */
  private setVirtualShift(active: boolean): void {
    this.virtualShift = active;
    this.ui.setVirtualShift(active);
  }

  /** ガイド上のキー押下を実キーボードと同じ操作へ変換する */
  private handleKeyDown(code: string, sourceId: string): boolean {
    const cue = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (cue) {
      this.actions.handleAction({
        type: "cue",
        cue: Number(cue[1]) - 1,
        phase: "down",
        source: "ui",
        sourceId,
        strength: 1,
        latchToggle: this.virtualShift,
      });
      // ラッチ操作は押し続ける概念がないため通常キューだけ解放通知を要求する
      return !this.virtualShift;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(code)) {
      this.actions.moveAnchor(
        code === "ArrowLeft" ? -0.025 : code === "ArrowRight" ? 0.025 : 0,
        code === "ArrowUp" ? -0.025 : code === "ArrowDown" ? 0.025 : 0,
        this.virtualShift,
      );
      return false;
    }
    if (code === "Equal" || code === "NumpadAdd") {
      this.actions.adjustScale(0.1, this.virtualShift);
      return false;
    }
    if (code === "Minus" || code === "NumpadSubtract") {
      this.actions.adjustScale(-0.1, this.virtualShift);
      return false;
    }
    if (code === "Enter") {
      this.actions.handleAction({ type: "clear", source: "keyboard" });
      return false;
    }
    if (code === "Escape") {
      this.handleEscape();
      return false;
    }
    if (code === "Space") {
      if (this.virtualShift) this.actions.sync();
      else this.updateBpmInput(this.actions.tap());
      return false;
    }
    if (code === "KeyR") this.actions.toggleRecord();
    return false;
  }

  /** 各キー要素へポインター操作を設定する */
  private setup(): void {
    const keyGuide = this.ui.elements.keyGuide;
    for (const button of keyGuide.querySelectorAll<HTMLButtonElement>("button[data-code]")) {
      const code = button.dataset.code!;
      if (code === "ShiftLeft") {
        button.addEventListener("click", () => this.setVirtualShift(!this.virtualShift), { signal: this.signal });
        continue;
      }
      let held = false;
      const sourceId = `ui:${code}`;
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        button.setPointerCapture?.(event.pointerId);
        this.ui.setKeyVisual(code, true);
        held = this.handleKeyDown(code, sourceId);
      }, { signal: this.signal });
      /** 仮想キーの押下表示と長押し状態を解除する */
      const end = () => {
        this.ui.setKeyVisual(code, false);
        if (!held) return;
        this.actions.handleAction({
          type: "cue",
          cue: Number(/([1-9])$/.exec(code)?.[1] ?? 1) - 1,
          phase: "up",
          source: "ui",
          sourceId,
          strength: 1,
        });
        held = false;
      };
      button.addEventListener("pointerup", end, { signal: this.signal });
      button.addEventListener("pointercancel", end, { signal: this.signal });
    }
  }

  /** BPM入力欄を確定した現在値へ更新する */
  private updateBpmInput(value: number): void {
    const input = this.ui.elements.panel.querySelector<HTMLInputElement>("[data-field=bpm]");
    if (input) input.value = value.toFixed(2);
  }
}
