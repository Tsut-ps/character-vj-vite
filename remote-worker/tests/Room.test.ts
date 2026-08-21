import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSecretToken, hashToken } from "../src/auth";
import type { Room } from "../src/Room";
import { MAX_CONTROLLER_SESSIONS } from "../src/protocol";

interface Fixture {
  roomId: string;
  hostToken: string;
  hostTicket: string;
  expiresAt: number;
  stub: DurableObjectStub<Room>;
}

/** 独立DOへhost tokenとticketを初期化する */
async function createFixture(): Promise<Fixture> {
  const roomId = crypto.randomUUID();
  const hostToken = createSecretToken();
  const hostTicket = createSecretToken();
  const expiresAt = Date.now() + 60_000;
  const stub = env.Room.getByName(roomId);
  const initialized = await stub.initializeRoom(
    await hashToken(hostToken),
    await hashToken(hostTicket),
    expiresAt,
  );
  expect(initialized).toBe(true);
  return { roomId, hostToken, hostTicket, expiresAt, stub };
}

/** test専用にjoin stateを直接設定してsecret lifecycleを検証可能にする */
async function setJoin(stub: DurableObjectStub<Room>, open: boolean, secret?: string): Promise<void> {
  const secretHash = secret ? await hashToken(secret) : null;
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE room_state SET join_open = ?, join_secret_hash = ? WHERE singleton = 1",
      open ? 1 : 0,
      secretHash,
    );
  });
}

describe("Room secret and ticket lifecycle", () => {
  it("joinOpen=falseでJOINを拒否する", async () => {
    const fixture = await createFixture();
    const result = await fixture.stub.joinWithSecret(createSecretToken(), await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
  });

  it("間違ったjoinSecretを拒否する", async () => {
    const fixture = await createFixture();
    await setJoin(fixture.stub, true, createSecretToken());
    const result = await fixture.stub.joinWithSecret(createSecretToken(), await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
  });

  it("secretローテーション後に古いQRを拒否する", async () => {
    const fixture = await createFixture();
    const oldSecret = createSecretToken();
    const newSecret = createSecretToken();
    await setJoin(fixture.stub, true, oldSecret);
    await setJoin(fixture.stub, true, newSecret);
    const oldResult = await fixture.stub.joinWithSecret(oldSecret, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    const newResult = await fixture.stub.joinWithSecret(newSecret, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(oldResult.ok).toBe(false);
    expect(newResult.ok).toBe(true);
  });

  it("QR CLOSE後の新規JOINを拒否する", async () => {
    const fixture = await createFixture();
    const secret = createSecretToken();
    await setJoin(fixture.stub, true, secret);
    await setJoin(fixture.stub, false);
    const result = await fixture.stub.joinWithSecret(secret, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
  });

  it("session ticketなしと別room token流用を拒否する", async () => {
    const first = await createFixture();
    const second = await createFixture();
    expect((await first.stub.authorizeWebSocket("")).ok).toBe(false);
    expect((await second.stub.authorizeWebSocket(first.hostTicket)).ok).toBe(false);
    const authorized = await first.stub.authorizeWebSocket(first.hostTicket);
    expect(authorized.role).toBe("host");
    expect(authorized.expiresAt).toBe(first.expiresAt);
  });

  it("host tokenとjoin secretを混同しない", async () => {
    const fixture = await createFixture();
    await setJoin(fixture.stub, true, createSecretToken());
    const result = await fixture.stub.joinWithSecret(fixture.hostToken, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
  });

  it("host ticket再発行時に古いticketを無効化する", async () => {
    const fixture = await createFixture();
    const nextTicket = createSecretToken();
    const created = await fixture.stub.createHostTicket(
      fixture.hostToken,
      await hashToken(nextTicket),
      Date.now() + 60_000,
    );
    expect(created).toBe(true);
    expect((await fixture.stub.authorizeWebSocket(fixture.hostTicket)).ok).toBe(false);
    expect((await fixture.stub.authorizeWebSocket(nextTicket)).role).toBe("host");
  });

  it("未初期化roomへの試行で永続stateを作らない", async () => {
    const stub = env.Room.getByName(crypto.randomUUID());
    const result = await stub.joinWithSecret(createSecretToken(), await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result.ok).toBe(false);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("initialized")).toBeUndefined();
    });
  });

  it("controller session数をroom単位で制限する", async () => {
    const fixture = await createFixture();
    const secret = createSecretToken();
    await setJoin(fixture.stub, true, secret);
    await runInDurableObject(fixture.stub, (_instance, state) => {
      for (let index = 0; index < MAX_CONTROLLER_SESSIONS; index += 1) {
        const sessionId = crypto.randomUUID();
        state.storage.sql.exec(
          "INSERT INTO controllers (session_id, last_seq, current_connection_id, created_at) VALUES (?, -1, NULL, ?)",
          sessionId,
          Date.now(),
        );
        state.storage.sql.exec(
          "INSERT INTO tickets (ticket_hash, role, controller_session_id, expires_at) VALUES (?, 'controller', ?, ?)",
          `ticket-${index}`,
          sessionId,
          Date.now() + 60_000,
        );
      }
    });
    const result = await fixture.stub.joinWithSecret(secret, await hashToken(createSecretToken()), crypto.randomUUID(), Date.now() + 60_000);
    expect(result).toEqual({ ok: false, reason: "full" });
  });
});
