import assert from "node:assert/strict";
import test from "node:test";
import { ControllerCommandSender } from "../src/controller/ControllerCommandSender.ts";
import { ControllerCueTracker } from "../src/controller/ControllerCueTracker.ts";
import type { RemoteEnvelope } from "../src/app/remote/RemoteProtocol.ts";

test("Controller commandは送信成功時だけseqを単調増加させる", () => {
  const sent: RemoteEnvelope[] = [];
  const sender = new ControllerCommandSender((envelope) => {
    sent.push(envelope);
    return true;
  });
  assert.equal(sender.send({ type: "cue", cue: 1, state: "down" }), true);
  assert.equal(sender.send({ type: "cue", cue: 1, state: "up" }), true);
  assert.deepEqual(sent.map((envelope) => envelope.seq), [0, 1]);
});

test("Controller commandはpermissionで禁止された操作を送らない", () => {
  const sent: RemoteEnvelope[] = [];
  const sender = new ControllerCommandSender((envelope) => {
    sent.push(envelope);
    return true;
  });
  sender.setPermissions({ cue: true, tapSync: false, record: false, clear: false });
  assert.equal(sender.send({ type: "tap" }), false);
  assert.equal(sender.send({ type: "record" }), false);
  assert.equal(sender.send({ type: "clear" }), false);
  assert.equal(sent.length, 0);
});

test("pointercancel相当の解放とページ離脱時の全Cue解放を返す", () => {
  const tracker = new ControllerCueTracker();
  tracker.hold(10, 3);
  assert.equal(tracker.release(10), 3);
  tracker.hold(11, 1);
  tracker.hold(12, 3);
  assert.deepEqual(tracker.releaseAll(), [1, 3]);
  assert.deepEqual(tracker.releaseAll(), []);
});
