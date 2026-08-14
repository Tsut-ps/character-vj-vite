import type { VjUiController } from "../VjUiController";
import type { VjUiActions } from "./VjUiActions";
import { isFormControlTarget } from "../../dom";

/** 実キーボードの表示調整とテンポ操作を接続する */
export class GlobalShortcutBindings {
  private readonly ui: VjUiController;
  private readonly actions: VjUiActions;
  private readonly signal: AbortSignal;
  private readonly handleEscape: () => void;

  /** グローバルなkeydownとkeyupを監視する */
  constructor(ui: VjUiController, actions: VjUiActions, signal: AbortSignal, handleEscape: () => void) {
    this.ui = ui;
    this.actions = actions;
    this.signal = signal;
    this.handleEscape = handleEscape;
    this.setup();
  }

  /** ウィンドウへキーボード操作を設定する */
  private setup(): void {
    window.addEventListener("keydown", (event) => {
      // フォーム固有のキー操作を位置やサイズ調整へ変換しない
      if (isFormControlTarget(event.target)) return;
      this.ui.setKeyVisual(event.code, true);
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) {
        event.preventDefault();
        this.actions.moveAnchor(
          event.code === "ArrowLeft" ? -0.025 : event.code === "ArrowRight" ? 0.025 : 0,
          event.code === "ArrowUp" ? -0.025 : event.code === "ArrowDown" ? 0.025 : 0,
          event.shiftKey,
        );
        return;
      }
      if (event.code === "NumpadAdd" || event.key === "+") {
        event.preventDefault();
        this.actions.adjustScale(0.1, event.shiftKey);
        return;
      }
      if (event.code === "NumpadSubtract" || event.code === "Minus") {
        event.preventDefault();
        this.actions.adjustScale(-0.1, event.shiftKey);
        return;
      }
      if (event.repeat) return;
      if (event.code === "Escape") {
        event.preventDefault();
        this.handleEscape();
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        if (event.shiftKey) this.actions.sync();
        else this.updateBpmInput(this.actions.tap());
        return;
      }
      if (event.code === "KeyR") {
        event.preventDefault();
        this.actions.toggleRecord();
      }
    }, { capture: true, signal: this.signal });
    window.addEventListener(
      "keyup",
      (event) => this.ui.setKeyVisual(event.code, false),
      { capture: true, signal: this.signal },
    );
  }

  /** BPM入力欄を確定した現在値へ更新する */
  private updateBpmInput(value: number): void {
    const input = this.ui.elements.panel.querySelector<HTMLInputElement>("[data-field=bpm]");
    if (input) input.value = value.toFixed(2);
  }
}
