import { Container, Graphics, Sprite } from "pixi.js";
import type { BeatClock } from "../BeatClock";
import type { SlotStore } from "../media/SlotStore";

interface BackgroundCharacter {
  sprite: Sprite;
  slot: number;
  seed: number;
  size: number;
  flip: number;
  alpha: number;
}

/** 背景と常駐キャラクターとラッチ列のPixi描画を管理する */
export class StageRenderer {
  readonly ambientLayer = new Container();
  readonly backgroundLayer = new Container();
  readonly latchedLayer = new Container();

  private width = 1280;
  private height = 720;
  private ambientActor: Sprite | null = null;
  private latchedActors = new Map<number, Sprite>();
  private backgroundShapes: Graphics[] = [];
  private backgroundCharacters: BackgroundCharacter[] = [];
  private backgroundCharacterPool: Sprite[] = [];
  private readonly slots: SlotStore;
  private readonly clock: BeatClock;

  /** 素材ストアと拍クロックを受け取り背景図形を準備する */
  constructor(slots: SlotStore, clock: BeatClock) {
    this.slots = slots;
    this.clock = clock;
    this.createBackground();
  }

  /** 描画領域を更新して背景アクターを再配置する */
  resize(width: number, height: number, activeSlot: number | null): void {
    this.width = width;
    this.height = height;
    this.fitAmbient(activeSlot);
  }

  /** 背景図形レイヤーの表示状態を切り替える */
  setBackgroundVisible(visible: boolean): void {
    this.backgroundLayer.visible = visible;
  }

  /** 背景へ薄く表示するキャラクターを指定スロットへ切り替える */
  setAmbientSlot(index: number): void {
    const texture = this.slots.get(index).texture;
    if (!texture) return;
    if (!this.ambientActor) {
      this.ambientActor = new Sprite(texture);
      this.ambientActor.anchor.set(0.5);
      this.ambientLayer.addChild(this.ambientActor);
    } else if (this.ambientActor.texture !== texture) {
      this.ambientActor.texture = texture;
    }
    this.fitAmbient(index);
  }

  /** 指定キャラクターの小さな背景コピーを2体追加する */
  seedBackgroundCharacters(index: number): void {
    const texture = this.slots.get(index).texture;
    if (!texture) return;
    for (let i = 0; i < 2; i += 1) {
      // 長時間の連打でも個数が増えないよう古い要素を循環利用する
      let entry = this.backgroundCharacters.length >= 24
        ? this.backgroundCharacters.shift()
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
      this.backgroundCharacters.push(entry);
    }
  }

  /** ラッチ表示スプライトの有無をキュー状態へ合わせる */
  setLatchVisual(cue: number, active: boolean): void {
    const current = this.latchedActors.get(cue);
    if (!active) {
      if (current && !current.destroyed) current.destroy();
      this.latchedActors.delete(cue);
      return;
    }
    if (cue === 8 || current) return;
    const texture = this.slots.get(cue)?.texture;
    if (!texture) return;
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.alpha = 0.96;
    this.latchedLayer.addChild(sprite);
    this.latchedActors.set(cue, sprite);
  }

  /** 背景と常駐キャラクターとラッチ列を現在時刻まで進める */
  update(now: number, activeSlot: number | null, presenceUntil: number, latchedCues: number[]): void {
    this.updateBackground(now);
    this.updateAmbient(now, activeSlot, presenceUntil);
    this.updateLatchedActors(now, latchedCues);
  }

  /** 画像再割り当てを関連する全スプライトへ反映する */
  refreshSlot(index: number, activeSlot: number | null): void {
    const texture = this.slots.get(index).texture;
    if (!texture) return;
    if (activeSlot === index && this.ambientActor && !this.ambientActor.destroyed) {
      this.ambientActor.texture = texture;
      this.ambientActor.visible = false;
    }
    const latched = this.latchedActors.get(index);
    if (latched && !latched.destroyed) latched.texture = texture;
    this.backgroundCharacters.forEach((entry) => {
      if (entry.slot === index && !entry.sprite.destroyed) entry.sprite.texture = texture;
    });
  }

  /** 背景アクターを現在スロットの変形へ合わせる */
  fitAmbient(activeSlot: number | null): void {
    if (!this.ambientActor || activeSlot === null) return;
    const transform = this.slots.transformFor(activeSlot);
    const scale = this.ambientBaseScale(activeSlot);
    this.ambientActor.position.set(this.width * transform.anchorX, this.height * transform.anchorY + this.height * 0.03);
    this.ambientActor.scale.set(scale);
  }

  /** 常駐キャラクターとラッチ表示を消して再利用プールを整理する */
  clear(): void {
    if (this.ambientActor) this.ambientActor.visible = false;
    for (const sprite of this.latchedActors.values()) {
      if (!sprite.destroyed) sprite.destroy();
    }
    this.latchedActors.clear();
    for (const entry of this.backgroundCharacters) {
      if (entry.sprite.destroyed) continue;
      entry.sprite.visible = false;
      entry.sprite.removeFromParent();
      // 背景キャラクターの上限と同じ数だけ再利用してメモリ増加を防ぐ
      if (this.backgroundCharacterPool.length < 24) this.backgroundCharacterPool.push(entry.sprite);
      else entry.sprite.destroy();
    }
    this.backgroundCharacters = [];
  }

  /** 所有するPixiリソースを破棄する */
  destroy(): void {
    this.clear();
    for (const sprite of this.backgroundCharacterPool) {
      if (!sprite.destroyed) sprite.destroy();
    }
    this.backgroundCharacterPool = [];
    this.ambientLayer.destroy({ children: true });
    this.backgroundLayer.destroy({ children: true });
    this.latchedLayer.destroy({ children: true });
    this.backgroundShapes = [];
    this.ambientActor = null;
  }

  /** 背景を構成する抽象図形を生成する */
  private createBackground(): void {
    for (let i = 0; i < 16; i += 1) {
      const shape = new Graphics();
      const size = 22 + (i % 5) * 18;
      if (i % 3 === 0) shape.circle(0, 0, size).stroke({ width: 3, color: 0xffffff, alpha: 0.15 });
      else shape.rect(-size, -size, size * 2, size * 2).stroke({ width: 2, color: 0xffffff, alpha: 0.11 });
      shape.rotation = i * 0.45;
      this.backgroundLayer.addChild(shape);
      this.backgroundShapes.push(shape);
    }
  }

  /** BPM位相に合わせて背景図形を移動させる */
  private updateBackground(now: number): void {
    if (!this.backgroundLayer.visible) return;
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

  /** 背景キャラクターを拍に合わせて漂わせる */
  private updateAmbient(now: number, activeSlot: number | null, presenceUntil: number): void {
    const beat = this.clock.beatAt(now);
    const phase = this.clock.phase(now);
    const pulse = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);
    this.backgroundCharacters.forEach((entry, index) => {
      const slot = this.slots.get(entry.slot);
      if (!slot.texture || entry.sprite.destroyed) return;
      if (entry.sprite.texture !== slot.texture) entry.sprite.texture = slot.texture;
      const fit = this.slots.fitScaleFor(entry.slot) * this.slots.transformFor(entry.slot).scale;
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
    const present = now <= presenceUntil;
    this.ambientActor.visible = present;
    if (!present || activeSlot === null) return;
    const transform = this.slots.transformFor(activeSlot);
    const base = this.ambientBaseScale(activeSlot);
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
  private updateLatchedActors(now: number, cues: number[]): void {
    const count = cues.length;
    if (!count) return;
    const beat = this.clock.beatAt(now);
    const phase = this.clock.phase(now);
    const wholeBeat = Math.floor(beat);
    cues.forEach((cue, column) => {
      if (cue === 8) return;
      const texture = this.slots.get(cue).texture;
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

      const fit = this.slots.fitScaleFor(cue);
      const transform = this.slots.transformFor(cue);
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
  private ambientBaseScale(activeSlot: number): number {
    const transform = this.slots.transformFor(activeSlot);
    // fitScaleの6%余白を一度戻してから背景用の82%へ揃える
    return (this.slots.fitScaleFor(activeSlot) / 0.94) * 0.82 * transform.scale;
  }
}
