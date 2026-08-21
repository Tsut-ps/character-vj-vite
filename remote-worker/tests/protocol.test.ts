import { describe, expect, it } from "vitest";
import {
  controllerMessageSchema,
  hostMessageSchema,
  isCommandAllowed,
  parseJsonCandidate,
  payloadWithinLimit,
  sequenceIsFresh,
  SESSION_TICKET_TTL_MS,
} from "../src/protocol";
import { checkCommandRate } from "../src/rateLimit";

describe("remote protocol security", () => {
  it("session上限を1時間に固定する", () => {
    expect(SESSION_TICKET_TTL_MS).toBe(60 * 60 * 1000);
  });
  it("controllerによるhost commandとrole偽装を拒否する", () => {
    const requestId = crypto.randomUUID();
    expect(controllerMessageSchema.safeParse({ v: 1, type: "openJoin", requestId }).success).toBe(false);
    expect(controllerMessageSchema.safeParse({
      v: 1,
      seq: 1,
      role: "host",
      command: { type: "cue", cue: 1, state: "down" },
    }).success).toBe(false);
    expect(hostMessageSchema.safeParse({ v: 1, type: "openJoin", requestId }).success).toBe(true);
  });

  it("malformed JSONとoversized payloadを拒否する", () => {
    expect(parseJsonCandidate("{")).toBeNull();
    expect(payloadWithinLimit(JSON.stringify({ v: 1, seq: 1, command: { type: "tap" } }))).toBe(true);
    expect(payloadWithinLimit("x".repeat(1025))).toBe(false);
  });

  it("unknown command、unknown version、cue範囲外を拒否する", () => {
    expect(controllerMessageSchema.safeParse({ v: 1, seq: 1, command: { type: "unknown" } }).success).toBe(false);
    expect(controllerMessageSchema.safeParse({ v: 2, seq: 1, command: { type: "tap" } }).success).toBe(false);
    expect(controllerMessageSchema.safeParse({ v: 1, seq: 1, command: { type: "cue", cue: 0, state: "down" } }).success).toBe(false);
    expect(controllerMessageSchema.safeParse({ v: 1, seq: 1, command: { type: "cue", cue: 10, state: "down" } }).success).toBe(false);
  });

  it("seq replayとrollbackを拒否する", () => {
    expect(sequenceIsFresh(12, 11)).toBe(true);
    expect(sequenceIsFresh(11, 11)).toBe(false);
    expect(sequenceIsFresh(10, 11)).toBe(false);
  });

  it("controller単位rate limitを60 msg/secへ制限する", () => {
    let state = { rateStartedAt: 1000, rateCount: 0 };
    for (let index = 0; index < 60; index += 1) {
      const result = checkCommandRate(state, 1000);
      state = result.state;
      expect(result.allowed).toBe(true);
    }
    expect(checkCommandRate(state, 1000).allowed).toBe(false);
    expect(checkCommandRate(state, 2000).allowed).toBe(true);
  });

  it("長いrate窓もtimerなしで更新する", () => {
    let state = { rateStartedAt: 1000, rateCount: 0 };
    for (let index = 0; index < 30; index += 1) state = checkCommandRate(state, 1000, 30, 60_000).state;
    expect(checkCommandRate(state, 59_000, 30, 60_000).allowed).toBe(false);
    expect(checkCommandRate(state, 61_000, 30, 60_000).allowed).toBe(true);
  });

  it("permission違反をcommand種別ごとに拒否する", () => {
    const permissions = { cue: true, tapSync: false, record: false, clear: false };
    expect(isCommandAllowed({ type: "cue", cue: 9, state: "down" }, permissions)).toBe(true);
    expect(isCommandAllowed({ type: "tap" }, permissions)).toBe(false);
    expect(isCommandAllowed({ type: "sync" }, permissions)).toBe(false);
    expect(isCommandAllowed({ type: "record" }, permissions)).toBe(false);
    expect(isCommandAllowed({ type: "clear" }, permissions)).toBe(false);
  });
});
