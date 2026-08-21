import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalControllerClose,
  REMOTE_INITIAL_CONNECT_MAX_MS,
  REMOTE_SESSION_MAX_MS,
  remoteInitialConnectTimeoutMs,
  remoteSessionTimeoutMs,
} from "../src/app/remote/RemoteProtocol.ts";

test("二重接続と期限切れのclose codeでは再接続を止める", () => {
  assert.equal(isTerminalControllerClose(4002), true);
  assert.equal(isTerminalControllerClose(4003), true);
  assert.equal(isTerminalControllerClose(4401), true);
  assert.equal(isTerminalControllerClose(4429), true);
  assert.equal(isTerminalControllerClose(1006), false);
});

test("client時計が遅れていても再接続を1時間で止める", () => {
  assert.equal(remoteSessionTimeoutMs(10 * REMOTE_SESSION_MAX_MS, 0), REMOTE_SESSION_MAX_MS);
  assert.equal(remoteSessionTimeoutMs(999, 1000), 0);
});

test("初回readyが届かなければ1分で再接続を止める", () => {
  assert.equal(remoteInitialConnectTimeoutMs(10 * REMOTE_INITIAL_CONNECT_MAX_MS, 0), REMOTE_INITIAL_CONNECT_MAX_MS);
  assert.equal(remoteInitialConnectTimeoutMs(999, 1000), 0);
});
