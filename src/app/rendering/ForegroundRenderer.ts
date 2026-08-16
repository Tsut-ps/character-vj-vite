import { Container, Sprite, Texture } from "pixi.js";
import type { BeatClock } from "../BeatClock";
import { playEffect, type ActorPlacement, type EffectHost } from "../effects";
import type { SlotStore } from "../media/SlotStore";
import { AnimationScheduler } from "../services/AnimationScheduler";
import type { EffectId } from "../types";
import { calculateGravityMotion } from "./gravityMotion";

interface LaneLayout {
  column: number;
  count: number;
}

/** 前景アクターと一時FXと演出アニメーションを管理する */
export class ForegroundRenderer implements EffectHost {
  readonly root: Container;
  readonly actorLayer = new Container();
  readonly fxLayer = new Container();
  readonly secretLayer = new Container();

  width = 1280;
  height = 720;

  private actor: Sprite | null = null;
  private selectedSlot = 0;
  private activeSlotValue: number | null = null;
  private presenceUntilValue = 0;
  private resetGeneration = 0;
  private fxPool: Sprite[] = [];
  private animation = new AnimationScheduler();
  private readonly flashScreen: (amount: number) => void;
  private readonly slots: SlotStore;
  private readonly clock: BeatClock;

  /** 描画ルートと素材と拍クロックと画面発光処理を受け取る */
  constructor(
    root: Container,
    slots: SlotStore,
    clock: BeatClock,
    flashScreen: (amount: number) => void,
  ) {
    this.root = root;
    this.slots = slots;
    this.clock = clock;
    this.flashScreen = flashScreen;
  }

  /** 現在表示対象になっているスロット番号を返す */
  get activeSlot(): number | null {
    return this.activeSlotValue;
  }

  /** 背景表示を継続する期限を返す */
  get presenceUntil(): number {
    return this.presenceUntilValue;
  }

  /** 操作対象のスロット番号を更新する */
  selectSlot(index: number): void {
    this.selectedSlot = index;
  }

  /** 描画領域を更新して前景アクターを再配置する */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.fitActor();
  }

  /** 現在の変形値で前景アクターを再配置する */
  fit(): void {
    this.fitActor();
  }

  /** 指定スロットを通常演出として再生する */
  playCue(index: number, effect: EffectId, strength = 1): boolean {
    if (!this.activateSlot(index)) return false;
    playEffect(effect, this, strength);
    this.presenceUntilValue = performance.now() + 720;
    return true;
  }

  /** 9番のGRAVITY演出を指定スロットで再生する */
  playSecret(slot: number, lane?: LaneLayout): boolean {
    const texture = this.slots.get(slot).texture;
    if (!texture) return false;
    // 9番連打で同時スプライトが増え続けないよう以前の上限を維持する
    if (this.secretLayer.children.length >= 12) return false;
    this.activeSlotValue = slot;
    const sprite = this.acquireFxSprite(texture);
    // 9番演出を通常アクターやラッチ列や他の演出より常に前面へ出す
    this.secretLayer.addChild(sprite);
    const transform = this.slots.transformFor(slot);
    const fit = this.slots.fitScaleFor(slot);
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
    this.slots.activateGif(slot, start + duration + 100);
    this.presenceUntilValue = Math.max(this.presenceUntilValue, start + duration);
    this.animate(duration, (progress) => {
      const motion = calculateGravityMotion({ progress, startX, endX, startY, arcHeight, baseScale });
      sprite.position.set(motion.x, motion.y);
      sprite.rotation = motion.rotation;
      sprite.scale.set(motion.scaleX, motion.scaleY);
      sprite.alpha = motion.alpha;
    }, () => this.releaseFxSprite(sprite), () => !sprite.destroyed);
    return true;
  }

  /** 時間ベースのアニメーションと表示期限を現在時刻まで進める */
  update(now: number): void {
    this.animation.update(now);
    if (this.actor && now > this.presenceUntilValue) this.actor.visible = false;
  }

  /** 再割り当てされた画像を表示中の前景へ反映して非表示に戻す */
  refreshSlot(index: number): void {
    // プール内Spriteが差し替え前Textureを参照し続けないよう割り当て時だけ作り直す
    for (const sprite of this.fxPool) {
      if (!sprite.destroyed) sprite.destroy();
    }
    this.fxPool = [];
    if (this.activeSlotValue !== index) return;
    const texture = this.slots.get(index).texture;
    if (texture && this.actor && !this.actor.destroyed) this.actor.texture = texture;
    if (this.actor) this.actor.visible = false;
    this.activeSlotValue = null;
    this.presenceUntilValue = 0;
  }

  /** 前景と一時FXと進行中アニメーションを初期化する */
  clear(): void {
    this.resetGeneration += 1;
    this.animation.clear();
    this.presenceUntilValue = 0;
    if (this.actor) this.actor.visible = false;
    this.activeSlotValue = null;
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
    this.root.position.set(0, 0);
  }

  /** 所有するアニメーションとPixiリソースを破棄する */
  destroy(): void {
    this.clear();
    for (const sprite of this.fxPool) {
      if (!sprite.destroyed) sprite.destroy();
    }
    this.fxPool = [];
    this.actorLayer.destroy({ children: true });
    this.fxLayer.destroy({ children: true });
    this.secretLayer.destroy({ children: true });
    this.actor = null;
  }

  /** 演出対象のアクターを返す */
  getCharacter(): Sprite | null {
    return this.actor;
  }

  /** 非同期演出を無効化するためのリセット世代を返す */
  getResetGeneration(): number {
    return this.resetGeneration;
  }

  /** 現在アクターの画面座標と表示スケールを返す */
  getActorPlacement(): ActorPlacement {
    const index = this.activeSlotValue ?? this.selectedSlot;
    const transform = this.slots.transformFor(index);
    return {
      x: this.width * transform.anchorX,
      y: this.height * transform.anchorY,
      scale: this.slots.fitScaleFor(index) * transform.scale,
    };
  }

  /** 残像用に現在キャラクターのスプライトを借りて配置する */
  cloneCharacter(alpha = 1): Sprite | null {
    if (this.activeSlotValue === null) return null;
    // SPAM/GHOSTの連打でも残像数を予測可能にし、長いフレーム落ちを防ぐ
    if (this.fxLayer.children.length >= 40) return null;
    const texture = this.slots.get(this.activeSlotValue).texture;
    if (!texture) return null;
    const sprite = this.acquireFxSprite(texture);
    const placement = this.getActorPlacement();
    sprite.position.set(placement.x, placement.y);
    sprite.scale.set(placement.scale);
    sprite.alpha = alpha;
    return sprite;
  }

  /** スプライトを拡大しながらフェードさせて残像として解放する */
  addAfterimage(sprite: Sprite, lifetimeMs: number): void {
    const initialAlpha = sprite.alpha;
    const initialScaleX = sprite.scale.x;
    const initialScaleY = sprite.scale.y;
    this.animate(lifetimeMs, (progress) => {
      sprite.alpha = initialAlpha * (1 - progress);
      const grow = 1 + progress * 0.06;
      sprite.scale.set(initialScaleX * grow, initialScaleY * grow);
    }, () => this.releaseFxSprite(sprite), () => !sprite.destroyed);
  }

  /** 毎フレーム更新する時間ベースのアニメーションを登録する */
  animate(
    duration: number,
    update: (progress: number) => void,
    complete?: () => void,
    isActive: () => boolean = () => true,
  ): void {
    this.animation.animate(duration, update, complete, isActive);
  }

  /** 後から一括解除できる遅延処理を登録する */
  schedule(callback: () => void, delayMs: number): void {
    this.animation.schedule(callback, delayMs);
  }

  /** ルート全体へ減衰するランダム揺れを加える */
  shake(amount: number, durationMs: number): void {
    const generation = this.resetGeneration;
    this.animate(durationMs, (progress) => {
      const power = amount * (1 - progress);
      this.root.position.set((Math.random() - 0.5) * power, (Math.random() - 0.5) * power);
    }, () => this.root.position.set(0, 0), () => generation === this.resetGeneration);
  }

  /** 画面全体を発光させる */
  flash(amount = 0.55): void {
    this.flashScreen(amount);
  }

  /** 指定スロットを前景アクターとして表示可能な状態へ切り替える */
  private activateSlot(index: number): boolean {
    const texture = this.slots.get(index).texture;
    if (!texture) return false;
    if (!this.actor) {
      this.actor = new Sprite(texture);
      this.actor.anchor.set(0.5);
      this.actorLayer.addChild(this.actor);
    } else if (this.actor.texture !== texture) {
      this.actor.texture = texture;
    }
    this.activeSlotValue = index;
    this.fitActor();
    this.actor.visible = true;
    return true;
  }

  /** 前景アクターを現在の基準位置とスケールへ合わせる */
  private fitActor(): void {
    if (!this.actor) return;
    const placement = this.getActorPlacement();
    this.actor.position.set(placement.x, placement.y);
    this.actor.scale.set(placement.scale);
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
}
