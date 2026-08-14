import "pixi.js/prepare";
import { Application, Container, Graphics, Sprite, Texture } from "pixi.js";
import { BeatClock } from "./BeatClock";
import { playEffect, type EffectHost } from "./effects";
import { InputRouter } from "./InputRouter";
import { createEmptySlot, type Slot } from "./models/Slot";
import { AnimationScheduler } from "./services/AnimationScheduler";
import { AudioManager } from "./services/AudioManager";
import { CueRecorder } from "./services/CueRecorder";
import {
  createPanelPreview,
  getGifFrameDurationMs,
  loadImageFile,
} from "./services/ImageLoader";
import { EFFECT_LABELS, EFFECTS, type AppAction, type EffectId, type Quantize } from "./types";
import {
  createVjUi,
  queryRequired,
} from "./ui/createVjUi";

const RECORD_BEATS = 8;

export class VJApp implements EffectHost {
  readonly app = new Application();
  readonly root = new Container();
  readonly actorLayer = new Container();
  readonly fxLayer = new Container();
  readonly secretLayer = new Container();
  width = 1280;
  height = 720;

  private backgroundLayer = new Container();
  private ambientLayer = new Container();
  private latchedLayer = new Container();
  private activeActor: Sprite | null = null;
  private ambientActor: Sprite | null = null;
  private latchedActors = new Map<number, Sprite>();
  private persistentBackgroundCharacters: Array<{
    sprite: Sprite;
    slot: number;
    seed: number;
    size: number;
    flip: number;
    alpha: number;
  }> = [];
  private characterPresenceUntil = 0;
  private slots: Slot[] = Array.from({ length: 8 }, () => createEmptySlot());
  private commonTransform = { scale: 1, anchorX: 0.5, anchorY: 0.5 };
  private selectedSlot = 0;
  private activeSlot: number | null = null;
  private quantize: Quantize = "1/8";
  private clock = new BeatClock();
  private router = new InputRouter((action) => this.handleAction(action));
  private animation = new AnimationScheduler();
  private audio = new AudioManager();
  private panel!: HTMLElement;
  private slotElements: HTMLElement[] = [];
  private hud!: HTMLElement;
  private beatPulse!: HTMLElement;
  private flashElement!: HTMLElement;
  private backgroundShapes: Graphics[] = [];
  private heldInputs = new Map<string, { cue: number; strength: number; startedMs: number; lastBeat: number }>();
  private latchedCues = new Map<number, { strength: number; lastBeat: number }>();
  private cueButtons: HTMLButtonElement[] = [];
  private recorder = new CueRecorder(RECORD_BEATS);
  private recordButton!: HTMLButtonElement;
  private bpmGraphPath!: SVGPathElement;
  private bpmGraphValue!: HTMLElement;
  private bpmHistory: Array<{ time: number; bpm: number }> = [{ time: performance.now(), bpm: 128 }];
  private lastBpmSample = 0;
  private actionLog!: HTMLElement;
  private keyGuide!: HTMLElement;
  private virtualShift = false;
  private actionMessages: string[] = [];
  private resetGeneration = 0;
  private fxPool: Sprite[] = [];
  private backgroundCharacterPool: Sprite[] = [];
  private resolvedTransforms = Array.from({ length: 8 }, () => ({ scale: 1, anchorX: 0.5, anchorY: 0.5 }));
  private fitScales = Array.from({ length: 8 }, () => 1);
  private lastHudUpdate = 0;
  private lastHudHtml = "";
  private limitFps60 = false;
  private hideBackground = false;
  private skipAssign = false;
  private assignOverlay!: HTMLElement;
  private assignSources!: HTMLElement;
  private assignTargets!: HTMLElement;
  private pendingAssignments: Array<{ id: number; file: File; kind: "IMG" | "SFX"; preview: string }> = [];
  private nextPendingAssignmentId = 1;
  private panelWasHiddenBeforeAssign = false;
  private dropOverlaySuppressed = false;

  /** PixiJSとUIと入力監視を初期化する */
  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: window,
      backgroundAlpha: 0,
      antialias: true,
      // HiDPIで見えない過剰解像度を描画せずフレーム時間を安定させる
      resolution: this.renderResolution(),
      autoDensity: true,
    });

    this.app.canvas.id = "vj-canvas";
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.root);
    this.root.addChild(this.ambientLayer, this.backgroundLayer, this.fxLayer, this.latchedLayer, this.actorLayer, this.secretLayer);
    this.refreshTransforms();

    this.createBackground();
    this.createUi(host);
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.setupDrop(host);
    this.router.start();

    // 入力や音声や拍は実時間基準なので通常は描画上限を設けず必要時だけ60 FPSへ制限する
    this.app.ticker.maxFPS = 0;
    this.app.ticker.add(() => {
      const now = performance.now();
      this.router.pollGamepads();
      this.updateAnimatedGifs(now);
      this.animation.update(now);
      this.updateAutoHold(now);
      this.updateRecording(now);
      this.updateLoop(now);
      this.updateBackground(now);
      this.updateAmbient(now);
      this.updateLatchedActors(now);
      this.updateBpmGraph(now);
      this.updateHud(now);
      if (this.activeActor && now > this.characterPresenceUntil) this.activeActor.visible = false;
    });
  }

  /** 演出対象のアクターを返す */
  getCharacter(): Sprite | null {
    return this.activeActor;
  }

  /** 非同期演出を無効化するためのリセット世代を返す */
  getResetGeneration(): number {
    return this.resetGeneration;
  }

  /** 指定スロットの確定済み表示変形を返す */
  private transformFor(index: number): { scale: number; anchorX: number; anchorY: number } {
    return this.resolvedTransforms[index] ?? this.resolvedTransforms[0];
  }

  /** 共通値とスロット別補正から各表示変形を再計算する */
  private refreshTransforms(): void {
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      const resolved = this.resolvedTransforms[index];
      // 完全な画面外化や極端な拡大を避けライブ中に復帰できる範囲へ制限する
      resolved.scale = Math.max(0.35, Math.min(2.5, this.commonTransform.scale + slot.scaleOffset));
      resolved.anchorX = Math.max(0.15, Math.min(0.85, this.commonTransform.anchorX + slot.anchorXOffset));
      resolved.anchorY = Math.max(0.15, Math.min(0.85, this.commonTransform.anchorY + slot.anchorYOffset));
    }
  }

  /** 各画像が画面内へ収まる基準スケールを再計算する */
  private refreshFitScales(): void {
    for (let index = 0; index < this.slots.length; index += 1) {
      const texture = this.slots[index].texture;
      this.fitScales[index] = texture
        // 端へ密着すると動きが見切れるため6%の余白を残す
        ? Math.min(this.width / Math.max(1, texture.width), this.height / Math.max(1, texture.height)) * 0.94
        : 1;
    }
  }

  /** 画面サイズとDPRから負荷を抑えた描画解像度を決める */
  private renderResolution(): number {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    // バッキングバッファをWQHD相当までに抑えて高DPI環境のGPU負荷を制限する
    const maxPixels = 2560 * 1440;
    const pixelBound = Math.sqrt(maxPixels / (width * height));
    return Math.max(0.65, Math.min(window.devicePixelRatio || 1, 1.5, pixelBound));
  }

  /** 直近8件の操作ログを新しいほど濃く表示する */
  private logAction(message: string): void {
    this.actionMessages.push(message);
    if (this.actionMessages.length > 8) this.actionMessages.shift();
    if (!this.actionLog) return;
    // 操作のたびにDOMを増減させず固定行を再利用する
    while (this.actionLog.children.length < 8) {
      const row = document.createElement("div");
      row.className = "action-log-entry";
      this.actionLog.appendChild(row);
    }
    const rows = this.actionLog.children;
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

  /** 現在アクターの画面座標と表示スケールを返す */
  getActorPlacement(): { x: number; y: number; scale: number } {
    const index = this.activeSlot ?? this.selectedSlot;
    const transform = this.transformFor(index);
    const fit = this.fitScales[index] ?? 1;
    return {
      x: this.width * transform.anchorX,
      y: this.height * transform.anchorY,
      scale: fit * transform.scale,
    };
  }

  /** 残像用に現在キャラクターのスプライトを借りて配置する */
  cloneCharacter(alpha = 1): Sprite | null {
    const slot = this.activeSlot === null ? null : this.slots[this.activeSlot];
    if (!slot?.texture) return null;
    const sprite = this.acquireFxSprite(slot.texture);
    const placement = this.getActorPlacement();
    sprite.position.set(placement.x, placement.y);
    sprite.scale.set(placement.scale);
    sprite.alpha = alpha;
    return sprite;
  }

  /** 毎フレーム更新する時間ベースのアニメーションを登録する */
  animate(
    duration: number,
    update: (t: number) => void,
    complete?: () => void,
    isActive: () => boolean = () => true,
  ): void {
    this.animation.animate(duration, update, complete, isActive);
  }

  /** プールから演出用スプライトを取得して初期状態へ戻す */
  private acquireFxSprite(texture: Texture): Sprite {
    const sprite = this.fxPool.pop() ?? new Sprite(texture);
    sprite.texture = texture;
    sprite.anchor.set(0.5);
    sprite.position.set(0, 0);
    sprite.scale.set(1);
    sprite.rotation = 0;
    sprite.alpha = 1;
    sprite.visible = true;
    this.fxLayer.addChild(sprite);
    return sprite;
  }

  /** 演出用スプライトを再利用プールへ返す */
  private releaseFxSprite(sprite: Sprite): void {
    if (sprite.destroyed) return;
    sprite.removeFromParent();
    sprite.visible = false;
    sprite.alpha = 1;
    sprite.rotation = 0;
    // 長時間運用でプールが増え続けないよう同時演出数に十分な48個へ制限する
    if (this.fxPool.length < 48) this.fxPool.push(sprite);
    else sprite.destroy();
  }

  /** スプライトを拡大しながらフェードさせて残像として解放する */
  addAfterimage(sprite: Sprite, lifetimeMs: number): void {
    const initialAlpha = sprite.alpha;
    const initialScaleX = sprite.scale.x;
    const initialScaleY = sprite.scale.y;
    this.animate(lifetimeMs, (t) => {
      sprite.alpha = initialAlpha * (1 - t);
      const grow = 1 + t * 0.06;
      sprite.scale.set(initialScaleX * grow, initialScaleY * grow);
    }, () => this.releaseFxSprite(sprite), () => !sprite.destroyed);
  }

  /** ルート全体へ減衰するランダム揺れを加える */
  shake(amount: number, durationMs: number): void {
    const generation = this.resetGeneration;
    this.animate(durationMs, (t) => {
      const power = amount * (1 - t);
      this.root.position.set((Math.random() - 0.5) * power, (Math.random() - 0.5) * power);
    }, () => this.root.position.set(0, 0), () => generation === this.resetGeneration);
  }

  /** 後から一括解除できる遅延処理を登録する */
  schedule(callback: () => void, delayMs: number): void {
    this.animation.schedule(callback, delayMs);
  }

  /** 画面を瞬時に明るくしてフェードアウトさせる */
  flash(amount = 0.55): void {
    this.flashElement.style.opacity = String(Math.min(0.9, amount));
    // 不透明状態を一度描画してから遷移を付けないとフェードが開始されない
    requestAnimationFrame(() => {
      this.flashElement.style.transition = "opacity 180ms ease-out";
      this.flashElement.style.opacity = "0";
      window.setTimeout(() => { this.flashElement.style.transition = "none"; }, 200);
    });
  }

  /** 音声ファイルをデコードして指定スロットへ割り当てる */
  private async assignAudioFile(index: number, file: File): Promise<void> {
    if (!file.type.startsWith("audio/")) return;
    const decoded = await this.audio.decode(file);
    const slot = this.slots[index];
    slot.audioBuffer = decoded.buffer;
    slot.audioName = decoded.name;
    slot.audioStart = decoded.start;
    slot.audioDuration = decoded.duration;
    const el = this.slotElements[index];
    const audioLabel = el.querySelector<HTMLElement>("[data-audio]");
    if (audioLabel) audioLabel.textContent = `SFX ${file.name.replace(/\.[^.]+$/, "").slice(0, 10)}`;
    this.logAction(`SFX ${index + 1} ${file.name} / TRIM ${Math.round(decoded.trimmedMs)}ms`);
  }

  /** 指定スロットのトリム済み音声を入力強度に応じて再生する */
  private playCueAudio(index: number, strength = 1): void {
    const slot = this.slots[index];
    if (!slot?.audioBuffer || slot.audioDuration <= 0) return;
    this.audio.play({
      buffer: slot.audioBuffer,
      start: slot.audioStart,
      duration: slot.audioDuration,
    }, strength);
  }

  /** 共通入力アクションを解除やラッチやキュー発火へ振り分ける */
  private handleAction(action: AppAction): void {
    if (action.type === "clear") {
      if (!this.assignOverlay.hidden) {
        const remaining = this.pendingAssignments.length;
        this.closeAssignOverlay(true);
        this.logAction(`D&D ASSIGN CONFIRM${remaining ? ` / SKIP ${remaining}` : ""}`);
        return;
      }
      this.clearAllAnimations();
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
    this.audio.resume();
    if (action.cue === 8 && this.randomLoadedSlot() === null) return;
    if (action.cue !== 8 && !this.slots[action.cue]?.texture && !this.slots[action.cue]?.audioBuffer) return;

    this.heldInputs.set(action.sourceId, {
      cue: action.cue,
      strength: action.strength,
      startedMs: performance.now(),
      lastBeat: Math.floor(this.clock.beatAt()),
    });

    if (action.cue === 8) this.triggerSecretCue();
    else this.triggerCue(action.cue, action.strength);
  }

  /** 入力フィードバックを即時表示してキューを拍境界へ予約する */
  private triggerCue(cue: number, strength = 1, shouldLog = true): void {
    if (!this.slots[cue]?.texture && !this.slots[cue]?.audioBuffer) return;
    this.audio.resume();
    const effect = EFFECTS[cue];
    if (shouldLog) this.logAction(`CUE ${cue + 1} ${EFFECT_LABELS[effect]}`);
    this.immediateFeedback(effect);
    const now = performance.now();
    const target = this.clock.nextBoundary(now, this.quantize);
    const delay = Math.max(0, target - now);
    // タイマー精度以下の待機は遅延だけを増やすため即時発火する
    if (delay < 8) {
      this.playCueNow(cue, strength);
      return;
    }
    this.schedule(() => this.playCueNow(cue, strength), delay);
  }

  /** キューの音声と画像演出を実際に再生する */
  private playCueNow(cue: number, strength = 1, allowRecord = true): void {
    const effect = EFFECTS[cue];
    const slot = this.slots[cue];
    if (!effect || (!slot?.texture && !slot?.audioBuffer)) return;
    if (this.recorder.isRecording && allowRecord) this.recordCue(cue, strength);
    if (slot.isGif) slot.gifActiveUntil = Math.max(slot.gifActiveUntil ?? 0, performance.now() + 900);
    this.playCueAudio(cue, strength);
    if (!slot.texture || !this.activateSlot(cue)) return;
    this.setAmbientSlot(cue);
    this.seedBackgroundCharacters(cue);
    playEffect(effect, this, strength);
    this.characterPresenceUntil = performance.now() + 720;
  }

  /** 画像読み込み済みスロットを偏りなく一つ選ぶ */
  private randomLoadedSlot(): number | null {
    let count = 0;
    for (const slot of this.slots) if (slot.texture) count += 1;
    if (!count) return null;
    let pick = Math.floor(Math.random() * count);
    for (let index = 0; index < this.slots.length; index += 1) {
      if (!this.slots[index].texture) continue;
      if (pick === 0) return index;
      pick -= 1;
    }
    return null;
  }

  /** ランダム画像を選び9番演出を拍境界へ予約する */
  private triggerSecretCue(): void {
    const slot = this.randomLoadedSlot();
    if (slot == null || !this.slots[slot]?.texture) return;
    this.logAction(`9 GRAVITY / RANDOM CUE ${slot + 1}`);
    this.immediateFeedback("jump");
    const now = performance.now();
    const target = this.clock.nextBoundary(now, this.quantize);
    const delay = Math.max(0, target - now);
    if (delay < 8) {
      this.playSecretNow(slot);
      return;
    }
    this.schedule(() => this.playSecretNow(slot), delay);
  }

  /** 9番のGRAVITY演出を指定スロットで再生する */
  private playSecretNow(
    slot: number,
    allowRecord = true,
    lane?: { column: number; count: number },
  ): void {
    const texture = this.slots[slot]?.texture;
    if (!texture) return;
    this.activeSlot = slot;
    this.setAmbientSlot(slot);
    this.seedBackgroundCharacters(slot);
    if (this.recorder.isRecording && allowRecord) this.recordCue(8, 1, slot);

    const sprite = this.acquireFxSprite(texture);
    // 9番演出を通常アクターやラッチ列や他の演出より常に前面へ出す
    this.secretLayer.addChild(sprite);
    const transform = this.transformFor(slot);
    const fit = this.fitScales[slot];
    const baseScale = fit * transform.scale * 1.5;
    const laneCount = Math.max(1, lane?.count ?? 1);
    const laneColumn = Math.max(0, Math.min(laneCount - 1, lane?.column ?? 0));
    const laneWidth = this.width / laneCount;
    const centerX = lane
      ? this.width * ((laneColumn + 0.5) / laneCount) + this.width * (transform.anchorX - 0.5)
      : this.width * transform.anchorX;
    // 視線が散らないよう横移動は小さく保ち左右の変化だけランダムにする
    const horizontalBasis = lane ? laneWidth : this.width;
    const driftMagnitude = horizontalBasis * (0.02 + Math.random() * 0.04);
    const horizontalDrift = driftMagnitude * (Math.random() < 0.5 ? -1 : 1);
    const startX = centerX - horizontalDrift * 0.5;
    const endX = centerX + horizontalDrift * 0.5;
    const anchorY = this.height * transform.anchorY;
    const startY = anchorY + this.height * 0.14;
    const arcHeight = this.height * 0.22;
    sprite.position.set(startX, startY);
    sprite.scale.set(baseScale);

    const start = performance.now();
    const duration = this.clock.msPerBeat;
    const gifSlot = this.slots[slot];
    if (gifSlot.isGif) gifSlot.gifActiveUntil = Math.max(gifSlot.gifActiveUntil ?? 0, start + duration + 100);
    this.characterPresenceUntil = Math.max(this.characterPresenceUntil, start + duration);
    this.animate(duration, (t) => {
      // 同じ放物線を時間変換してゆっくり上昇し素早く落下する重さを作る
      const risePower = 1.6;
      const fallPower = 0.72;
      const timeBias = 1.4783532205046865;
      const ta = Math.pow(Math.max(0, t), risePower);
      const tb = timeBias * Math.pow(Math.max(0, 1 - t), fallPower);
      const s = ta + tb > 0 ? ta / (ta + tb) : 1;
      const x = startX + (endX - startX) * s;
      const y = startY - 4 * arcHeight * s * (1 - s);
      const motionPhase = 2 * s - 1;
      const stretch = s < 0.5
        ? 0.012 * (s / 0.5)
        : Math.min(0.075, Math.pow((s - 0.5) / 0.5, 1.5) * 0.075);
      const sx = 1 - stretch * 0.22;
      const sy = 1 + stretch;
      const alpha = t < 0.1 ? t / 0.1 : t > 0.96 ? (1 - t) / 0.04 : 1;
      sprite.position.set(x, y);
      sprite.rotation = motionPhase * 0.008;
      sprite.scale.set(baseScale * sx, baseScale * sy);
      sprite.alpha = Math.max(0, Math.min(1, alpha));
    }, () => this.releaseFxSprite(sprite), () => !sprite.destroyed);
  }

  /** 録音開始からの相対拍位置へキューを記録する */
  private recordCue(cue: number, strength = 1, slot?: number): void {
    this.recorder.record(cue, this.clock.beatAt(), strength, slot);
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
      if (now - held.startedMs < 220) continue;
      if (wholeBeat > held.lastBeat) {
        held.lastBeat = wholeBeat;
        if (held.cue === 8) {
          const slot = this.randomLoadedSlot();
          if (slot !== null) {
            this.immediateFeedback("jump");
            this.logAction(`HOLD AUTO 9 / RANDOM CUE ${slot + 1}`);
            this.playSecretNow(slot);
          }
        } else {
          this.immediateFeedback(EFFECTS[held.cue]);
          this.logAction(`HOLD AUTO ${held.cue + 1}`);
          this.playCueNow(held.cue, held.strength);
        }
      }
    }

    for (const [cue, latched] of this.latchedCues) {
      if (wholeBeat < latched.lastBeat) {
        latched.lastBeat = wholeBeat;
        continue;
      }
      if (wholeBeat > latched.lastBeat) {
        latched.lastBeat = wholeBeat;
        if (cue === 8) {
          const slot = this.randomLoadedSlot();
          if (slot !== null) {
            const order = [...this.latchedCues.keys()].slice(0, 4);
            const column = Math.max(0, order.indexOf(8));
            this.immediateFeedback("jump");
            this.logAction(`SHIFT AUTO 9 / RANDOM CUE ${slot + 1}`);
            this.playSecretNow(slot, true, { column, count: order.length });
          }
          continue;
        }
        this.immediateFeedback(EFFECTS[cue]);
        this.logAction(`SHIFT AUTO ${cue + 1}`);
        if (this.recorder.isRecording) this.recordCue(cue, latched.strength);
        this.playCueAudio(cue, latched.strength);
        this.seedBackgroundCharacters(cue);
        if (cue === 3) this.shake(10 * latched.strength, 150);
        else if (cue === 7 && wholeBeat % 2 === 0) this.flash(0.18);
      }
    }
  }

  /** 指定キューの拍同期ラッチを切り替える */
  private toggleLatch(cue: number, strength = 1): void {
    const slot = cue === 8 ? null : this.slots[cue];
    if (cue === 8 ? this.randomLoadedSlot() === null : (!slot?.texture && !slot?.audioBuffer)) return;
    this.audio.resume();
    if (this.latchedCues.has(cue)) {
      this.latchedCues.delete(cue);
      this.logAction(`SHIFT AUTO ${cue + 1} OFF`);
      const sprite = this.latchedActors.get(cue);
      if (sprite && !sprite.destroyed) sprite.destroy();
      this.latchedActors.delete(cue);
    } else {
      // 画面分割と同時描画負荷を予測可能に保つため4列までに制限する
      if (this.latchedCues.size >= 4) {
        this.immediateFeedback(cue === 8 ? "jump" : EFFECTS[cue]);
        this.flash(0.16);
        this.logAction("SHIFT AUTO LIMIT 4");
        return;
      }
      this.latchedCues.set(cue, {
        strength,
        lastBeat: Math.floor(this.clock.beatAt()),
      });
      this.logAction(`SHIFT AUTO ${cue + 1} ON`);
      if (cue === 8) {
        const slot = this.randomLoadedSlot();
        if (slot !== null) {
          const order = [...this.latchedCues.keys()].slice(0, 4);
          this.immediateFeedback("jump");
          this.playSecretNow(slot, true, { column: order.indexOf(8), count: order.length });
        }
      } else {
        if (slot?.texture) {
          const sprite = new Sprite(slot.texture);
          sprite.anchor.set(0.5);
          sprite.alpha = 0.96;
          this.latchedLayer.addChild(sprite);
          this.latchedActors.set(cue, sprite);
        }
        this.triggerCue(cue, strength, false);
      }
    }
    this.updateLatchUi();
  }

  /** ラッチ状態をキューボタンの見た目へ反映する */
  private updateLatchUi(): void {
    this.cueButtons.forEach((button, cue) => button.classList.toggle("latched", this.latchedCues.has(cue)));
  }

  /** 2小節録音の開始または終了を切り替える */
  private toggleRecord(): void {
    const beat = this.clock.beatAt();
    if (this.recorder.isRecording) {
      this.recorder.stop(beat);
      this.handleRecordStopped();
      return;
    }
    this.recorder.start(beat);
    this.updateRecordButton();
    this.logAction("REC START / 2 BARS");
  }

  /** 録音終了をボタンと操作ログへ反映する */
  private handleRecordStopped(): void {
    this.updateRecordButton();
    this.logAction(this.recorder.isLooping ? "REC END → LOOP 2 BARS" : "REC END / EMPTY");
  }

  /** 規定の8拍へ到達した録音を自動終了する */
  private updateRecording(now: number): void {
    if (this.recorder.finishIfNeeded(this.clock.beatAt(now))) this.handleRecordStopped();
  }

  /** 録音とループ状態を操作ボタンへ反映する */
  private updateRecordButton(): void {
    if (!this.recordButton) return;
    this.recordButton.classList.toggle("recording", this.recorder.isRecording);
    this.recordButton.textContent = this.recorder.isRecording
      ? "● REC 2 BARS [R]"
      : this.recorder.isLooping
        ? "LOOP 2 BARS [R]"
        : "REC [R]";
  }

  /** 前回更新から現在までに跨いだ録音イベントを再生する */
  private updateLoop(now: number): void {
    for (const event of this.recorder.collectDueEvents(this.clock.beatAt(now))) {
      if (event.cue === 8) {
        this.immediateFeedback("pop");
        this.logAction("LOOP 9 GRAVITY");
        this.playSecretNow(event.slot ?? this.selectedSlot, false);
      } else {
        this.immediateFeedback(EFFECTS[event.cue]);
        this.logAction(`LOOP ${event.cue + 1}`);
        this.playCueNow(event.cue, event.strength, false);
      }
    }
  }

  /** 演出と音声と自動再生状態をまとめて初期化する */
  private clearAllAnimations(): void {
    this.resetGeneration += 1;
    this.animation.clear();
    this.heldInputs.clear();
    this.latchedCues.clear();
    this.updateLatchUi();

    this.recorder.clear(this.clock.beatAt());
    this.updateRecordButton();

    this.characterPresenceUntil = 0;
    if (this.activeActor) this.activeActor.visible = false;
    if (this.ambientActor) this.ambientActor.visible = false;
    this.activeSlot = null;

    for (const sprite of this.latchedActors.values()) {
      if (!sprite.destroyed) sprite.destroy();
    }
    this.latchedActors.clear();

    for (const entry of this.persistentBackgroundCharacters) {
      if (entry.sprite.destroyed) continue;
      entry.sprite.visible = false;
      entry.sprite.removeFromParent();
      // 背景キャラクターの上限と同じ数だけ再利用してメモリ増加を防ぐ
      if (this.backgroundCharacterPool.length < 24) this.backgroundCharacterPool.push(entry.sprite);
      else entry.sprite.destroy();
    }
    this.persistentBackgroundCharacters = [];

    const pooledChildren = [
      ...this.fxLayer.removeChildren(),
      ...this.secretLayer.removeChildren(),
    ];
    for (const child of pooledChildren) {
      if (child instanceof Sprite && !child.destroyed && this.fxPool.length < 48) {
        child.visible = false;
        this.fxPool.push(child);
      } else {
        child.destroy();
      }
    }
    this.audio.stopAll();
    this.root.position.set(0, 0);
    this.flashElement.style.transition = "none";
    this.flashElement.style.opacity = "0";
    this.beatPulse.getAnimations().forEach((animation) => animation.cancel());
    this.beatPulse.classList.remove("hit");
    this.logAction("ENTER / ALL ANIMATIONS CLEAR");
  }

  /** クオンタイズ待ちの前に入力受付を短い枠線アニメーションで示す */
  private immediateFeedback(effect: EffectId): void {
    this.beatPulse.dataset.effect = effect;
    this.beatPulse.getAnimations().forEach((animation) => animation.cancel());
    this.beatPulse.animate(
      [
        { borderWidth: "5px", borderColor: "rgba(255,255,255,.9)" },
        { borderWidth: "1px", borderColor: "rgba(255,255,255,.12)" },
      ],
      { duration: 140, easing: "ease-out" },
    );
  }

  /** 背景を構成する抽象図形を生成する */
  private createBackground(): void {
    for (let i = 0; i < 16; i += 1) {
      const g = new Graphics();
      const size = 22 + (i % 5) * 18;
      if (i % 3 === 0) g.circle(0, 0, size).stroke({ width: 3, color: 0xffffff, alpha: 0.15 });
      else g.rect(-size, -size, size * 2, size * 2).stroke({ width: 2, color: 0xffffff, alpha: 0.11 });
      g.rotation = i * 0.45;
      this.backgroundLayer.addChild(g);
      this.backgroundShapes.push(g);
    }
  }

  /** BPM位相に合わせて背景図形を移動させる */
  private updateBackground(now: number): void {
    if (this.hideBackground) return;
    const beat = this.clock.beatAt(now);
    const pulse = 0.5 + 0.5 * Math.cos(this.clock.phase(now) * Math.PI * 2);
    this.backgroundShapes.forEach((shape, index) => {
      const lane = index % 4;
      const speed = 0.018 + lane * 0.004;
      shape.rotation += speed * (index % 2 ? 1 : -1);
      shape.x = this.width * (0.5 + 0.42 * Math.sin(beat * 0.22 + index * 1.7));
      shape.y = this.height * (0.5 + 0.42 * Math.cos(beat * 0.18 + index * 1.19));
      shape.scale.set(0.7 + pulse * 0.18 + (index % 4) * 0.09);
    });
  }

  /** 背景へ薄く表示するキャラクターを指定スロットへ切り替える */
  private setAmbientSlot(index: number): void {
    const texture = this.slots[index]?.texture;
    if (!texture) return;
    if (!this.ambientActor) {
      this.ambientActor = new Sprite(texture);
      this.ambientActor.anchor.set(0.5);
      this.ambientLayer.addChild(this.ambientActor);
    } else if (this.ambientActor.texture !== texture) {
      this.ambientActor.texture = texture;
    }
    this.fitAmbient();
  }

  /** 指定キャラクターの小さな背景コピーを2体追加する */
  private seedBackgroundCharacters(index: number): void {
    const texture = this.slots[index]?.texture;
    if (!texture) return;
    for (let i = 0; i < 2; i += 1) {
      // 長時間の連打でも個数が増えないよう古い要素を循環利用する
      let entry = this.persistentBackgroundCharacters.length >= 24
        ? this.persistentBackgroundCharacters.shift()
        : undefined;
      if (!entry || entry.sprite.destroyed) {
        const sprite = this.backgroundCharacterPool.pop() ?? new Sprite(texture);
        sprite.texture = texture;
        sprite.anchor.set(0.5);
        sprite.visible = true;
        this.ambientLayer.addChild(sprite);
        entry = { sprite, slot: index, seed: 0, size: 0, flip: 1, alpha: 0 };
      } else {
        entry.sprite.texture = texture;
        entry.sprite.visible = true;
      }
      entry.slot = index;
      entry.seed = Math.random() * 1000;
      entry.size = 0.085 + Math.random() * 0.075;
      entry.flip = Math.random() < 0.35 ? -1 : 1;
      entry.alpha = 0.025 + Math.random() * 0.035;
      this.persistentBackgroundCharacters.push(entry);
    }
  }

  /** 背景キャラクターを拍に合わせて漂わせる */
  private updateAmbient(now: number): void {
    const beat = this.clock.beatAt(now);
    const phase = this.clock.phase(now);
    const pulse = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);

    this.persistentBackgroundCharacters.forEach((entry, index) => {
      const slot = this.slots[entry.slot];
      if (!slot.texture || entry.sprite.destroyed) return;
      if (entry.sprite.texture !== slot.texture) entry.sprite.texture = slot.texture;
      const fit = this.fitScales[entry.slot] * this.transformFor(entry.slot).scale;
      const scale = fit * entry.size * (1 + pulse * 0.12);
      entry.sprite.position.set(
        this.width * (0.5 + 0.46 * Math.sin(beat * (0.11 + (index % 7) * 0.009) + entry.seed)),
        this.height * (0.5 + 0.43 * Math.cos(beat * (0.095 + (index % 5) * 0.008) + entry.seed * 0.73)),
      );
      entry.sprite.rotation = Math.sin(beat * 0.19 + entry.seed) * 0.18;
      entry.sprite.scale.set(scale * entry.flip, scale);
      entry.sprite.alpha = entry.alpha;
      entry.sprite.visible = true;
    });

    if (!this.ambientActor) return;
    const present = now <= this.characterPresenceUntil;
    this.ambientActor.visible = present;
    if (!present || this.activeSlot === null) return;

    const transform = this.transformFor(this.activeSlot);
    const base = this.ambientBaseScale();
    const anchorX = this.width * transform.anchorX;
    const anchorY = this.height * transform.anchorY;
    this.ambientActor.position.set(
      anchorX + Math.sin(beat * 0.42) * this.width * 0.035,
      anchorY + this.height * 0.03 + Math.sin(beat * Math.PI * 0.5) * this.height * 0.018,
    );
    this.ambientActor.rotation = Math.sin(beat * 0.38) * 0.025;
    this.ambientActor.scale.set(base * (0.96 + pulse * 0.06), base * (0.98 - pulse * 0.025));
    this.ambientActor.alpha = 0.05 + pulse * 0.04;
  }

  /** ラッチ中のキャラクターを最大4列へ並べて固有演出を反復する */
  private updateLatchedActors(now: number): void {
    const cues = [...this.latchedCues.keys()].slice(0, 4);
    const count = cues.length;
    if (!count) return;
    const beat = this.clock.beatAt(now);
    const phase = this.clock.phase(now);
    const wholeBeat = Math.floor(beat);

    cues.forEach((cue, column) => {
      if (cue === 8) return;
      const slot = this.slots[cue];
      const texture = slot.texture;
      if (!texture) return;
      let sprite = this.latchedActors.get(cue);
      if (!sprite || sprite.destroyed) {
        sprite = new Sprite(texture);
        sprite.anchor.set(0.5);
        this.latchedLayer.addChild(sprite);
        this.latchedActors.set(cue, sprite);
      } else if (sprite.texture !== texture) {
        sprite.texture = texture;
      }

      const fit = this.fitScales[cue];
      const transform = this.transformFor(cue);
      const base = fit * transform.scale;
      // ラッチ数で画面を等分し各キューの基準位置を独立させる
      const columnWidth = this.width / count;
      let x = this.width * ((column + 0.5) / count) + this.width * (transform.anchorX - 0.5);
      let y = this.height * transform.anchorY;
      let sx = base;
      let sy = base;
      let rotation = 0;
      const direction = (cue + wholeBeat) % 2 ? -1 : 1;

      if (cue === 0) {
        const t = Math.min(1, phase * 2.15);
        const c1 = 1.70158;
        const c3 = c1 + 1;
        const back = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
        sx *= 0.72 + 0.28 * back;
        sy *= 0.82 + 0.18 * back;
        y += this.height * 0.055 * (1 - (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)));
      } else if (cue === 1) {
        const t = Math.min(1, phase * 3);
        const expo = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
        x += direction * (1 - expo) * columnWidth * 0.34;
        rotation = direction * (1 - phase) * 0.08;
      } else if (cue === 2) {
        x += Math.sin(phase * Math.PI * 4) * 12;
        y += Math.sin(phase * Math.PI * 2) * 18;
        sprite.alpha = 0.84 + Math.sin(phase * Math.PI * 2) * 0.1;
      } else if (cue === 3) {
        const hit = Math.exp(-phase * 8) * Math.sin(phase * Math.PI * 2);
        sx *= 1 + 0.24 * hit;
        sy *= 1 + 0.18 * hit;
      } else if (cue === 4) {
        const step = Math.floor(phase * 8);
        sx *= step % 2 ? -1 : 1;
        sy *= step % 4 < 2 ? 1 : -1;
        y += Math.cos(step * 1.7) * this.height * 0.018;
      } else if (cue === 5) {
        const hop = Math.sin(phase * Math.PI);
        y -= Math.max(0, hop) * this.height * 0.14;
        sx *= 1 + 0.06 * hop;
        sy *= 1 - 0.06 * hop;
      } else if (cue === 6) {
        sx *= 0.82 + 0.12 * Math.sin(phase * Math.PI * 6);
        sy *= 0.82 + 0.12 * Math.cos(phase * Math.PI * 6);
        x += Math.sin(phase * Math.PI * 8 + cue) * columnWidth * 0.08;
      } else if (cue === 7) {
        const step = Math.floor(phase * 8);
        sx *= step % 2 ? -1 : 1;
        y -= Math.abs(Math.sin(phase * Math.PI * 2)) * this.height * 0.08;
        x += Math.sin(phase * Math.PI * 6 + cue) * columnWidth * 0.08;
        rotation = Math.sin(phase * Math.PI * 4) * 0.12;
      }

      sprite.position.set(x, y);
      sprite.scale.set(sx, sy);
      sprite.rotation = rotation;
      if (cue !== 2) sprite.alpha = 0.96;
      sprite.visible = true;
    });
  }

  /** 前景余白を除いて背景アクター用の少し小さいスケールを返す */
  private ambientBaseScale(): number {
    if (!this.ambientActor || this.activeSlot === null) return 1;
    const transform = this.transformFor(this.activeSlot);
    // fitScalesの6%余白を一度戻してから背景用の82%へ揃える
    return (this.fitScales[this.activeSlot] / 0.94) * 0.82 * transform.scale;
  }

  /** 背景アクターを現在スロットの変形へ合わせる */
  private fitAmbient(): void {
    if (!this.ambientActor || this.activeSlot === null) return;
    const transform = this.transformFor(this.activeSlot);
    const scale = this.ambientBaseScale();
    this.ambientActor.position.set(this.width * transform.anchorX, this.height * transform.anchorY + this.height * 0.03);
    this.ambientActor.scale.set(scale);
  }

  /** 直近12秒のBPM履歴を100ms間隔でグラフへ反映する */
  private updateBpmGraph(now: number): void {
    if (!this.bpmGraphPath || !this.bpmGraphValue || now - this.lastBpmSample < 100) return;
    this.lastBpmSample = now;
    this.bpmHistory.push({ time: now, bpm: this.clock.bpm });
    while (this.bpmHistory.length > 1 && this.bpmHistory[0].time < now - 12000) this.bpmHistory.shift();
    if (!this.bpmHistory.length) return;
    const values = this.bpmHistory.map((point) => point.bpm);
    const low0 = Math.min(...values);
    const high0 = Math.max(...values);
    // BPMが一定でも線が端へ張り付かないよう最低2 BPMの上下余白を設ける
    const padding = Math.max(2, (high0 - low0) * 0.25);
    const low = Math.max(0, low0 - padding);
    const high = high0 + padding;
    const span = Math.max(1, high - low);
    const path = this.bpmHistory.map((point, index) => {
      const x = Math.max(0, Math.min(260, 260 - ((now - point.time) / 12000) * 260));
      const y = 70 - ((point.bpm - low) / span) * 64;
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    this.bpmGraphPath.setAttribute("d", path);
    this.bpmGraphValue.textContent = this.clock.bpm.toFixed(2);
  }

  /** 全体または現在スロットだけの表示サイズを調整する */
  private adjustActiveScale(delta: number, individual = false): void {
    const index = this.activeSlot ?? this.selectedSlot;
    const slot = this.slots[index];
    if (individual) {
      const current = this.transformFor(index).scale;
      const next = Math.max(0.35, Math.min(2.5, current + delta));
      // 共通値が後から変わっても個別差分を維持できるよう絶対値ではなく補正量を保存する
      slot.scaleOffset = next - this.commonTransform.scale;
      this.refreshTransforms();
      this.logAction(`CUE ${index + 1} SIZE ${Math.round(next * 100)}%`);
    } else {
      this.commonTransform.scale = Math.max(0.35, Math.min(2.5, this.commonTransform.scale + delta));
      this.refreshTransforms();
      this.logAction(`ALL SIZE ${Math.round(this.commonTransform.scale * 100)}%`);
    }
    this.fitActor();
    this.fitAmbient();
  }

  /** 全体または現在スロットだけの表示基準位置を調整する */
  private moveActiveAnchor(dx: number, dy: number, individual = false): void {
    const index = this.activeSlot ?? this.selectedSlot;
    const slot = this.slots[index];
    if (individual) {
      const current = this.transformFor(index);
      const nextX = Math.max(0.15, Math.min(0.85, current.anchorX + dx));
      const nextY = Math.max(0.15, Math.min(0.85, current.anchorY + dy));
      slot.anchorXOffset = nextX - this.commonTransform.anchorX;
      slot.anchorYOffset = nextY - this.commonTransform.anchorY;
      this.refreshTransforms();
      this.logAction(`CUE ${index + 1} POS ${Math.round(nextX * 100)},${Math.round(nextY * 100)}`);
    } else {
      this.commonTransform.anchorX = Math.max(0.15, Math.min(0.85, this.commonTransform.anchorX + dx));
      this.commonTransform.anchorY = Math.max(0.15, Math.min(0.85, this.commonTransform.anchorY + dy));
      this.refreshTransforms();
      this.logAction(`ALL POS ${Math.round(this.commonTransform.anchorX * 100)},${Math.round(this.commonTransform.anchorY * 100)}`);
    }
    this.fitActor();
    this.fitAmbient();
  }

  /** 左右Shiftをガイド上の一つのキー表示へ正規化する */
  private keyVisualCode(code: string): string {
    return code === "ShiftRight" ? "ShiftLeft" : code;
  }

  /** 実キーまたは仮想キーの押下状態をガイドへ反映する */
  private setKeyVisual(code: string, active: boolean): void {
    if (!this.keyGuide) return;
    const visualCode = this.keyVisualCode(code);
    for (const element of this.keyGuide.querySelectorAll<HTMLElement>(`[data-code="${visualCode}"]`)) {
      element.classList.toggle("active", active);
    }
  }

  /** クリック操作用のShiftトグル状態を更新する */
  private setVirtualShift(active: boolean): void {
    this.virtualShift = active;
    if (!this.keyGuide) return;
    for (const element of this.keyGuide.querySelectorAll<HTMLElement>('[data-code="ShiftLeft"]')) {
      element.classList.toggle("virtual-shift", active);
    }
  }

  /** ガイド上のキー押下を実キーボードと同じ操作へ変換する */
  private virtualKeyDown(code: string, sourceId: string): boolean {
    this.audio.resume();
    const cue = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (cue) {
      this.handleAction({
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
      this.moveActiveAnchor(
        code === "ArrowLeft" ? -0.025 : code === "ArrowRight" ? 0.025 : 0,
        code === "ArrowUp" ? -0.025 : code === "ArrowDown" ? 0.025 : 0,
        this.virtualShift,
      );
      return false;
    }
    if (code === "Equal" || code === "NumpadAdd") {
      this.adjustActiveScale(0.1, this.virtualShift);
      return false;
    }
    if (code === "Minus" || code === "NumpadSubtract") {
      this.adjustActiveScale(-0.1, this.virtualShift);
      return false;
    }
    if (code === "Enter") {
      this.handleAction({ type: "clear", source: "keyboard" });
      return false;
    }
    if (code === "Escape") {
      if (this.cancelDropOverlay()) return false;
      if (!this.assignOverlay.hidden) {
        this.closeAssignOverlay(true);
        return false;
      }
      this.panel.classList.toggle("hidden");
      this.logAction(this.panel.classList.contains("hidden") ? "MENU HIDE" : "MENU SHOW");
      return false;
    }
    if (code === "Space") {
      if (this.virtualShift) {
        this.clock.sync();
        this.logAction("SYNC");
      } else {
        const value = this.clock.tap();
        const bpmInput = this.panel.querySelector<HTMLInputElement>("[data-field=bpm]");
        if (bpmInput) bpmInput.value = value.toFixed(2);
        this.bpmHistory.push({ time: performance.now(), bpm: this.clock.bpm });
        this.logAction(`TAP ${this.clock.bpm.toFixed(2)}`);
      }
      return false;
    }
    if (code === "KeyR") {
      this.toggleRecord();
      return false;
    }
    return false;
  }

  /** 画面内キーボードへクリックと長押し操作を設定する */
  private setupKeyGuide(): void {
    for (const button of this.keyGuide.querySelectorAll<HTMLButtonElement>("button[data-code]")) {
      const code = button.dataset.code!;
      if (code === "ShiftLeft") {
        button.addEventListener("click", () => this.setVirtualShift(!this.virtualShift));
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
      });
      /** 仮想キーの押下表示と長押し状態を解除する */
      const end = () => {
        this.setKeyVisual(code, false);
        if (!held) return;
        this.handleAction({ type: "cue", cue: Number(/([1-9])$/.exec(code)?.[1] ?? 1) - 1, phase: "up", source: "ui", sourceId, strength: 1 });
        held = false;
      };
      button.addEventListener("pointerup", end);
      button.addEventListener("pointercancel", end);
    }
  }

  /** HUDと操作パネルと割り当て画面を生成してイベントを接続する */
  private createUi(host: HTMLElement): void {
    const ui = createVjUi(host);
    this.flashElement = ui.flashElement;
    this.beatPulse = ui.beatPulse;
    this.hud = ui.hud;
    this.bpmGraphPath = ui.bpmGraphPath;
    this.bpmGraphValue = ui.bpmGraphValue;
    this.keyGuide = ui.keyGuide;
    this.actionLog = ui.actionLog;
    this.panel = ui.panel;
    this.assignOverlay = ui.assignOverlay;
    this.assignSources = ui.assignSources;
    this.assignTargets = ui.assignTargets;
    this.slotElements = ui.slotElements;
    this.cueButtons = ui.cueButtons;
    this.setupKeyGuide();

    // キャンセル時は未割り当て素材を残さず通常画面へ戻す
    queryRequired<HTMLElement>(this.assignOverlay, "[data-action=cancel-assign]").addEventListener("click", () => this.closeAssignOverlay(true));
    [...this.assignTargets.children].forEach((targetElement, index) => {
      const target = targetElement as HTMLElement;
      target.addEventListener("dragover", (event) => { event.preventDefault(); target.classList.add("drag"); });
      target.addEventListener("dragleave", () => target.classList.remove("drag"));
      // 割り当て画面の素材IDを受け取り元のFileを対象スロットへ渡す
      target.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.remove("is-dragging");
        target.classList.remove("drag");
        const id = event.dataTransfer?.getData("text/pending-id");
        if (id) void this.assignPendingToSlot(id, index);
      });
    });

    this.slotElements.forEach((slot, index) => {
      slot.addEventListener("click", () => this.selectSlot(index));
      slot.addEventListener("dragover", (event) => { event.preventDefault(); slot.classList.add("drag"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("drag"));
      // パネル上への直接ドロップは全画面割り当てを経由せず即時反映する
      slot.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        slot.classList.remove("drag");
        const file = event.dataTransfer?.files[0];
        if (file) void this.assignFile(index, file);
      });
    });

    this.cueButtons.forEach((button, index) => {
      button.addEventListener("click", (event) => {
        if (event.shiftKey) this.toggleLatch(index, 1);
        else this.triggerCue(index, 1);
      });
    });

    const bpm = this.panel.querySelector<HTMLInputElement>("[data-field=bpm]")!;
    bpm.addEventListener("change", () => { this.clock.setBpm(Number(bpm.value)); this.bpmHistory.push({ time: performance.now(), bpm: this.clock.bpm }); this.logAction(`BPM ${this.clock.bpm.toFixed(2)}`); });
    const quantizeButton = this.panel.querySelector<HTMLButtonElement>("[data-action=quantize]")!;
    const quantizeValues: Quantize[] = ["off", "1/8", "1/4", "1beat", "1bar"];
    const quantizeLabels = ["OFF", "1/8 BEAT", "1/4 BEAT", "1 BEAT", "1 BAR"];
    // 選択肢が少ないためプルダウンではなくクリックで順番に切り替える
    quantizeButton.addEventListener("click", () => {
      const current = quantizeValues.indexOf(this.quantize);
      const next = (current + 1) % quantizeValues.length;
      this.quantize = quantizeValues[next];
      quantizeButton.textContent = `Q ${quantizeLabels[next]}`;
      this.logAction(`QUANTIZE ${quantizeLabels[next]}`);
    });
    const offset = this.panel.querySelector<HTMLInputElement>("[data-field=offset]")!;
    offset.addEventListener("change", () => { this.clock.setOffsetMs(Number(offset.value)); this.logAction(`OFFSET ${Number(offset.value)}ms`); });
    const fpsLimit = this.panel.querySelector<HTMLInputElement>("[data-field=limit-fps]")!;
    fpsLimit.addEventListener("change", () => {
      this.limitFps60 = fpsLimit.checked;
      this.app.ticker.maxFPS = this.limitFps60 ? 60 : 0;
      this.logAction(this.limitFps60 ? "60 FPS LIMIT ON" : "60 FPS LIMIT OFF");
    });
    const hideBackground = this.panel.querySelector<HTMLInputElement>("[data-field=hide-background]")!;
    hideBackground.addEventListener("change", () => {
      this.hideBackground = hideBackground.checked;
      this.backgroundLayer.visible = !this.hideBackground;
      host.classList.toggle("background-hidden", this.hideBackground);
      this.logAction(this.hideBackground ? "BACKGROUND HIDDEN" : "BACKGROUND SHOWN");
    });
    const skipAssign = this.panel.querySelector<HTMLInputElement>("[data-field=skip-assign]")!;
    skipAssign.addEventListener("change", () => {
      this.skipAssign = skipAssign.checked;
      this.logAction(this.skipAssign ? "D&D ASSIGN SKIP ON" : "D&D ASSIGN SKIP OFF");
    });
    const masterVolume = this.panel.querySelector<HTMLInputElement>("[data-field=master-volume]")!;
    const masterVolumeValue = this.panel.querySelector<HTMLElement>("[data-field=master-volume-value]")!;
    masterVolume.addEventListener("input", () => {
      this.audio.setVolume(Number(masterVolume.value) / 100);
      masterVolumeValue.textContent = `${Math.round(this.audio.volume * 100)}%`;
    });
    masterVolume.addEventListener("change", () => {
      this.logAction(`SFX VOLUME ${Math.round(this.audio.volume * 100)}%`);
    });

    this.panel.querySelector("[data-action=tap]")!.addEventListener("click", () => {
      bpm.value = this.clock.tap().toFixed(2);
      this.bpmHistory.push({ time: performance.now(), bpm: this.clock.bpm });
      this.logAction(`TAP ${this.clock.bpm.toFixed(2)}`);
    });
    this.panel.querySelector("[data-action=sync]")!.addEventListener("click", () => { this.clock.sync(); this.logAction("SYNC"); });
    this.panel.querySelector("[data-action=hide]")!.addEventListener("click", () => { this.panel.classList.add("hidden"); this.logAction("MENU HIDE"); });
    this.recordButton = this.panel.querySelector<HTMLButtonElement>("[data-action=record]")!;
    this.recordButton.addEventListener("click", () => this.toggleRecord());
    this.panel.querySelector("[data-action=fullscreen]")!.addEventListener("click", () => { this.logAction("FULLSCREEN"); void document.documentElement.requestFullscreen?.(); });
    this.panel.querySelector("[data-action=midi]")!.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      try {
        const names = await this.router.enableMidi();
        button.textContent = names.length ? `MIDI: ${names.length} INPUT` : "MIDI: READY";
        this.logAction(`MIDI READY ${names.length}`);
      } catch (error) {
        button.textContent = error instanceof Error ? error.message : "MIDI ERROR";
        this.logAction("MIDI ERROR");
      }
    });

    // InputRouter対象外の表示調整やテンポ操作をUI層で処理する
    window.addEventListener("keydown", (event) => {
      this.setKeyVisual(event.code, true);
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) {
        event.preventDefault();
        this.moveActiveAnchor(
          event.code === "ArrowLeft" ? -0.025 : event.code === "ArrowRight" ? 0.025 : 0,
          event.code === "ArrowUp" ? -0.025 : event.code === "ArrowDown" ? 0.025 : 0,
          event.shiftKey,
        );
        return;
      }
      if (event.code === "NumpadAdd" || event.key === "+") {
        event.preventDefault();
        this.adjustActiveScale(0.1, event.shiftKey);
        return;
      }
      if (event.code === "NumpadSubtract" || event.code === "Minus") {
        event.preventDefault();
        this.adjustActiveScale(-0.1, event.shiftKey);
        return;
      }
      if (event.repeat) return;
      if (event.code === "Escape") {
        event.preventDefault();
        if (this.cancelDropOverlay()) return;
        if (!this.assignOverlay.hidden) {
          this.closeAssignOverlay(true);
          return;
        }
        this.panel.classList.toggle("hidden");
        this.logAction(this.panel.classList.contains("hidden") ? "MENU HIDE" : "MENU SHOW");
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        if (event.shiftKey) {
          this.clock.sync();
          this.logAction("SYNC");
        } else {
          bpm.value = this.clock.tap().toFixed(2);
          this.bpmHistory.push({ time: performance.now(), bpm: this.clock.bpm });
          this.logAction(`TAP ${this.clock.bpm.toFixed(2)}`);
        }
        return;
      }

      if (event.code === "KeyR") {
        event.preventDefault();
        this.toggleRecord();
      }
    }, true);
    window.addEventListener("keyup", (event) => this.setKeyVisual(event.code, false), true);

    this.makePanelDraggable();
    this.selectSlot(0, false);
  }

  /** パネル見出しをドラッグして画面内で移動できるようにする */
  private makePanelDraggable(): void {
    const head = this.panel.querySelector<HTMLElement>(".panel-head");
    if (!head) return;

    let drag: { pointerId: number; dx: number; dy: number; moved: boolean } | null = null;
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button, input, select")) return;

      const rect = this.panel.getBoundingClientRect();
      this.panel.style.left = `${rect.left}px`;
      this.panel.style.top = `${rect.top}px`;
      this.panel.style.right = "auto";
      this.panel.classList.add("moving");
      drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
      head.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    head.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      // パネルが画面外へ消えて再操作不能にならないよう座標を制限する
      const maxX = Math.max(0, window.innerWidth - this.panel.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - this.panel.offsetHeight);
      const left = Math.max(0, Math.min(maxX, event.clientX - drag.dx));
      const top = Math.max(0, Math.min(maxY, event.clientY - drag.dy));
      this.panel.style.left = `${left}px`;
      this.panel.style.top = `${top}px`;
      drag.moved = true;
    });

    /** パネル移動のポインター追跡を終了する */
    const finish = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      this.panel.classList.remove("moving");
      if (moved) this.logAction("MENU MOVED");
    };
    head.addEventListener("pointerup", finish);
    head.addEventListener("pointercancel", finish);
  }

  /** ドロップ素材を最大16件まで割り当て画面へ読み込む */
  private async openAssignOverlay(files: File[]): Promise<void> {
    // 8スロットへ画像と音声を1件ずつ置ける最大数に制限する
    const valid = files.filter((file) => file.type.startsWith("image/") || file.type.startsWith("audio/")).slice(0, 16);
    if (!valid.length) return;
    this.panelWasHiddenBeforeAssign = this.panel.classList.contains("hidden");
    this.panel.classList.add("hidden");
    this.pendingAssignments = [];
    for (const file of valid) {
      const kind = file.type.startsWith("audio/") ? "SFX" as const : "IMG" as const;
      let preview = "";
      if (kind === "IMG") {
        try { preview = await createPanelPreview(file, 420); } catch { preview = ""; }
      }
      this.pendingAssignments.push({ id: this.nextPendingAssignmentId++, file, kind, preview });
    }
    this.renderAssignOverlay();
    this.logAction(`D&D ASSIGN ${valid.length} FILE${valid.length === 1 ? "" : "S"}`);
  }

  /** 未割り当て素材の一覧を割り当て画面へ再描画する */
  private renderAssignOverlay(): void {
    this.assignOverlay.hidden = this.pendingAssignments.length === 0;
    this.assignSources.replaceChildren();
    for (const item of this.pendingAssignments) {
      const source = document.createElement("button");
      source.type = "button";
      source.className = `assign-source${item.kind === "SFX" ? " audio" : ""}`;
      source.draggable = true;
      if (item.preview) source.style.backgroundImage = `url(${item.preview})`;
      source.innerHTML = `<span class="kind">${item.kind}</span><span class="name"></span>`;
      source.querySelector<HTMLElement>(".name")!.textContent = item.file.name;
      source.addEventListener("dragstart", (event) => {
        source.classList.add("dragging");
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData("text/pending-id", String(item.id));
      });
      source.addEventListener("dragend", () => source.classList.remove("dragging"));
      this.assignSources.appendChild(source);
    }
    this.updateAssignTargets();
    if (this.pendingAssignments.length === 0 && !this.panelWasHiddenBeforeAssign) this.panel.classList.remove("hidden");
  }

  /** 各割り当て先へ現在の画像と音声名を反映する */
  private updateAssignTargets(): void {
    const targets = [...this.assignTargets.children] as HTMLElement[];
    targets.forEach((target, index) => {
      const panelBackground = this.slotElements[index]?.style.backgroundImage ?? "";
      target.style.backgroundImage = panelBackground;
      const names: string[] = [];
      if (this.slots[index]?.texture) names.push(`${this.slots[index].isGif ? "GIF" : "IMG"} ${this.slots[index].name}`);
      if (this.slots[index]?.audioBuffer) names.push(`SFX ${this.slots[index].audioName}`);
      const label = target.querySelector("small");
      if (label) label.textContent = names.join(" + ") || "EMPTY";
    });
  }

  /** 必要に応じて未割り当て素材を破棄して割り当て画面を閉じる */
  private closeAssignOverlay(clear: boolean): void {
    if (clear) this.pendingAssignments = [];
    this.renderAssignOverlay();
    this.logAction("D&D ASSIGN CLOSE");
  }

  /** 未割り当て素材をIDで取り出して指定スロットへ移す */
  private async assignPendingToSlot(idText: string, slotIndex: number): Promise<void> {
    const id = Number(idText);
    const index = this.pendingAssignments.findIndex((item) => item.id === id);
    if (index < 0) return;
    const item = this.pendingAssignments[index];
    this.pendingAssignments.splice(index, 1);
    if (item.kind === "SFX") await this.assignAudioFile(slotIndex, item.file);
    else await this.assignFile(slotIndex, item.file);
    this.logAction(`${item.kind} → ${slotIndex + 1} ${item.file.name}`);
    this.renderAssignOverlay();
  }

  /** 表示中の全画面ドロップ案内をEscで抑制する */
  private cancelDropOverlay(): boolean {
    if (!document.body.classList.contains("is-dragging")) return false;
    document.body.classList.remove("is-dragging");
    this.dropOverlaySuppressed = true;
    this.logAction("DROP OVERLAY CANCEL");
    return true;
  }

  /** ステージ全体の画像と音声ドロップ処理を設定する */
  private setupDrop(host: HTMLElement): void {
    host.addEventListener("dragover", (event) => {
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      const overUi = Boolean(target?.closest(".control-panel, .assign-overlay, .key-guide"));
      if (overUi || this.dropOverlaySuppressed) {
        document.body.classList.remove("is-dragging");
        return;
      }
      document.body.classList.add("is-dragging");
    });
    host.addEventListener("dragleave", (event) => {
      if (event.target === host) {
        document.body.classList.remove("is-dragging");
        this.dropOverlaySuppressed = false;
      }
    });
    host.addEventListener("drop", (event) => {
      event.preventDefault();
      document.body.classList.remove("is-dragging");
      this.dropOverlaySuppressed = false;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".control-panel, .key-guide")) return;
      // 割り当て画面内の内部ドラッグを新規ファイルドロップとして処理しない
      if (event.dataTransfer?.getData("text/pending-id")) return;
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/") || file.type.startsWith("audio/"));
      if (!files.length) return;
      if (!this.skipAssign) {
        void this.openAssignOverlay(files);
        return;
      }
      const images = files.filter((file) => file.type.startsWith("image/")).slice(0, 8);
      const audio = files.filter((file) => file.type.startsWith("audio/")).slice(0, 8);
      const jobs: Promise<void>[] = [];
      // 単一素材は選択先へ、複数素材は演奏順が分かりやすい1番から割り当てる
      if (images.length === 1) jobs.push(this.assignFile(this.selectedSlot, images[0]));
      else images.forEach((file, index) => jobs.push(this.assignFile(index, file)));
      if (audio.length === 1) jobs.push(this.assignAudioFile(this.selectedSlot, audio[0]));
      else audio.forEach((file, index) => jobs.push(this.assignAudioFile(index, file)));
      if (!jobs.length) return;
      void Promise.all(jobs).then(() => this.selectSlot(images.length > 1 || audio.length > 1 ? 0 : this.selectedSlot));
    });
  }

  /** 画像またはGIFをデコードして指定スロットへ割り当てる */
  private async assignFile(index: number, file: File): Promise<void> {
    if (file.type.startsWith("audio/")) {
      await this.assignAudioFile(index, file);
      return;
    }
    if (!file.type.startsWith("image/")) return;
    const previous = this.slots[index];
    const loaded = await loadImageFile(file);
    // 初回キューでGPU転送が発生して引っかからないよう先にアップロードする
    try {
      await this.app.renderer.prepare.upload(loaded.texture);
    } catch (error) {
      // GPU転送失敗時は新規リソースだけを解放して現在のスロットを維持する
      URL.revokeObjectURL(loaded.objectUrl);
      try { loaded.gifDecoder?.close?.(); } catch { /* デコーダーが既に閉じていれば何もしない */ }
      throw error;
    }
    // 新しい画像の準備完了後に古いリソースを解放して失敗時の表示を維持する
    if (previous.objectUrl) URL.revokeObjectURL(previous.objectUrl);
    try { previous.gifDecoder?.close?.(); } catch { /* デコーダーが既に閉じていれば何もしない */ }

    this.slots[index] = {
      texture: loaded.texture,
      name: file.name,
      objectUrl: loaded.objectUrl,
      isGif: loaded.isGif,
      gifDecoder: loaded.gifDecoder,
      gifCanvas: loaded.gifCanvas,
      gifFrameIndex: 0,
      gifFrameCount: loaded.gifFrameCount,
      gifNextAt: loaded.gifNextAt,
      gifDecoding: false,
      gifActiveUntil: 0,
      // 画像差し替え時も同じスロットの音声と表示補正は維持する
      audioBuffer: previous.audioBuffer,
      audioName: previous.audioName,
      audioStart: previous.audioStart,
      audioDuration: previous.audioDuration,
      scaleOffset: previous.scaleOffset,
      anchorXOffset: previous.anchorXOffset,
      anchorYOffset: previous.anchorYOffset,
    };
    this.refreshFitScales();
    const el = this.slotElements[index];
    el.classList.add("loaded");
    el.style.backgroundImage = `url(${loaded.preview})`;
    el.querySelector<HTMLElement>("[data-image]")!.textContent = `${loaded.isGif ? "GIF" : "IMG"} ${file.name.replace(/\.[^.]+$/, "").slice(0, 10)}`;
    if (this.activeSlot === index) {
      if (this.activeActor && !this.activeActor.destroyed) {
        this.activeActor.texture = loaded.texture;
        this.activeActor.visible = false;
      }
      if (this.ambientActor && !this.ambientActor.destroyed) {
        this.ambientActor.texture = loaded.texture;
        this.ambientActor.visible = false;
      }
      this.activeSlot = null;
      this.characterPresenceUntil = 0;
    }
    const latched = this.latchedActors.get(index);
    if (latched && !latched.destroyed) latched.texture = loaded.texture;
    this.persistentBackgroundCharacters.forEach((entry) => {
      if (entry.slot === index && !entry.sprite.destroyed) entry.sprite.texture = loaded.texture;
    });
    this.updateAssignTargets();
    this.logAction(`LOAD ${index + 1} ${file.name}${loaded.isGif ? ` / GIF DECODER ${loaded.gifFrameCount}F` : ""}`);
  }

  /** 操作対象のスロットを選択してパネル表示を更新する */
  private selectSlot(index: number, shouldLog = true): void {
    this.selectedSlot = index;
    this.slotElements.forEach((element, i) => element.classList.toggle("selected", i === index));
    if (shouldLog) this.logAction(`SELECT SLOT ${index + 1}`);
  }

  /** 指定スロットを前景アクターとして表示可能な状態へ切り替える */
  private activateSlot(index: number): boolean {
    const texture = this.slots[index].texture;
    if (!texture) return false;

    if (!this.activeActor) {
      this.activeActor = new Sprite(texture);
      this.activeActor.anchor.set(0.5);
      this.actorLayer.addChild(this.activeActor);
    } else if (this.activeActor.texture !== texture) {
      this.activeActor.texture = texture;
    }
    this.activeSlot = index;

    this.fitActor();
    this.activeActor.visible = true;
    return true;
  }

  /** 前景アクターを現在の基準位置とスケールへ合わせる */
  private fitActor(): void {
    if (!this.activeActor) return;
    const placement = this.getActorPlacement();
    this.activeActor.position.set(placement.x, placement.y);
    this.activeActor.scale.set(placement.scale);
  }

  /** 表示中またはラッチ中のGIFだけ次フレームへ進める */
  private updateAnimatedGifs(now: number): void {
    this.slots.forEach((slot, index) => {
      if (!slot.isGif || !slot.gifDecoder || !slot.gifCanvas || !slot.texture) return;
      const live = now <= (slot.gifActiveUntil ?? 0) || this.latchedCues.has(index);
      // 非表示GIFを止めて負荷を抑え同じデコーダーの並列decodeも防ぐ
      if (!live || slot.gifDecoding || now < (slot.gifNextAt ?? 0) || (slot.gifFrameCount ?? 1) < 2) return;

      slot.gifDecoding = true;
      const nextFrame = ((slot.gifFrameIndex ?? 0) + 1) % Math.max(1, slot.gifFrameCount ?? 1);
      void slot.gifDecoder.decode({ frameIndex: nextFrame, completeFramesOnly: true }).then(({ image }) => {
        const ctx = slot.gifCanvas!.getContext("2d", { alpha: true });
        if (ctx) {
          ctx.clearRect(0, 0, slot.gifCanvas!.width, slot.gifCanvas!.height);
          ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, slot.gifCanvas!.width, slot.gifCanvas!.height);
          // Canvasの内容変更をPixiJS側のGPUテクスチャへ通知する
          const source = slot.texture!.source as unknown as { update?: () => void };
          source.update?.();
        }
        slot.gifFrameIndex = nextFrame;
        slot.gifNextAt = performance.now() + getGifFrameDurationMs(image);
        image.close?.();
      }).catch((error) => {
        console.warn("GIF frame decode failed", error);
        slot.gifNextAt = performance.now() + 100;
      }).finally(() => {
        slot.gifDecoding = false;
      });
    });
  }

  /** ウィンドウサイズ変更後の座標とフィット率を更新する */
  private resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.refreshFitScales();
    this.fitActor();
    this.fitAmbient();
  }

  /** ライブ状態を一定間隔でHUDへ反映する */
  private updateHud(now: number): void {
    // テキストDOMを毎フレーム更新せず描画負荷を抑える
    if (now - this.lastHudUpdate < 80) return;
    this.lastHudUpdate = now;
    const position = this.clock.barBeat(now);
    const live = this.activeSlot === null ? "—" : String(this.activeSlot + 1);
    const mode = this.recorder.isRecording ? "REC 2 BARS" : this.recorder.isLooping ? "LOOP 2 BARS" : "LIVE";
    const auto = [...this.latchedCues.keys()].map((cue) => cue + 1).join(",") || "—";
    const target = this.transformFor(this.activeSlot ?? this.selectedSlot);
    const html = `<b>${this.clock.bpm.toFixed(2)} BPM</b><span>BAR ${position.bar} · BEAT ${position.beat}</span><span>Q ${this.quantize.toUpperCase()}</span><span>CUE ${live}</span><span>AUTO ${auto}</span><span>${mode}</span><span>SIZE ${Math.round(target.scale * 100)}%</span><span>POS ${Math.round(target.anchorX * 100)},${Math.round(target.anchorY * 100)}</span>`;
    // 内容が同じ場合はレイアウト再計算を発生させない
    if (html !== this.lastHudHtml) {
      this.lastHudHtml = html;
      this.hud.innerHTML = html;
    }
    this.beatPulse.style.setProperty("--phase", String(position.phase));
  }
}
