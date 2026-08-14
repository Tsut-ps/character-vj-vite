import type { Quantize } from "./types";

export class BeatClock {
  private bpmValue = 128;
  private originMs = performance.now();
  private latencyOffsetMs = 0;
  private taps: number[] = [];

  /** 現在のBPMを返す */
  get bpm(): number {
    return this.bpmValue;
  }

  /** 拍位置を保ったままBPMを更新する */
  setBpm(value: number): void {
    // 空欄などの不正値でクロック全体がNaNになるのを防ぐ
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(300, Math.max(30, value));
    const now = performance.now();
    const beat = this.beatAt(now);
    this.bpmValue = clamped;
    // BPM変更で演出の拍位置が飛ばないよう原点を新しい拍長から逆算する
    this.originMs = now - beat * this.msPerBeat;
  }

  /** 入力遅延の補正値を返す */
  get offsetMs(): number {
    return this.latencyOffsetMs;
  }

  /** 遅延補正を操作可能な範囲へ収めて設定する */
  setOffsetMs(value: number): void {
    if (!Number.isFinite(value)) return;
    this.latencyOffsetMs = Math.min(300, Math.max(-300, value));
  }

  /** 現在時刻を拍頭としてクロック位相を合わせる */
  sync(now = performance.now()): void {
    this.originMs = now + this.latencyOffsetMs;
  }

  /** タップ間隔の平均からBPMを推定する */
  tap(now = performance.now()): number {
    // 長い中断後のタップを前回系列へ混ぜないため2秒で履歴を切る
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) {
      this.taps = [];
    }
    this.taps.push(now);
    // 古いテンポが残り続けない範囲で手ぶれを平均化する
    this.taps = this.taps.slice(-8);
    if (this.taps.length >= 2) {
      const intervals = this.taps.slice(1).map((tap, index) => tap - this.taps[index]);
      const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
      this.setBpm(60000 / average);
    }
    return this.bpmValue;
  }

  /** 1拍の長さをミリ秒で返す */
  get msPerBeat(): number {
    return 60000 / this.bpmValue;
  }

  /** 指定時刻を連続した拍位置へ変換する */
  beatAt(now = performance.now()): number {
    return (now + this.latencyOffsetMs - this.originMs) / this.msPerBeat;
  }

  /** 指定時刻の拍内位相を0以上1未満で返す */
  phase(now = performance.now()): number {
    const beat = this.beatAt(now);
    // 負の拍位置でも正の位相になるよう剰余を正規化する
    return ((beat % 1) + 1) % 1;
  }

  /** 指定時刻が属する整数拍を返す */
  beatNumber(now = performance.now()): number {
    return Math.floor(this.beatAt(now));
  }

  /** 指定時刻を小節番号と拍番号と拍内位相へ分解する */
  barBeat(now = performance.now()): { bar: number; beat: number; phase: number } {
    const absoluteBeat = Math.max(0, this.beatAt(now));
    const whole = Math.floor(absoluteBeat);
    return {
      bar: Math.floor(whole / 4) + 1,
      beat: (whole % 4) + 1,
      phase: absoluteBeat - whole,
    };
  }

  /** クオンタイズ設定に応じた次の発火時刻を返す */
  nextBoundary(now: number, quantize: Quantize): number {
    if (quantize === "off") return now;

    const beat = this.beatAt(now);
    const step =
      quantize === "1/8" ? 0.125 :
      quantize === "1/4" ? 0.25 :
      quantize === "1beat" ? 1 : 4;

    // 境界上の入力を同じ境界へ戻さず次の境界へ送るため微小値を足す
    const nextBeat = Math.ceil((beat + 1e-6) / step) * step;
    return now + (nextBeat - beat) * this.msPerBeat;
  }
}
