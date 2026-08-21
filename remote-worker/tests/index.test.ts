import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSecretToken, hashToken } from "../src/auth";

/** WebSocket closeをtimeout付きで待つ */
function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session close timeout")), 5_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

describe("Worker edge security", () => {
  it("非WebSocketのPartyServer requestをDO到達前に拒否する", async () => {
    const response = await SELF.fetch(`https://worker.test/parties/room/${crypto.randomUUID()}`);
    expect({ status: response.status, body: await response.text() }).toEqual({ status: 426, body: "Upgrade Required" });
  });

  it("tokenを返すv1 responseをcache禁止にする", async () => {
    const response = await SELF.fetch("https://worker.test/v1/rooms", {
      method: "POST",
      headers: { Origin: "https://tsut-ps.github.io", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("session ticketなしWebSocket Upgradeを401で拒否する", async () => {
    const roomId = crypto.randomUUID();
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, {
      headers: {
        Origin: "https://tsut-ps.github.io",
        Upgrade: "websocket",
      },
    });
    expect({ status: response.status, body: await response.text() }).toEqual({ status: 401, body: "Missing session ticket" });
  });

  it("URL queryのsession ticketを認証に使用しない", async () => {
    const roomId = crypto.randomUUID();
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}?ticket=${createSecretToken()}`, {
      headers: { Origin: "https://tsut-ps.github.io", Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });

  it("過大なWebSocket subprotocol headerを拒否する", async () => {
    const roomId = crypto.randomUUID();
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, {
      headers: {
        Origin: "https://tsut-ps.github.io",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `cvj-ticket.${"a".repeat(600)}`,
      },
    });
    expect(response.status).toBe(401);
  });

  it("許可外OriginのWebSocket Upgradeを403で拒否する", async () => {
    const roomId = crypto.randomUUID();
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, {
      headers: {
        Origin: "https://attacker.example",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "cvj-ticket.invalid-ticket-value-that-is-long-enough",
      },
    });
    expect({ status: response.status, body: await response.text() }).toEqual({ status: 403, body: "Forbidden Origin" });
  });

  it("CORSへwildcardを返さず許可Originだけを反映する", async () => {
    const response = await SELF.fetch("https://worker.test/v1/rooms", {
      method: "OPTIONS",
      headers: { Origin: "https://tsut-ps.github.io" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://tsut-ps.github.io");
    expect(response.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("session期限で接続中WebSocketを終了する", async () => {
    const roomId = crypto.randomUUID();
    const hostToken = createSecretToken();
    const sessionTicket = createSecretToken();
    const expiresAt = Date.now() + 250;
    await env.Room.getByName(roomId).initializeRoom(
      await hashToken(hostToken),
      await hashToken(sessionTicket),
      expiresAt,
    );
    const response = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, {
      headers: {
        Origin: "https://tsut-ps.github.io",
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `cvj-ticket.${sessionTicket}`,
      },
    });
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(`cvj-ticket.${sessionTicket}`);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const close = await waitForClose(socket!);
    expect(close.code).toBe(4003);
  });

  it("新しいHost接続時に古いHostを切断する", async () => {
    const roomId = crypto.randomUUID();
    const hostToken = createSecretToken();
    const sessionTicket = createSecretToken();
    await env.Room.getByName(roomId).initializeRoom(
      await hashToken(hostToken),
      await hashToken(sessionTicket),
      Date.now() + 60_000,
    );
    const headers = {
      Origin: "https://tsut-ps.github.io",
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `cvj-ticket.${sessionTicket}`,
    };
    const firstResponse = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, { headers });
    const first = firstResponse.webSocket!;
    first.accept();
    const firstClosed = waitForClose(first);
    const secondResponse = await SELF.fetch(`https://worker.test/parties/room/${roomId}`, { headers });
    const second = secondResponse.webSocket!;
    second.accept();
    expect((await firstClosed).code).toBe(4001);
    second.close(1000, "done");
  });
});
