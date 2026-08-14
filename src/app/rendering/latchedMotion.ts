export interface LatchedMotionInput {
  cue: number;
  phase: number;
  wholeBeat: number;
  baseScale: number;
  width: number;
  height: number;
  column: number;
  count: number;
  anchorX: number;
  anchorY: number;
}

export interface LatchedMotion {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  alpha: number;
}

/** キュー固有のラッチ演出を副作用のない表示値へ変換する */
export function calculateLatchedMotion(input: LatchedMotionInput): LatchedMotion {
  const {
    cue,
    phase,
    wholeBeat,
    baseScale,
    width,
    height,
    column,
    count,
    anchorX,
    anchorY,
  } = input;
  // ラッチ数で画面を等分し各キューの基準位置を独立させる
  const columnWidth = width / count;
  let x = width * ((column + 0.5) / count) + width * (anchorX - 0.5);
  let y = height * anchorY;
  let scaleX = baseScale;
  let scaleY = baseScale;
  let rotation = 0;
  let alpha = 0.96;
  const direction = (cue + wholeBeat) % 2 ? -1 : 1;

  if (cue === 0) {
    const progress = Math.min(1, phase * 2.15);
    const backStrength = 1.70158;
    const back = 1
      + (backStrength + 1) * Math.pow(progress - 1, 3)
      + backStrength * Math.pow(progress - 1, 2);
    scaleX *= 0.72 + 0.28 * back;
    scaleY *= 0.82 + 0.18 * back;
    y += height * 0.055 * (1 - (progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress)));
  } else if (cue === 1) {
    const progress = Math.min(1, phase * 3);
    const expo = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
    x += direction * (1 - expo) * columnWidth * 0.34;
    rotation = direction * (1 - phase) * 0.08;
  } else if (cue === 2) {
    x += Math.sin(phase * Math.PI * 4) * 12;
    y += Math.sin(phase * Math.PI * 2) * 18;
    alpha = 0.84 + Math.sin(phase * Math.PI * 2) * 0.1;
  } else if (cue === 3) {
    const hit = Math.exp(-phase * 8) * Math.sin(phase * Math.PI * 2);
    scaleX *= 1 + 0.24 * hit;
    scaleY *= 1 + 0.18 * hit;
  } else if (cue === 4) {
    const step = Math.floor(phase * 8);
    scaleX *= step % 2 ? -1 : 1;
    scaleY *= step % 4 < 2 ? 1 : -1;
    y += Math.cos(step * 1.7) * height * 0.018;
  } else if (cue === 5) {
    const hop = Math.sin(phase * Math.PI);
    y -= Math.max(0, hop) * height * 0.14;
    scaleX *= 1 + 0.06 * hop;
    scaleY *= 1 - 0.06 * hop;
  } else if (cue === 6) {
    scaleX *= 0.82 + 0.12 * Math.sin(phase * Math.PI * 6);
    scaleY *= 0.82 + 0.12 * Math.cos(phase * Math.PI * 6);
    x += Math.sin(phase * Math.PI * 8 + cue) * columnWidth * 0.08;
  } else if (cue === 7) {
    const step = Math.floor(phase * 8);
    scaleX *= step % 2 ? -1 : 1;
    y -= Math.abs(Math.sin(phase * Math.PI * 2)) * height * 0.08;
    x += Math.sin(phase * Math.PI * 6 + cue) * columnWidth * 0.08;
    rotation = Math.sin(phase * Math.PI * 4) * 0.12;
  }

  return { x, y, scaleX, scaleY, rotation, alpha };
}
