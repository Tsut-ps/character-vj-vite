import assert from "node:assert/strict";
import test from "node:test";
import { calculateGravityMotion } from "../src/app/rendering/gravityMotion.ts";

const baseInput = {
  startX: 100,
  endX: 200,
  startY: 300,
  arcHeight: 80,
  baseScale: 2,
};

// 演出開始時に指定した開始位置と透明状態を返すことを確認する
test("GRAVITY演出の開始状態を計算する", () => {
  const motion = calculateGravityMotion({ ...baseInput, progress: 0 });
  assert.equal(motion.x, 100);
  assert.equal(motion.y, 300);
  assert.equal(motion.alpha, 0);
});

// 演出途中でキャラクターが放物線の上側へ移動することを確認する
test("GRAVITY演出の途中で上昇する", () => {
  const motion = calculateGravityMotion({ ...baseInput, progress: 0.5 });
  assert.ok(motion.x > 100 && motion.x < 200);
  assert.ok(motion.y < 300);
  assert.equal(motion.alpha, 1);
});

// 演出終了時に終点へ戻り透明になることを確認する
test("GRAVITY演出の終了状態を計算する", () => {
  const motion = calculateGravityMotion({ ...baseInput, progress: 1 });
  assert.equal(motion.x, 200);
  assert.equal(motion.y, 300);
  assert.equal(motion.alpha, 0);
});
