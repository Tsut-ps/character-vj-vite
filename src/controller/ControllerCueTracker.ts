/** pointerごとのCue保持を追跡して重複しないCue Up対象を返す */
export class ControllerCueTracker {
  private readonly pointers = new Map<number, number>();

  /** pointerとCueの保持関係を記録する */
  hold(pointerId: number, cue: number): void {
    this.pointers.set(pointerId, cue);
  }

  /** pointerを解放し同じCueの最後の保持ならCue番号を返す */
  release(pointerId: number): number | null {
    const cue = this.pointers.get(pointerId);
    if (cue === undefined) return null;
    this.pointers.delete(pointerId);
    return [...this.pointers.values()].includes(cue) ? null : cue;
  }

  /** 全pointerを解放して現在保持中のCueを重複なしで返す */
  releaseAll(): number[] {
    const cues = [...new Set(this.pointers.values())];
    this.pointers.clear();
    return cues;
  }
}
