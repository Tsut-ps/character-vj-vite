import assert from "node:assert/strict";
import test from "node:test";
import { BeatClock } from "../src/app/BeatClock.ts";

// BPMと遅延補正が操作可能範囲を越えないことを確認する
test("BPMと遅延補正を許容範囲へ制限する", () => {
  const clock = new BeatClock();
  clock.setBpm(500);
  assert.equal(clock.bpm, 300);
  clock.setBpm(10);
  assert.equal(clock.bpm, 30);
  clock.setOffsetMs(500);
  assert.equal(clock.offsetMs, 300);
  clock.setOffsetMs(-500);
  assert.equal(clock.offsetMs, -300);
});

// 同期時刻が遅延補正を含めても拍頭になることを確認する
test("syncした時刻を拍頭として扱う", () => {
  const clock = new BeatClock();
  clock.setOffsetMs(100);
  clock.sync(1000);
  assert.equal(clock.beatAt(1000), 0);
  assert.equal(clock.phase(1000), 0);
});

// 境界上の入力が次の境界へ進み二重発火を避けることを確認する
test("クオンタイズ境界上では次の境界を返す", () => {
  const clock = new BeatClock();
  clock.setBpm(120);
  clock.sync(1000);
  assert.equal(clock.nextBoundary(1125, "off"), 1125);
  assert.equal(clock.nextBoundary(1125, "1/4"), 1250);
  assert.equal(clock.nextBoundary(1125, "1/8"), 1187.5);
});

// 500ms間隔のタップが120 BPMとして推定されることを確認する
test("タップ間隔からBPMを推定する", () => {
  const clock = new BeatClock();
  clock.tap(1000);
  const bpm = clock.tap(1500);
  assert.equal(bpm, 120);
});
