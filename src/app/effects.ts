import { Container, Sprite } from "pixi.js";
import type { EffectId } from "./types";

export interface ActorPlacement {
  x: number;
  y: number;
  scale: number;
}

export interface EffectHost {
  root: Container;
  actorLayer: Container;
  fxLayer: Container;
  width: number;
  height: number;
  /** 現在の演出対象を返す */
  getCharacter(): Sprite | null;
  /** 演出対象の基準配置を返す */
  getActorPlacement(): ActorPlacement;
  /** 残像用のキャラクターを複製する */
  cloneCharacter(alpha?: number): Sprite | null;
  /** 複製したキャラクターを残像として消す */
  addAfterimage(sprite: Sprite, lifetimeMs: number): void;
  /** 時間ベースの演出更新を登録する */
  animate(duration: number, update: (t: number) => void, complete?: () => void, isActive?: () => boolean): void;
  /** 遅延処理を登録する */
  schedule(callback: () => void, delayMs: number): void;
  /** 画面全体を揺らす */
  shake(amount: number, durationMs: number): void;
  /** 画面全体を発光させる */
  flash(amount?: number): void;
  /** 現在のリセット世代を返す */
  getResetGeneration(): number;
}

/** 終端を少し超えて戻るイージング値を返す */
const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** 終端へ素早く収束するイージング値を返す */
const easeOutExpo = (t: number): number => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** 前の演出状態を残さずアクターを基準配置へ戻す */
const resetActor = (actor: Sprite, host: EffectHost): ActorPlacement => {
  const placement = host.getActorPlacement();
  actor.position.set(placement.x, placement.y);
  actor.rotation = 0;
  actor.scale.set(placement.scale);
  actor.alpha = 1;
  actor.visible = true;
  return placement;
};

/** 指定した演出を現在のアクターへ適用する */
export function playEffect(effect: EffectId, host: EffectHost, strength = 1): void {
  const actor = host.getCharacter();
  if (!actor) return;
  const resetGeneration = host.getResetGeneration();
  // Enter後に古い非同期演出がアクターを再変更しないよう世代で無効化する
  const isActive = () => host.getResetGeneration() === resetGeneration;
  const placement = resetActor(actor, host);
  const baseScale = placement.scale;
  const anchorX = placement.x;
  const anchorY = placement.y;
  const direction = Math.random() < 0.5 ? -1 : 1;

  switch (effect) {
    case "pop": {
      actor.alpha = 0;
      actor.scale.set(baseScale * 0.25, baseScale * 0.12);
      const startY = Math.min(host.height * 0.88, anchorY + host.height * 0.22);
      actor.y = startY;
      host.animate(420, (t) => {
        const e = easeOutBack(t);
        actor.alpha = Math.min(1, t * 5);
        actor.scale.set(baseScale * (0.25 + 0.75 * e), baseScale * (0.12 + 0.88 * e));
        actor.y = startY + (anchorY - startY) * easeOutExpo(t);
        actor.x = anchorX;
        actor.rotation = direction * (1 - t) * 0.08;
      }, undefined, isActive);
      break;
    }
    case "rush": {
      const startX = direction < 0 ? -host.width * 0.4 : host.width * 1.4;
      actor.x = startX;
      actor.y = anchorY;
      actor.scale.set(baseScale);
      // 短い時間差で残像を置き高速移動の方向を読みやすくする
      for (let i = 0; i < 5; i += 1) {
        host.schedule(() => {
          if (!isActive()) return;
          const ghost = host.cloneCharacter(0.28 - i * 0.035);
          if (!ghost) return;
          ghost.scale.set(baseScale * (1 + i * 0.03));
          ghost.x = startX + direction * -i * host.width * 0.05;
          ghost.y = anchorY + (Math.random() - 0.5) * host.height * 0.08;
          host.addAfterimage(ghost, 260 + i * 35);
        }, i * 25);
      }
      host.animate(250, (t) => {
        actor.x = startX + (anchorX - startX) * easeOutExpo(t);
        actor.y = anchorY;
        actor.rotation = direction * (1 - t) * 0.18;
      }, undefined, isActive);
      break;
    }
    case "ghost": {
      actor.scale.set(baseScale);
      for (let i = 0; i < 7; i += 1) {
        host.schedule(() => {
          if (!isActive()) return;
          const ghost = host.cloneCharacter(0.34);
          if (!ghost) return;
          ghost.scale.set(baseScale * (0.98 + Math.random() * 0.08));
          ghost.x = anchorX + direction * (35 + i * 24);
          ghost.y = anchorY + Math.sin(i * 1.4) * 28;
          ghost.rotation = (Math.random() - 0.5) * 0.08;
          host.addAfterimage(ghost, 520 - i * 28);
        }, i * 38);
      }
      host.animate(520, (t) => {
        actor.x = anchorX + Math.sin(t * Math.PI * 5) * 14 * (1 - t);
        actor.y = anchorY + Math.sin(t * Math.PI * 2) * 18;
      }, undefined, isActive);
      break;
    }
    case "impact": {
      actor.scale.set(baseScale * 0.72);
      host.flash(0.75);
      host.shake(22 * strength, 260);
      host.animate(260, (t) => {
        const punch = Math.sin(Math.min(1, t * 2.1) * Math.PI) * (1 - t);
        actor.position.set(anchorX, anchorY);
        actor.scale.set(baseScale * (1 + 0.28 * punch));
        actor.rotation = direction * punch * 0.035;
      }, undefined, isActive);
      break;
    }
    case "flip": {
      actor.scale.set(baseScale);
      const flips = 8;
      host.animate(520, (t) => {
        const step = Math.min(flips - 1, Math.floor(t * flips));
        // スケールの符号反転で追加テクスチャなしに表裏感を作る
        const sx = step % 2 === 0 ? 1 : -1;
        const sy = step % 4 < 2 ? 1 : -1;
        actor.scale.set(baseScale * sx, baseScale * sy);
        actor.x = anchorX + Math.sin(step * 2.1) * host.width * 0.08;
        actor.y = anchorY + Math.cos(step * 1.7) * host.height * 0.06;
      }, () => actor.scale.set(baseScale), isActive);
      break;
    }
    case "jump": {
      actor.scale.set(baseScale);
      host.animate(460, (t) => {
        const hops = Math.abs(Math.sin(t * Math.PI * 4));
        actor.x = anchorX;
        actor.y = anchorY - hops * host.height * 0.18 * (0.55 + 0.45 * (1 - t));
        actor.scale.set(baseScale * (1 + 0.08 * hops), baseScale * (1 - 0.08 * hops));
      }, () => {
        actor.position.set(anchorX, anchorY);
        actor.scale.set(baseScale);
      }, isActive);
      break;
    }
    case "spam": {
      actor.position.set(anchorX, anchorY);
      actor.scale.set(baseScale * 0.82);
      const count = 12;
      for (let i = 0; i < count; i += 1) {
        host.schedule(() => {
          if (!isActive()) return;
          const clone = host.cloneCharacter(0.88);
          if (!clone) return;
          const side = i % 2 === 0 ? -1 : 1;
          const sx = baseScale * (0.35 + Math.random() * 0.55);
          const sy = baseScale * (0.35 + Math.random() * 0.55);
          clone.scale.set(sx * (Math.random() < 0.4 ? -1 : 1), sy);
          clone.x = host.width * (0.5 + side * (0.12 + Math.random() * 0.36));
          clone.y = host.height * (0.18 + Math.random() * 0.64);
          clone.rotation = (Math.random() - 0.5) * 0.5;
          host.addAfterimage(clone, 180 + Math.random() * 260);
        }, i * 42);
      }
      host.shake(7 * strength, 480);
      break;
    }
    case "chaos": {
      const pool: EffectId[] = ["rush", "ghost", "impact", "flip", "jump", "spam"];
      const first = pool[Math.floor(Math.random() * pool.length)];
      let second = pool[Math.floor(Math.random() * pool.length)];
      // 同じ演出の重複で変化が消えないよう2個目を差し替える
      if (second === first) second = "impact";
      playEffect(first, host, strength * 0.85);
      host.schedule(() => {
        if (isActive()) playEffect(second, host, strength * 0.75);
      }, 145);
      break;
    }
  }
}
