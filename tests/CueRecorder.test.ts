import assert from "node:assert/strict";
import test from "node:test";
import { CueRecorder } from "../src/app/services/CueRecorder.ts";

// 録音位置がループ開始後の同じ相対拍で再生されることを確認する
test("録音イベントを同じ相対拍でループ再生する", () => {
  const recorder = new CueRecorder(8);
  recorder.start(10);
  recorder.record(2, 10.5, 0.8);
  recorder.stop(18);
  assert.deepEqual(recorder.collectDueEvents(18.49), []);
  assert.deepEqual(recorder.collectDueEvents(18.5), [{ cue: 2, beat: 0.5, strength: 0.8 }]);
});

// フレーム落ちで複数周期を跨いでも各周期のイベントを失わないことを確認する
test("複数ループを跨いだイベントをすべて返す", () => {
  const recorder = new CueRecorder(8);
  recorder.start(10);
  recorder.record(1, 10.5);
  recorder.stop(18);
  assert.equal(recorder.collectDueEvents(34.5).length, 3);
});

// 規定拍へ到達した録音だけが自動終了することを確認する
test("規定拍数で録音を自動終了する", () => {
  const recorder = new CueRecorder(8);
  recorder.start(4);
  recorder.record(0, 5);
  assert.equal(recorder.finishIfNeeded(11.99), false);
  assert.equal(recorder.finishIfNeeded(12), true);
  assert.equal(recorder.isRecording, false);
  assert.equal(recorder.isLooping, true);
});

// クリア後に録音や旧ループイベントが残らないことを確認する
test("clearですべての録音状態を破棄する", () => {
  const recorder = new CueRecorder(8);
  recorder.start(0);
  recorder.record(3, 1);
  recorder.stop(8);
  recorder.clear(9);
  assert.equal(recorder.isRecording, false);
  assert.equal(recorder.isLooping, false);
  assert.deepEqual(recorder.collectDueEvents(20), []);
});
