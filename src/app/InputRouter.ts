import type { AppAction } from "./types";

export class InputRouter {
  private onAction: (action: AppAction) => void;
  private gamepadButtons = new Map<number, boolean[]>();
  private midiAccess: MIDIAccess | null = null;

  /** 入力をアプリ共通のアクションへ渡すルーターを作る */
  constructor(onAction: (action: AppAction) => void) {
    this.onAction = onAction;
  }

  /** キーボード入力の監視を開始する */
  start(): void {
    // 他のUIがイベントを止めてもVJ操作を優先できるようキャプチャ段階で監視する
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
  }

  /** キーボード入力の監視を停止する */
  stop(): void {
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
  }

  /** Web MIDIを有効化して接続中の入力名を返す */
  async enableMidi(): Promise<string[]> {
    if (!("requestMIDIAccess" in navigator)) throw new Error("Web MIDI API is not supported in this browser.");
    this.midiAccess = await navigator.requestMIDIAccess();
    const names: string[] = [];
    for (const input of this.midiAccess.inputs.values()) {
      names.push(input.name ?? "MIDI Input");
      input.onmidimessage = this.onMidiMessage;
    }
    this.midiAccess.onstatechange = () => {
      if (!this.midiAccess) return;
      // 後から接続された機器にも同じハンドラーを割り当てる
      for (const input of this.midiAccess.inputs.values()) input.onmidimessage = this.onMidiMessage;
    };
    return names;
  }

  /** キー押下をキュー開始または全消去へ変換する */
  private onKeyDown = (event: KeyboardEvent): void => {
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
    this.onAction({
      type: "cue",
      cue: Number(match[1]) - 1,
      phase: "down",
      source: "keyboard",
      sourceId: `kbd:${event.code}`,
      strength: 1,
      latchToggle: event.shiftKey,
    });
  };

  /** キー解放をキュー終了へ変換する */
  private onKeyUp = (event: KeyboardEvent): void => {
    const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    if (!match) return;
    event.preventDefault();
    this.onAction({
      type: "cue",
      cue: Number(match[1]) - 1,
      phase: "up",
      source: "keyboard",
      sourceId: `kbd:${event.code}`,
      strength: 1,
    });
  };

  /** ゲームパッドの押下状態を差分検出してアクションへ変換する */
  pollGamepads(): void {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad) continue;
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
  }

  /** MIDIのNote OnとNote Offをキュー操作へ変換する */
  private onMidiMessage = (event: MIDIMessageEvent): void => {
    const data = event.data;
    if (!data || data.length < 3) return;
    const [status, note, velocity] = data;
    const command = status & 0xf0;
    const sourceId = `midi:${status & 0x0f}:${note}`;
    // 任意のノート番号を8キューへ循環割り当てして機器差を吸収する
    if (command === 0x90 && velocity > 0) {
      this.onAction({ type: "cue", cue: note % 8, phase: "down", source: "midi", sourceId, strength: Math.max(0.2, velocity / 127) });
    } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
      this.onAction({ type: "cue", cue: note % 8, phase: "up", source: "midi", sourceId, strength: 1 });
    }
  };
}
