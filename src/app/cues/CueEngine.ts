import type { BeatClock } from "../BeatClock";
import { AnimationScheduler } from "../services/AnimationScheduler";
import { CueRecorder } from "../services/CueRecorder";
import { EFFECT_LABELS, EFFECTS, type AppAction, type EffectId, type Quantize } from "../types";

const RECORD_BEATS = 8;

export interface SecretLane {
  column: number;
  count: number;
}

export interface CueEngineHost {
  hasCue(cue: number): boolean;
  hasImage(slot: number): boolean;
  randomImageSlot(): number | null;
  playCue(cue: number, strength: number): void;
  playSecret(slot: number, lane?: SecretLane): void;
  playLatchedPulse(cue: number, strength: number, wholeBeat: number): void;
  immediateFeedback(effect: EffectId): void;
  flash(amount: number): void;
  setLatchVisual(cue: number, active: boolean): void;
  onRecordStateChange(): void;
  onClear(): void;
  log(message: string): void;
}

/** キュー入力と拍同期とラッチと録音を統合して制御する */
export class CueEngine {
  private readonly clock: BeatClock;
  private readonly host: CueEngineHost;
  private quantizeValue: Quantize = "1/8";
  private heldInputs = new Map<string, { cue: number; strength: number; startedMs: number; lastBeat: number }>();
  private latchedCues = new Map<number, { strength: number; lastBeat: number }>();
  private recorder = new CueRecorder(RECORD_BEATS);
  private scheduler = new AnimationScheduler();

  /** 拍クロックと外部処理を受け取ってエンジンを作る */
  constructor(clock: BeatClock, host: CueEngineHost) {
    this.clock = clock;
    this.host = host;
  }

  /** 現在のクオンタイズ設定を返す */
  get quantize(): Quantize {
    return this.quantizeValue;
  }

  /** 録音中かどうかを返す */
  get isRecording(): boolean {
    return this.recorder.isRecording;
  }

  /** ループ中かどうかを返す */
  get isLooping(): boolean {
    return this.recorder.isLooping;
  }

  /** 指定キューがラッチ中か返す */
  isLatched(cue: number): boolean {
    return this.latchedCues.has(cue);
  }

  /** ラッチ中のキュー番号を最大4件返す */
  latchedCueNumbers(): number[] {
    return [...this.latchedCues.keys()].slice(0, 4);
  }

  /** 共通入力アクションを解除やラッチやキュー発火へ振り分ける */
  handleAction(action: AppAction): void {
    if (action.type === "clear") {
      this.host.onClear();
      return;
    }
    if (action.phase === "up") {
      this.heldInputs.delete(action.sourceId);
      return;
    }
    if (action.latchToggle) {
      this.toggleLatch(action.cue, action.strength);
      return;
    }

    // 同じ物理入力の重複downを無視して長押し状態を一つに保つ
    if (this.heldInputs.has(action.sourceId)) return;
    if (action.cue === 8 && this.host.randomImageSlot() === null) return;
    if (action.cue !== 8 && !this.host.hasCue(action.cue)) return;
    this.heldInputs.set(action.sourceId, {
      cue: action.cue,
      strength: action.strength,
      startedMs: performance.now(),
      lastBeat: Math.floor(this.clock.beatAt()),
    });
    if (action.cue === 8) this.triggerSecretCue();
    else this.triggerCue(action.cue, action.strength);
  }

  /** クリック操作など保持状態を持たない入力を直接発火する */
  trigger(cue: number, strength = 1, latchToggle = false): void {
    if (latchToggle) {
      this.toggleLatch(cue, strength);
      return;
    }
    if (cue === 8) this.triggerSecretCue();
    else this.triggerCue(cue, strength);
  }

  /** 長押しと録音とループを現在時刻まで進める */
  update(now: number): void {
    this.updateAutoHold(now);
    if (this.recorder.finishIfNeeded(this.clock.beatAt(now))) {
      this.host.onRecordStateChange();
      this.host.log(this.recorder.isLooping ? "REC END → LOOP 2 BARS" : "REC END / EMPTY");
    }
    this.updateLoop(now);
  }

  /** クオンタイズ設定を次の選択肢へ進めて表示名を返す */
  cycleQuantize(): string {
    const values: Quantize[] = ["off", "1/8", "1/4", "1beat", "1bar"];
    const labels = ["OFF", "1/8 BEAT", "1/4 BEAT", "1 BEAT", "1 BAR"];
    const next = (values.indexOf(this.quantizeValue) + 1) % values.length;
    this.quantizeValue = values[next];
    this.host.log(`QUANTIZE ${labels[next]}`);
    return labels[next];
  }

  /** 2小節録音の開始または終了を切り替える */
  toggleRecord(): void {
    const beat = this.clock.beatAt();
    if (this.recorder.isRecording) {
      this.recorder.stop(beat);
      this.host.onRecordStateChange();
      this.host.log(this.recorder.isLooping ? "REC END → LOOP 2 BARS" : "REC END / EMPTY");
      return;
    }
    this.recorder.start(beat);
    this.host.onRecordStateChange();
    this.host.log("REC START / 2 BARS");
  }

  /** 入力とラッチと録音と予約発火を初期化する */
  clear(): void {
    this.scheduler.clear();
    this.heldInputs.clear();
    for (const cue of this.latchedCues.keys()) this.host.setLatchVisual(cue, false);
    this.latchedCues.clear();
    this.recorder.clear(this.clock.beatAt());
    this.host.onRecordStateChange();
  }

  /** 内部タイマーを解除して保持中の状態を破棄する */
  destroy(): void {
    this.clear();
  }

  /** 入力フィードバックを即時表示してキューを拍境界へ予約する */
  private triggerCue(cue: number, strength = 1, shouldLog = true): void {
    if (!this.host.hasCue(cue)) return;
    const effect = EFFECTS[cue];
    if (shouldLog) this.host.log(`CUE ${cue + 1} ${EFFECT_LABELS[effect]}`);
    this.host.immediateFeedback(effect);
    const now = performance.now();
    const delay = Math.max(0, this.clock.nextBoundary(now, this.quantizeValue) - now);
    // タイマー精度以下の待機は遅延だけを増やすため即時発火する
    if (delay < 8) this.playCueNow(cue, strength);
    else this.scheduler.schedule(() => this.playCueNow(cue, strength), delay);
  }

  /** キューを記録してホストへ実再生を依頼する */
  private playCueNow(cue: number, strength = 1, allowRecord = true): void {
    if (!this.host.hasCue(cue)) return;
    if (this.recorder.isRecording && allowRecord) {
      this.recorder.record(cue, this.clock.beatAt(), strength);
    }
    this.host.playCue(cue, strength);
  }

  /** ランダム画像を選び9番演出を拍境界へ予約する */
  private triggerSecretCue(): void {
    const slot = this.host.randomImageSlot();
    if (slot === null) return;
    this.host.log(`9 GRAVITY / RANDOM CUE ${slot + 1}`);
    this.host.immediateFeedback("jump");
    const now = performance.now();
    const delay = Math.max(0, this.clock.nextBoundary(now, this.quantizeValue) - now);
    if (delay < 8) this.playSecretNow(slot);
    else this.scheduler.schedule(() => this.playSecretNow(slot), delay);
  }

  /** 9番キューを記録してホストへ実再生を依頼する */
  private playSecretNow(slot: number, allowRecord = true, lane?: SecretLane): void {
    if (!this.host.hasImage(slot)) return;
    if (this.recorder.isRecording && allowRecord) {
      this.recorder.record(8, this.clock.beatAt(), 1, slot);
    }
    this.host.playSecret(slot, lane);
  }

  /** 指定キューの拍同期ラッチを切り替える */
  private toggleLatch(cue: number, strength = 1): void {
    if (this.latchedCues.has(cue)) {
      this.latchedCues.delete(cue);
      this.host.setLatchVisual(cue, false);
      this.host.log(`SHIFT AUTO ${cue + 1} OFF`);
      return;
    }
    // 素材が外された後でも既存ラッチは解除できるよう追加時だけ素材を検証する
    if (cue === 8 ? this.host.randomImageSlot() === null : !this.host.hasCue(cue)) return;
    // 画面分割と同時描画負荷を予測可能に保つため4列までに制限する
    if (this.latchedCues.size >= 4) {
      this.host.immediateFeedback(cue === 8 ? "jump" : EFFECTS[cue]);
      this.host.flash(0.16);
      this.host.log("SHIFT AUTO LIMIT 4");
      return;
    }

    this.latchedCues.set(cue, { strength, lastBeat: Math.floor(this.clock.beatAt()) });
    this.host.setLatchVisual(cue, true);
    this.host.log(`SHIFT AUTO ${cue + 1} ON`);
    if (cue === 8) {
      const slot = this.host.randomImageSlot();
      if (slot !== null) {
        const order = this.latchedCueNumbers();
        this.host.immediateFeedback("jump");
        this.playSecretNow(slot, true, { column: order.indexOf(8), count: order.length });
      }
    } else {
      this.triggerCue(cue, strength, false);
    }
  }

  /** 長押しとラッチ中のキューを拍ごとに自動発火する */
  private updateAutoHold(now: number): void {
    const wholeBeat = Math.floor(this.clock.beatAt(now) + 1e-6);
    for (const held of this.heldInputs.values()) {
      if (this.latchedCues.has(held.cue)) continue;
      if (wholeBeat < held.lastBeat) {
        held.lastBeat = wholeBeat;
        continue;
      }
      // 短い通常タップを長押しと誤認しないよう220ms待つ
      if (now - held.startedMs < 220 || wholeBeat <= held.lastBeat) continue;
      held.lastBeat = wholeBeat;
      if (held.cue === 8) {
        const slot = this.host.randomImageSlot();
        if (slot !== null) {
          this.host.immediateFeedback("jump");
          this.host.log(`HOLD AUTO 9 / RANDOM CUE ${slot + 1}`);
          this.playSecretNow(slot);
        }
      } else {
        this.host.immediateFeedback(EFFECTS[held.cue]);
        this.host.log(`HOLD AUTO ${held.cue + 1}`);
        this.playCueNow(held.cue, held.strength);
      }
    }

    for (const [cue, latched] of this.latchedCues) {
      if (wholeBeat < latched.lastBeat) {
        latched.lastBeat = wholeBeat;
        continue;
      }
      if (wholeBeat <= latched.lastBeat) continue;
      latched.lastBeat = wholeBeat;
      if (cue === 8) {
        const slot = this.host.randomImageSlot();
        if (slot !== null) {
          const order = this.latchedCueNumbers();
          this.host.immediateFeedback("jump");
          this.host.log(`SHIFT AUTO 9 / RANDOM CUE ${slot + 1}`);
          this.playSecretNow(slot, true, { column: Math.max(0, order.indexOf(8)), count: order.length });
        }
      } else {
        if (this.recorder.isRecording) {
          this.recorder.record(cue, this.clock.beatAt(), latched.strength);
        }
        this.host.immediateFeedback(EFFECTS[cue]);
        this.host.log(`SHIFT AUTO ${cue + 1}`);
        this.host.playLatchedPulse(cue, latched.strength, wholeBeat);
      }
    }
  }

  /** 前回更新から現在までに跨いだ録音イベントを再生する */
  private updateLoop(now: number): void {
    for (const event of this.recorder.collectDueEvents(this.clock.beatAt(now))) {
      if (event.cue === 8) {
        this.host.immediateFeedback("pop");
        this.host.log("LOOP 9 GRAVITY");
        const slot = event.slot ?? this.host.randomImageSlot();
        if (slot !== null) this.playSecretNow(slot, false);
      } else {
        this.host.immediateFeedback(EFFECTS[event.cue]);
        this.host.log(`LOOP ${event.cue + 1}`);
        this.playCueNow(event.cue, event.strength, false);
      }
    }
  }
}
