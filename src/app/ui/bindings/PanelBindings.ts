import type { VjUiController } from "../VjUiController";
import type { VjUiActions } from "./VjUiActions";

/** 操作パネルの入力をアプリ操作へ接続する */
export class PanelBindings {
  private readonly host: HTMLElement;
  private readonly ui: VjUiController;
  private readonly actions: VjUiActions;
  private readonly signal: AbortSignal;

  /** パネル内のスロットと各操作ボタンを設定する */
  constructor(host: HTMLElement, ui: VjUiController, actions: VjUiActions, signal: AbortSignal) {
    this.host = host;
    this.ui = ui;
    this.actions = actions;
    this.signal = signal;
    this.setup();
  }

  /** パネル内の全入力へイベントを設定する */
  private setup(): void {
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
      bpm.value = this.actions.tap().toFixed(2);
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
}
