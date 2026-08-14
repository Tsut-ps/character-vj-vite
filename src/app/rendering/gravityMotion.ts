interface GravityMotionInput {
  progress: number;
  startX: number;
  endX: number;
  startY: number;
  arcHeight: number;
  baseScale: number;
}

interface GravityMotion {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
}

/** GRAVITY演出の進捗を位置と伸縮と透明度へ変換する */
export function calculateGravityMotion(input: GravityMotionInput): GravityMotion {
  const { progress, startX, endX, startY, arcHeight, baseScale } = input;
  // 同じ放物線を時間変換してゆっくり上昇し素早く落下する重さを作る
  const risePower = 1.6;
  const fallPower = 0.72;
  const timeBias = 1.4783532205046865;
  const rising = Math.pow(Math.max(0, progress), risePower);
  const falling = timeBias * Math.pow(Math.max(0, 1 - progress), fallPower);
  const position = rising + falling > 0 ? rising / (rising + falling) : 1;
  const stretch = position < 0.5
    ? 0.012 * (position / 0.5)
    : Math.min(0.075, Math.pow((position - 0.5) / 0.5, 1.5) * 0.075);
  const alpha = progress < 0.1 ? progress / 0.1 : progress > 0.96 ? (1 - progress) / 0.04 : 1;
  return {
    x: startX + (endX - startX) * position,
    y: startY - 4 * arcHeight * position * (1 - position),
    rotation: (2 * position - 1) * 0.008,
    scaleX: baseScale * (1 - stretch * 0.22),
    scaleY: baseScale * (1 + stretch),
    alpha: Math.max(0, Math.min(1, alpha)),
  };
}
