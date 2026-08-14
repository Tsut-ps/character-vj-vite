interface Tween {
  start: number;
  duration: number;
  update: (progress: number) => void;
  complete?: () => void;
  isActive: () => boolean;
}

/** 時間ベースのアニメーションと遅延処理を一元管理する */
export class AnimationScheduler {
  private tweens: Tween[] = [];
  private timers = new Set<number>();

  /** 毎フレーム更新するアニメーションを登録する */
  animate(
    duration: number,
    update: (progress: number) => void,
    complete?: () => void,
    isActive: () => boolean = () => true,
  ): void {
    this.tweens.push({
      start: performance.now(),
      duration: Math.max(1, duration),
      update,
      complete,
      isActive,
    });
  }

  /** 登録済みアニメーションを指定時刻まで進める */
  update(now: number): void {
    // 途中削除しても未処理要素の添字がずれないよう末尾から走査する
    for (let index = this.tweens.length - 1; index >= 0; index -= 1) {
      const tween = this.tweens[index];
      if (!tween.isActive()) {
        this.tweens.splice(index, 1);
        continue;
      }

      const progress = Math.min(1, (now - tween.start) / tween.duration);
      tween.update(progress);
      if (progress >= 1) {
        this.tweens.splice(index, 1);
        tween.complete?.();
      }
    }
  }

  /** 後から一括解除できる遅延処理を登録する */
  schedule(callback: () => void, delayMs: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, Math.max(0, delayMs));
    this.timers.add(timer);
  }

  /** 進行中のアニメーションと遅延処理をすべて破棄する */
  clear(): void {
    this.tweens = [];
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
  }
}
