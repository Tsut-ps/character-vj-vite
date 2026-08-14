import type { AppAction } from "../types";
import type { VjUiController } from "./VjUiController";

export interface VjUiActions {
  handleAction(action: AppAction): void;
  triggerCue(cue: number, latchToggle: boolean): void;
  adjustScale(delta: number, individual: boolean): void;
  moveAnchor(dx: number, dy: number, individual: boolean): void;
  selectSlot(index: number, shouldLog?: boolean): void;
  setBpm(value: number): number;
  tap(): number;
  sync(): void;
  cycleQuantize(): string;
  setOffset(value: number): void;
  setFpsLimit(enabled: boolean): void;
  setBackgroundHidden(hidden: boolean): void;
  setSkipAssign(enabled: boolean): void;
  setVolume(value: number): number;
  toggleRecord(): void;
  enableMidi(): Promise<string[]>;
  cancelDropOverlay(): boolean;
  isAssignmentOpen(): boolean;
  closeAssignment(): void;
  log(message: string): void;
}

/** UI操作をアプリ向けの意味あるアクションへ変換する */
export class VjUiBindings {
  private virtualShift = false;
  private readonly host: HTMLElement;
  private readonly ui: VjUiController;
  private readonly actions: VjUiActions;
  private readonly signal: AbortSignal;

  /** UI要素へパネルとキーボード操作を接続する */
  constructor(host: HTMLElement, ui: VjUiController, actions: VjUiActions, signal: AbortSignal) {
    this.host = host;
    this.ui = ui;
    this.actions = actions;
    this.signal = signal;
    this.setupKeyGuide();
    this.setupPanel();
    this.setupWindowKeyboard();
    this.makePanelDraggable();
    this.actions.selectSlot(0, false);
  }

  /** 実キーまたは仮想キーの押下状態をガイドへ反映する */
  private setKeyVisual(code: string, active: boolean): void {
    this.ui.setKeyVisual(code, active);
  }

  /** クリック操作用のShiftトグル状態を更新する */
  private setVirtualShift(active: boolean): void {
    this.virtualShift = active;
    this.ui.setVirtualShift(active);
  }

  /** ガイド上のキー押下を実キーボードと同じ操作へ変換する */
  private virtualKeyDown(code: string, sourceId: string): boolean {
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

  /** 画面内キーボードへクリックと長押し操作を設定する */
  private setupKeyGuide(): void {
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
        this.setKeyVisual(code, true);
        held = this.virtualKeyDown(code, sourceId);
      }, { signal: this.signal });
      /** 仮想キーの押下表示と長押し状態を解除する */
      const end = () => {
        this.setKeyVisual(code, false);
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

  /** 操作パネル内の入力を各アプリ操作へ接続する */
  private setupPanel(): void {
    const { panel, slotElements, cueButtons } = this.ui.elements;
    slotElements.forEach((slot, index) => {
      slot.addEventListener("click", () => this.actions.selectSlot(index), { signal: this.signal });
    });
    cueButtons.forEach((button, index) => {
      button.addEventListener("click", (event) => this.actions.triggerCue(index, event.shiftKey), { signal: this.signal });
    });

    const bpm = panel.querySelector<HTMLInputElement>("[data-field=bpm]")!;
    bpm.addEventListener("change", () => {
      bpm.value = this.actions.setBpm(Number(bpm.value)).toFixed(2);
    }, { signal: this.signal });
    const quantize = panel.querySelector<HTMLButtonElement>("[data-action=quantize]")!;
    // 選択肢が少ないためプルダウンではなくクリックで順番に切り替える
    quantize.addEventListener("click", () => {
      quantize.textContent = `Q ${this.actions.cycleQuantize()}`;
    }, { signal: this.signal });
    const offset = panel.querySelector<HTMLInputElement>("[data-field=offset]")!;
    offset.addEventListener("change", () => this.actions.setOffset(Number(offset.value)), { signal: this.signal });

    const fpsLimit = panel.querySelector<HTMLInputElement>("[data-field=limit-fps]")!;
    fpsLimit.addEventListener("change", () => this.actions.setFpsLimit(fpsLimit.checked), { signal: this.signal });
    const hideBackground = panel.querySelector<HTMLInputElement>("[data-field=hide-background]")!;
    hideBackground.addEventListener("change", () => {
      this.actions.setBackgroundHidden(hideBackground.checked);
      this.host.classList.toggle("background-hidden", hideBackground.checked);
    }, { signal: this.signal });
    const skipAssign = panel.querySelector<HTMLInputElement>("[data-field=skip-assign]")!;
    skipAssign.addEventListener("change", () => this.actions.setSkipAssign(skipAssign.checked), { signal: this.signal });

    const masterVolume = panel.querySelector<HTMLInputElement>("[data-field=master-volume]")!;
    const masterVolumeValue = panel.querySelector<HTMLElement>("[data-field=master-volume-value]")!;
    masterVolume.addEventListener("input", () => {
      const volume = this.actions.setVolume(Number(masterVolume.value) / 100);
      masterVolumeValue.textContent = `${Math.round(volume * 100)}%`;
    }, { signal: this.signal });
    masterVolume.addEventListener("change", () => {
      this.actions.log(`SFX VOLUME ${Math.round(Number(masterVolume.value))}%`);
    }, { signal: this.signal });

    panel.querySelector("[data-action=tap]")!.addEventListener("click", () => {
      this.updateBpmInput(this.actions.tap());
    }, { signal: this.signal });
    panel.querySelector("[data-action=sync]")!.addEventListener("click", () => this.actions.sync(), { signal: this.signal });
    panel.querySelector("[data-action=hide]")!.addEventListener("click", () => {
      panel.classList.add("hidden");
      this.actions.log("MENU HIDE");
    }, { signal: this.signal });
    panel.querySelector("[data-action=record]")!.addEventListener("click", () => this.actions.toggleRecord(), { signal: this.signal });
    panel.querySelector("[data-action=fullscreen]")!.addEventListener("click", () => {
      this.actions.log("FULLSCREEN");
      void document.documentElement.requestFullscreen?.();
    }, { signal: this.signal });
    panel.querySelector("[data-action=midi]")!.addEventListener("click", (event) => {
      void this.enableMidi(event.currentTarget as HTMLButtonElement);
    }, { signal: this.signal });
  }

  /** InputRouter対象外の表示調整とテンポ操作を実キーボードへ接続する */
  private setupWindowKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      this.setKeyVisual(event.code, true);
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
      (event) => this.setKeyVisual(event.code, false),
      { capture: true, signal: this.signal },
    );
  }

  /** Esc操作をドロップ案内と割り当て画面とパネルへ順番に適用する */
  private handleEscape(): void {
    if (this.actions.cancelDropOverlay()) return;
    if (this.actions.isAssignmentOpen()) {
      this.actions.closeAssignment();
      return;
    }
    const panel = this.ui.elements.panel;
    panel.classList.toggle("hidden");
    this.actions.log(panel.classList.contains("hidden") ? "MENU HIDE" : "MENU SHOW");
  }

  /** MIDI入力を有効化して結果をボタンへ表示する */
  private async enableMidi(button: HTMLButtonElement): Promise<void> {
    try {
      const names = await this.actions.enableMidi();
      button.textContent = names.length ? `MIDI: ${names.length} INPUT` : "MIDI: READY";
      this.actions.log(`MIDI READY ${names.length}`);
    } catch (error) {
      button.textContent = error instanceof Error ? error.message : "MIDI ERROR";
      this.actions.log("MIDI ERROR");
    }
  }

  /** BPM入力欄を確定した現在値へ更新する */
  private updateBpmInput(value: number): void {
    const input = this.ui.elements.panel.querySelector<HTMLInputElement>("[data-field=bpm]");
    if (input) input.value = value.toFixed(2);
  }

  /** パネル見出しをドラッグして画面内で移動できるようにする */
  private makePanelDraggable(): void {
    const panel = this.ui.elements.panel;
    const head = panel.querySelector<HTMLElement>(".panel-head");
    if (!head) return;
    let drag: { pointerId: number; dx: number; dy: number; moved: boolean } | null = null;
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button, input, select")) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      panel.classList.add("moving");
      drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
      head.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }, { signal: this.signal });
    head.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      // パネルが画面外へ消えて再操作不能にならないよう座標を制限する
      const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
      const left = Math.max(0, Math.min(maxX, event.clientX - drag.dx));
      const top = Math.max(0, Math.min(maxY, event.clientY - drag.dy));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      drag.moved = true;
    }, { signal: this.signal });
    /** パネル移動のポインター追跡を終了する */
    const finish = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      panel.classList.remove("moving");
      if (moved) this.actions.log("MENU MOVED");
    };
    head.addEventListener("pointerup", finish, { signal: this.signal });
    head.addEventListener("pointercancel", finish, { signal: this.signal });
  }
}
