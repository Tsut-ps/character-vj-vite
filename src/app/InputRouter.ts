import type { AppAction } from "./types";
import { isFormControlTarget } from "./dom";

export class InputRouter {
  private onAction: (action: AppAction) => void;
  private keyboardCues = new Map<string, number>();
  private gamepadButtons = new Map<number, boolean[]>();
  private midiAccess: MIDIAccess | null = null;
  private midiCues = new Map<string, number>();

  /** 入力をアプリ共通のアクションへ渡すルーターを作る */
  constructor(onAction: (action: AppAction) => void) {
    this.onAction = onAction;
  }

  /** キーボード入力の監視を開始する */
  start(): void {
    // 他のUIがイベントを止めてもVJ操作を優先できるようキャプチャ段階で監視する
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.releaseKeyboardInputs);
  }

  /** キーボード入力の監視を停止する */
  stop(): void {
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.releaseKeyboardInputs);
    this.releaseKeyboardInputs();
  }

  /** キーボードとMIDIの監視を解除して入力状態を破棄する */
  destroy(): void {
    this.stop();
    if (this.midiAccess) {
      for (const input of this.midiAccess.inputs.values()) input.onmidimessage = null;
      this.midiAccess.onstatechange = null;
    }
    this.midiAccess = null;
    this.midiCues.clear();
    this.gamepadButtons.clear();
  }

  /** Web MIDIを有効化して接続中の入力名を返す */
  async enableMidi(): Promise<string[]> {
    if (!("requestMIDIAccess" in navigator)) throw new Error("Web MIDI API is not supported in this browser.");
    const access = await navigator.requestMIDIAccess();
    if (this.midiAccess && this.midiAccess !== access) {
      for (const input of this.midiAccess.inputs.values()) input.onmidimessage = null;
      this.midiAccess.onstatechange = null;
      this.releaseMidiInputs();
    }
    this.midiAccess = access;
    const names: string[] = [];
    for (const input of this.midiAccess.inputs.values()) {
      names.push(input.name ?? "MIDI Input");
      input.onmidimessage = this.onMidiMessage;
    }
    this.midiAccess.onstatechange = (event) => {
      if (!this.midiAccess) return;
      if (event.port?.state === "disconnected") this.releaseMidiInputs(event.port.id);
      // 後から接続された機器にも同じハンドラーを割り当てる
      for (const input of this.midiAccess.inputs.values()) input.onmidimessage = this.onMidiMessage;
    };
    return names;
  }

  /** キー押下をキュー開始または全消去へ変換する */
  private onKeyDown = (event: KeyboardEvent): void => {
    // 数値入力や選択操作をVJショートカットとして二重処理しない
    if (isFormControlTarget(event.target)) return;
    if (event.code === "Enter") {
      event.preventDefault();
      if (!event.repeat) this.onAction({ type: "clear", source: "keyboard" });
      return;
    }
    // 長押しの反復発火はアプリ側の拍同期処理へ一本化する
    if (event.repeat) return;
    const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    if (!match) return;
    event.preventDefault();
    const sourceId = `kbd:${event.code}`;
    this.keyboardCues.set(sourceId, Number(match[1]) - 1);
    this.onAction({
      type: "cue",
      cue: Number(match[1]) - 1,
      phase: "down",
      source: "keyboard",
      sourceId,
      strength: 1,
      latchToggle: event.shiftKey,
    });
  };

  /** キー解放をキュー終了へ変換する */
  private onKeyUp = (event: KeyboardEvent): void => {
    const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    if (!match) return;
    event.preventDefault();
    const sourceId = `kbd:${event.code}`;
    this.keyboardCues.delete(sourceId);
    this.onAction({
      type: "cue",
      cue: Number(match[1]) - 1,
      phase: "up",
      source: "keyboard",
      sourceId,
      strength: 1,
    });
  };

  /** ゲームパッドの押下状態を差分検出してアクションへ変換する */
  pollGamepads(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const connectedIndexes = new Set<number>();
    for (const pad of pads) {
      if (!pad) continue;
      connectedIndexes.add(pad.index);
      let previous = this.gamepadButtons.get(pad.index);
      if (!previous) {
        previous = Array.from({ length: Math.min(8, pad.buttons.length) }, () => false);
        this.gamepadButtons.set(pad.index, previous);
      }
      for (let i = 0; i < Math.min(8, pad.buttons.length); i += 1) {
        const pressed = pad.buttons[i].pressed;
        // 毎フレーム同じ入力を送らず押下状態が変わった瞬間だけ通知する
        if (pressed === previous[i]) continue;
        previous[i] = pressed;
        this.onAction({
          type: "cue",
          cue: i,
          phase: pressed ? "down" : "up",
          source: "gamepad",
          sourceId: `gamepad:${pad.index}:${i}`,
          strength: Math.max(0.45, pad.buttons[i].value || 1),
        });
      }
    }
    for (const [padIndex, buttons] of this.gamepadButtons) {
      if (connectedIndexes.has(padIndex)) continue;
      buttons.forEach((pressed, buttonIndex) => {
        if (!pressed) return;
        this.onAction({
          type: "cue",
          cue: buttonIndex,
          phase: "up",
          source: "gamepad",
          sourceId: `gamepad:${padIndex}:${buttonIndex}`,
          strength: 1,
        });
      });
      this.gamepadButtons.delete(padIndex);
    }
  }

  /** MIDIのNote OnとNote Offをキュー操作へ変換する */
  private onMidiMessage = (event: MIDIMessageEvent): void => {
    const data = event.data;
    if (!data || data.length < 3) return;
    const [status, note, velocity] = data;
    const command = status & 0xf0;
    const inputId = (event.currentTarget as MIDIInput | null)?.id ?? "unknown";
    const sourceId = `midi:${inputId}:${status & 0x0f}:${note}`;
    // 任意のノート番号を8キューへ循環割り当てして機器差を吸収する
    if (command === 0x90 && velocity > 0) {
      this.midiCues.set(sourceId, note % 8);
      this.onAction({ type: "cue", cue: note % 8, phase: "down", source: "midi", sourceId, strength: Math.max(0.2, velocity / 127) });
    } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
      this.midiCues.delete(sourceId);
      this.onAction({ type: "cue", cue: note % 8, phase: "up", source: "midi", sourceId, strength: 1 });
    }
  };

  /** フォーカス喪失時に押下中のキーボードキューをすべて解除する */
  private releaseKeyboardInputs = (): void => {
    for (const [sourceId, cue] of this.keyboardCues) {
      this.onAction({ type: "cue", cue, phase: "up", source: "keyboard", sourceId, strength: 1 });
    }
    this.keyboardCues.clear();
  };

  /** 切断された機器または全機器のMIDIキューを解除する */
  private releaseMidiInputs(inputId?: string): void {
    const prefix = inputId ? `midi:${inputId}:` : "midi:";
    for (const [sourceId, cue] of this.midiCues) {
      if (!sourceId.startsWith(prefix)) continue;
      this.onAction({ type: "cue", cue, phase: "up", source: "midi", sourceId, strength: 1 });
      this.midiCues.delete(sourceId);
    }
  }
}
