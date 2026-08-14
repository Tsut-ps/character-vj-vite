export interface RecordedCue {
  cue: number;
  beat: number;
  strength: number;
  slot?: number;
}

const MAX_CATCH_UP_CYCLES = 8;

/** 固定拍数のキュー録音とループ再生位置を管理する */
export class CueRecorder {
  private readonly lengthBeats: number;
  private recording = false;
  private recordStartBeat = 0;
  private events: RecordedCue[] = [];
  private loopActive = false;
  private loopStartBeat = 0;
  private loopLastBeat = 0;

  /** 1ループの拍数を指定してレコーダーを作る */
  constructor(lengthBeats: number) {
    if (!Number.isFinite(lengthBeats) || lengthBeats <= 0) {
      throw new RangeError("Cue loop length must be positive");
    }
    this.lengthBeats = lengthBeats;
  }

  /** 録音中かどうかを返す */
  get isRecording(): boolean {
    return this.recording;
  }

  /** ループ再生中かどうかを返す */
  get isLooping(): boolean {
    return this.loopActive;
  }

  /** 現在拍から固定長の録音を開始する */
  start(currentBeat: number): void {
    this.recording = true;
    this.events = [];
    this.recordStartBeat = currentBeat;
    this.loopActive = false;
    this.loopStartBeat = currentBeat + this.lengthBeats;
    this.loopLastBeat = currentBeat;
  }

  /** 録音を終了してイベントがあればループを有効化する */
  stop(currentBeat: number, endBeat = this.recordStartBeat + this.lengthBeats): boolean {
    if (!this.recording) return false;
    this.recording = false;
    this.loopActive = this.events.length > 0;
    this.loopStartBeat = endBeat;
    // 終了境界のイベントを最初のループ走査で取りこぼさないよう微小量だけ戻す
    this.loopLastBeat = Math.min(currentBeat, endBeat) - 1e-5;
    return true;
  }

  /** 録音開始からの相対拍位置へキューを記録する */
  record(cue: number, currentBeat: number, strength = 1, slot?: number): void {
    if (!this.recording) return;
    // 終端ちょうどのイベントが次ループ先頭と二重発火しないよう区間内へ収める
    const beat = Math.min(
      this.lengthBeats - 0.000001,
      Math.max(0, currentBeat - this.recordStartBeat),
    );
    this.events.push(slot === undefined ? { cue, beat, strength } : { cue, beat, strength, slot });
  }

  /** 規定拍数へ到達した録音を自動終了する */
  finishIfNeeded(currentBeat: number): boolean {
    if (!this.recording || currentBeat < this.recordStartBeat + this.lengthBeats) return false;
    return this.stop(currentBeat, this.recordStartBeat + this.lengthBeats);
  }

  /** 前回更新から現在までに跨いだループイベントを返す */
  collectDueEvents(currentBeat: number): RecordedCue[] {
    if (!this.loopActive || this.recording || !this.events.length) return [];
    if (currentBeat < this.loopLastBeat) {
      this.loopLastBeat = currentBeat;
      return [];
    }

    const due: RecordedCue[] = [];
    const from = this.loopLastBeat;
    if (currentBeat >= this.loopStartBeat) {
      for (const event of this.events) {
        // フレーム落ちで複数周期を跨いでも未再生の最初の周期から追跡する
        let cycle = Math.floor((from - this.loopStartBeat - event.beat) / this.lengthBeats) + 1;
        if (cycle < 0) cycle = 0;
        const latestCycle = Math.floor((currentBeat - this.loopStartBeat - event.beat) / this.lengthBeats);
        // 長時間停止後に過去の全周期を一括再生して画面と音声が固まるのを防ぐ
        cycle = Math.max(cycle, latestCycle - MAX_CATCH_UP_CYCLES + 1);
        let target = this.loopStartBeat + event.beat + cycle * this.lengthBeats;
        while (target <= currentBeat + 1e-6) {
          if (target > from + 1e-6) due.push(event);
          cycle += 1;
          target = this.loopStartBeat + event.beat + cycle * this.lengthBeats;
        }
      }
    }
    this.loopLastBeat = currentBeat;
    return due;
  }

  /** 録音とループの状態を初期化する */
  clear(currentBeat: number): void {
    this.recording = false;
    this.events = [];
    this.loopActive = false;
    this.loopStartBeat = 0;
    this.loopLastBeat = currentBeat;
  }
}
