import assert from "node:assert/strict";
import test from "node:test";
import { calculateLatchedMotion, type LatchedMotionInput } from "../src/app/rendering/latchedMotion.ts";

const baseInput: LatchedMotionInput = {
  cue: 0,
  phase: 0,
  wholeBeat: 0,
  baseScale: 2,
  width: 1000,
  height: 500,
  column: 0,
  count: 2,
  anchorX: 0.5,
  anchorY: 0.5,
};

// 列数とアンカーから演出の基準位置が決まることを確認する
test("ラッチ列の基準位置を計算する", () => {
  const motion = calculateLatchedMotion({ ...baseInput, cue: 3, phase: 0 });
  assert.equal(motion.x, 250);
  assert.equal(motion.y, 250);
});

// GHOSTだけが拍位相に応じた透明度を返すことを確認する
test("GHOSTの透明度を拍位相から計算する", () => {
  const motion = calculateLatchedMotion({ ...baseInput, cue: 2, phase: 0.25 });
  assert.equal(motion.alpha, 0.94);
});

// FLIPの段階切り替えで横スケールの符号が反転することを確認する
test("FLIPの横向きを段階的に反転する", () => {
  const normal = calculateLatchedMotion({ ...baseInput, cue: 4, phase: 0 });
  const flipped = calculateLatchedMotion({ ...baseInput, cue: 4, phase: 0.125 });
  assert.equal(normal.scaleX, 2);
  assert.equal(flipped.scaleX, -2);
});
