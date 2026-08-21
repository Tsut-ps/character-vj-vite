import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { constantTimeEqual, createSecretToken, hashToken } from "./auth";
import {
  controllerMessageSchema,
  DEFAULT_PERMISSIONS,
  hostMessageSchema,
  isCommandAllowed,
  MAX_ACTIVE_CONTROLLERS,
  MAX_CONTROLLER_SESSIONS,
  MAX_ROOM_COMMANDS_PER_SECOND,
  parseJsonCandidate,
  payloadWithinLimit,
  permissionsSchema,
  sequenceIsFresh,
  type HostMessage,
  type Permissions,
  type RemoteEnvelope,
} from "./protocol";
import { checkCommandRate } from "./rateLimit";

type Role = "host" | "controller";

interface RemoteConnectionState {
  role: Role;
  controllerSessionId?: string;
  sessionExpiresAt: number;
  permissions: Readonly<Permissions>;
  rateStartedAt: number;
  rateCount: number;
  downCues: readonly number[];
}

type RoomRow = {
  host_token_hash: string;
  join_open: number;
  join_secret_hash: string | null;
  permissions_json: string;
  current_host_connection_id: string | null;
} & Record<string, SqlStorageValue>;

type TicketRow = {
  role: Role;
  controller_session_id: string | null;
  expires_at: number;
} & Record<string, SqlStorageValue>;

export interface WebSocketAuthorization {
  ok: boolean;
  role?: Role;
  controllerSessionId?: string;
  expiresAt?: number;
  permissions?: Permissions;
}

export interface JoinResult {
  ok: boolean;
  reason?: "forbidden" | "full";
  permissions?: Permissions;
}

/** 1 remote roomをSQLiteとhibernatable WebSocketで管理する */
export class Room extends Server<Env> {
  static options = { hibernate: true };
  private roomRate = { rateStartedAt: 0, rateCount: 0 };

  /** PartyServer起動時に軽量なschema確認だけを行う */
  onStart(): void {
    this.ensureSchema();
  }

  /** 新規roomのhost hashと最初のticket hashを原子的に保存する */
  async initializeRoom(hostTokenHash: string, ticketHash: string, expiresAt: number): Promise<boolean> {
    if (await this.ctx.storage.get<boolean>("initialized")) return false;
    this.ensureSchema();
    const existing = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM room_state").one().count;
    if (existing > 0) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO room_state (singleton, host_token_hash, join_open, join_secret_hash, permissions_json, current_host_connection_id, created_at) VALUES (1, ?, 0, NULL, ?, NULL, ?)",
      hostTokenHash,
      JSON.stringify(DEFAULT_PERMISSIONS),
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO tickets (ticket_hash, role, controller_session_id, expires_at) VALUES (?, 'host', NULL, ?)",
      ticketHash,
      expiresAt,
    );
    await this.ctx.storage.put("initialized", true);
    return true;
  }

  /** host token検証後に再接続用host ticket hashを保存する */
  async createHostTicket(hostToken: string, ticketHash: string, expiresAt: number): Promise<boolean> {
    if (!await this.ctx.storage.get<boolean>("initialized")) return false;
    this.ensureSchema();
    const room = this.getRoom();
    if (!room || !constantTimeEqual(room.host_token_hash, await hashToken(hostToken))) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM tickets WHERE role = 'host'");
      this.ctx.storage.sql.exec(
        "INSERT INTO tickets (ticket_hash, role, controller_session_id, expires_at) VALUES (?, 'host', NULL, ?)",
        ticketHash,
        expiresAt,
      );
    });
    return true;
  }

  /** join状態とsecretを検証してcontroller sessionを発行可能にする */
  async joinWithSecret(joinSecret: string, ticketHash: string, controllerSessionId: string, expiresAt: number): Promise<JoinResult> {
    if (!await this.ctx.storage.get<boolean>("initialized")) return { ok: false, reason: "forbidden" };
    this.ensureSchema();
    const room = this.getRoom();
    const candidateHash = await hashToken(joinSecret);
    if (!room || room.join_open !== 1 || !room.join_secret_hash || !constantTimeEqual(room.join_secret_hash, candidateHash)) {
      return { ok: false, reason: "forbidden" };
    }
    const now = Date.now();
    const inserted = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires_at < ?", now);
      this.ctx.storage.sql.exec(
        "DELETE FROM controllers WHERE current_connection_id IS NULL AND session_id NOT IN (SELECT controller_session_id FROM tickets WHERE controller_session_id IS NOT NULL)",
      );
      const controllerCount = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM controllers").one().count;
      if (controllerCount >= MAX_CONTROLLER_SESSIONS) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO controllers (session_id, last_seq, current_connection_id, created_at) VALUES (?, -1, NULL, ?)",
        controllerSessionId,
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO tickets (ticket_hash, role, controller_session_id, expires_at) VALUES (?, 'controller', ?, ?)",
        ticketHash,
        controllerSessionId,
        expiresAt,
      );
      return true;
    });
    if (!inserted) return { ok: false, reason: "full" };
    return { ok: true, permissions: this.parsePermissions(room.permissions_json) };
  }

  /** WebSocket Upgrade前に短期ticketをroomとroleへ結び付ける */
  async authorizeWebSocket(ticket: string): Promise<WebSocketAuthorization> {
    if (!await this.ctx.storage.get<boolean>("initialized")) return { ok: false };
    this.ensureSchema();
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM tickets WHERE expires_at < ?", now);
    const ticketHash = await hashToken(ticket);
    const row = this.ctx.storage.sql.exec<TicketRow>(
      "SELECT role, controller_session_id, expires_at FROM tickets WHERE ticket_hash = ?",
      ticketHash,
    ).toArray()[0];
    if (!row || row.expires_at < now) return { ok: false };
    if (row.role === "controller") {
      if (!row.controller_session_id) return { ok: false };
      const controller = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM controllers WHERE session_id = ?",
        row.controller_session_id,
      ).one();
      if (controller.count !== 1) return { ok: false };
    }
    return {
      ok: true,
      role: row.role,
      controllerSessionId: row.controller_session_id ?? undefined,
      expiresAt: row.expires_at,
      permissions: this.currentPermissions(),
    };
  }

  /** server側で認証済みの接続情報だけをhibernation attachmentへ保存する */
  async onConnect(connection: Connection<RemoteConnectionState>, context: ConnectionContext): Promise<void> {
    const role = context.request.headers.get("x-remote-internal-role");
    const controllerSessionId = context.request.headers.get("x-remote-internal-controller");
    const sessionExpiresAt = Number(context.request.headers.get("x-remote-internal-expires"));
    if ((role !== "host" && role !== "controller") || !Number.isSafeInteger(sessionExpiresAt) || sessionExpiresAt <= Date.now()) {
      connection.close(4401, "Unauthorized");
      return;
    }
    const permissions = this.currentPermissions();
    connection.setState({
      role,
      controllerSessionId: controllerSessionId ?? undefined,
      sessionExpiresAt,
      permissions,
      rateStartedAt: Date.now(),
      rateCount: 0,
      downCues: [],
    });
    await this.scheduleSessionAlarm(sessionExpiresAt);

    if (role === "host") this.connectHost(connection);
    else if (!controllerSessionId) {
      connection.close(4401, "Missing controller identity");
      return;
    } else if (!this.connectController(connection, controllerSessionId)) {
      connection.close(4429, "Room controller limit reached");
      return;
    }

    this.send(connection, {
      v: 1,
      type: "ready",
      role,
      roomId: this.name,
      ...(controllerSessionId ? { controllerSessionId } : {}),
      permissions,
    });
    if (role === "host") this.sendState(connection);
  }

  /** 認証済みroleに応じて許可されたmessage schemaだけを処理する */
  async onMessage(connection: Connection<RemoteConnectionState>, message: WSMessage): Promise<void> {
    const initialState = connection.state;
    if (!initialState) {
      connection.close(4401, "Missing connection state");
      return;
    }
    let state = initialState;
    let controllerRateAllowed = true;
    if (state.role === "controller") {
      const rate = checkCommandRate(state, Date.now());
      state = { ...state, ...rate.state };
      controllerRateAllowed = rate.allowed;
      connection.setState(state);
    }
    const text = this.messageText(message);
    if (text === null) {
      if (controllerRateAllowed) this.sendError(connection, "invalid_payload", "Message must be UTF-8 JSON under 1 KiB");
      return;
    }
    const candidate = parseJsonCandidate(text);
    if (candidate === null) {
      if (controllerRateAllowed) this.sendError(connection, "malformed_json", "Malformed JSON");
      return;
    }
    if (state.role === "host") await this.handleHostMessage(connection, candidate);
    else await this.handleControllerMessage(connection, candidate, state, controllerRateAllowed);
  }

  /** current接続だけを切断扱いにしてhostへcontroller解放を通知する */
  onClose(connection: Connection<RemoteConnectionState>): void {
    const state = connection.state;
    if (!state) return;
    if (state.role === "host") {
      const room = this.getRoom();
      if (room?.current_host_connection_id === connection.id) {
        this.ctx.storage.sql.exec(
          "UPDATE room_state SET current_host_connection_id = NULL, join_open = 0, join_secret_hash = NULL WHERE singleton = 1",
        );
      }
      return;
    }
    if (!state.controllerSessionId) return;
    const row = this.ctx.storage.sql.exec<{ current_connection_id: string | null }>(
      "SELECT current_connection_id FROM controllers WHERE session_id = ?",
      state.controllerSessionId,
    ).toArray()[0];
    if (row?.current_connection_id !== connection.id) return;
    this.ctx.storage.sql.exec("UPDATE controllers SET current_connection_id = NULL WHERE session_id = ?", state.controllerSessionId);
    this.sendToHosts({ v: 1, type: "controllerDisconnected", controllerSessionId: state.controllerSessionId });
  }

  /** 期限切れconnectionを閉じて次のsession期限だけをalarmへ登録する */
  async onAlarm(): Promise<void> {
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    const room = this.getRoom();
    for (const connection of this.getConnections<RemoteConnectionState>()) {
      const state = connection.state;
      if (!state) continue;
      if (state.sessionExpiresAt <= now) {
        if (state.role === "host" && room?.current_host_connection_id === connection.id) {
          this.ctx.storage.sql.exec(
            "UPDATE room_state SET current_host_connection_id = NULL, join_open = 0, join_secret_hash = NULL WHERE singleton = 1",
          );
        }
        connection.close(4003, "Session expired");
      } else {
        nextExpiry = Math.min(nextExpiry, state.sessionExpiresAt);
      }
    }
    if (Number.isFinite(nextExpiry)) await this.ctx.storage.setAlarm(nextExpiry);
  }

  /** 接続roleとcontroller identityを検索用tagへ変換する */
  getConnectionTags(_connection: Connection, context: ConnectionContext): string[] {
    const role = context.request.headers.get("x-remote-internal-role");
    const controller = context.request.headers.get("x-remote-internal-controller");
    return [
      ...(role === "host" || role === "controller" ? [`role:${role}`] : []),
      ...(controller ? [`controller:${controller}`] : []),
    ];
  }

  /** 古いhostを明示的に切断してroomあたり1 hostへ保つ */
  private connectHost(connection: Connection<RemoteConnectionState>): void {
    const room = this.getRoom();
    this.ctx.storage.sql.exec(
      "UPDATE room_state SET current_host_connection_id = ?, join_open = 0, join_secret_hash = NULL WHERE singleton = 1",
      connection.id,
    );
    if (!room?.current_host_connection_id || room.current_host_connection_id === connection.id) return;
    this.getConnection(room.current_host_connection_id)?.close(4001, "Host replaced");
  }

  /** 同じcontroller sessionの旧接続を閉じて接続状態をhostへ通知する */
  private connectController(connection: Connection<RemoteConnectionState>, controllerSessionId: string): boolean {
    const activeControllers = new Set(
      [...this.getConnections<RemoteConnectionState>("role:controller")]
        .map((item) => item.state?.controllerSessionId)
        .filter((id): id is string => Boolean(id)),
    );
    activeControllers.add(controllerSessionId);
    if (activeControllers.size > MAX_ACTIVE_CONTROLLERS) return false;
    const row = this.ctx.storage.sql.exec<{ current_connection_id: string | null }>(
      "SELECT current_connection_id FROM controllers WHERE session_id = ?",
      controllerSessionId,
    ).toArray()[0];
    this.ctx.storage.sql.exec(
      "UPDATE controllers SET current_connection_id = ? WHERE session_id = ?",
      connection.id,
      controllerSessionId,
    );
    if (row?.current_connection_id && row.current_connection_id !== connection.id) {
      this.getConnection(row.current_connection_id)?.close(4002, "Controller reconnected");
    }
    this.sendToHosts({ v: 1, type: "controllerConnected", controllerSessionId });
    return true;
  }

  /** host専用controlを処理しcontrollerへ権限をserver側から配布する */
  private async handleHostMessage(connection: Connection<RemoteConnectionState>, candidate: unknown): Promise<void> {
    if (this.getRoom()?.current_host_connection_id !== connection.id) {
      connection.close(4001, "Host replaced");
      return;
    }
    const result = hostMessageSchema.safeParse(candidate);
    if (!result.success) {
      this.sendError(connection, "forbidden_message", "Host message schema rejected");
      return;
    }
    const message = result.data;
    if (message.type === "openJoin") await this.openJoin(connection, message.requestId);
    else if (message.type === "closeJoin") this.closeJoin(connection, message.requestId);
    else if (message.type === "setPermissions") this.setPermissions(connection, message);
    else if (message.type === "requestState") {
      this.sendAck(connection, message.requestId, message.type, true);
      this.sendState(connection);
    } else if (message.type === "ping") {
      this.sendToController(message.controllerSessionId, { v: 1, type: "ping", nonce: message.nonce });
    } else {
      this.sendToController(message.controllerSessionId, { v: 1, type: "latency", rttMs: message.rttMs });
    }
  }

  /** controller messageへseq、rate、permissionを適用してhostだけへ転送する */
  private async handleControllerMessage(
    connection: Connection<RemoteConnectionState>,
    candidate: unknown,
    state: Readonly<RemoteConnectionState>,
    controllerRateAllowed: boolean,
  ): Promise<void> {
    const result = controllerMessageSchema.safeParse(candidate);
    if (!result.success || !state.controllerSessionId) {
      if (controllerRateAllowed) this.sendError(connection, "forbidden_message", "Controller message schema rejected");
      return;
    }
    const controller = this.ctx.storage.sql.exec<{ last_seq: number; current_connection_id: string | null }>(
      "SELECT last_seq, current_connection_id FROM controllers WHERE session_id = ?",
      state.controllerSessionId,
    ).toArray()[0];
    if (!controller || controller.current_connection_id !== connection.id) {
      connection.close(4002, "Controller reconnected");
      return;
    }
    const roomRate = checkCommandRate(this.roomRate, Date.now(), MAX_ROOM_COMMANDS_PER_SECOND);
    this.roomRate = roomRate.state;
    if ("type" in result.data && result.data.type === "pong") {
      if (controllerRateAllowed && roomRate.allowed) {
        this.sendToHosts({ v: 1, type: "pong", nonce: result.data.nonce, controllerSessionId: state.controllerSessionId });
      }
      return;
    }
    const envelope = result.data as RemoteEnvelope;
    const lastSeq = controller.last_seq;
    if (!sequenceIsFresh(envelope.seq, lastSeq)) return;
    this.ctx.storage.sql.exec("UPDATE controllers SET last_seq = ? WHERE session_id = ?", envelope.seq, state.controllerSessionId);

    const cueUpForKnownDown = envelope.command.type === "cue"
      && envelope.command.state === "up"
      && state.downCues.includes(envelope.command.cue);
    const nextDowns = this.nextDownCues(state.downCues, envelope);
    connection.setState({ ...state, downCues: nextDowns });
    if ((!controllerRateAllowed || !roomRate.allowed) && !cueUpForKnownDown) return;
    const permissions = this.currentPermissions();
    if (!isCommandAllowed(envelope.command, permissions)) return;
    this.sendToHosts({ v: 1, type: "remote", controllerSessionId: state.controllerSessionId, envelope });
  }

  /** OPEN ACK用secretを毎回ローテーションしhashだけを保存する */
  private async openJoin(connection: Connection<RemoteConnectionState>, requestId: string): Promise<void> {
    const joinSecret = createSecretToken();
    const secretHash = await hashToken(joinSecret);
    this.ctx.storage.sql.exec(
      "UPDATE room_state SET join_open = 1, join_secret_hash = ? WHERE singleton = 1",
      secretHash,
    );
    this.sendAck(connection, requestId, "openJoin", true, joinSecret);
    this.sendState(connection);
  }

  /** CLOSE ACK前にjoinを閉じて現在secretを即時無効化する */
  private closeJoin(connection: Connection<RemoteConnectionState>, requestId: string): void {
    this.ctx.storage.sql.exec("UPDATE room_state SET join_open = 0, join_secret_hash = NULL WHERE singleton = 1");
    this.sendAck(connection, requestId, "closeJoin", true);
    this.sendState(connection);
  }

  /** permissionsを永続化し全controller attachmentとUIへ反映する */
  private setPermissions(connection: Connection<RemoteConnectionState>, message: Extract<HostMessage, { type: "setPermissions" }>): void {
    this.ctx.storage.sql.exec(
      "UPDATE room_state SET permissions_json = ? WHERE singleton = 1",
      JSON.stringify(message.permissions),
    );
    for (const controller of this.getConnections<RemoteConnectionState>("role:controller")) {
      const state = controller.state;
      if (state) controller.setState({ ...state, permissions: message.permissions });
      this.send(controller, { v: 1, type: "permissions", permissions: message.permissions });
    }
    this.sendAck(connection, message.requestId, message.type, true);
    this.sendState(connection);
  }

  /** cue down集合をmessage順に更新してrate超過時のup解放を判定可能にする */
  private nextDownCues(current: readonly number[], envelope: RemoteEnvelope): number[] {
    if (envelope.command.type !== "cue") return [...current];
    const next = new Set(current);
    if (envelope.command.state === "down") next.add(envelope.command.cue);
    else next.delete(envelope.command.cue);
    return [...next];
  }

  /** hostへ現在のjoin、permissions、controller一覧を送る */
  private sendState(connection: Connection): void {
    const room = this.getRoom();
    if (!room) return;
    const controllers = [...this.getConnections<RemoteConnectionState>("role:controller")]
      .map((item) => item.state?.controllerSessionId)
      .filter((id): id is string => Boolean(id));
    this.send(connection, {
      v: 1,
      type: "state",
      joinOpen: room.join_open === 1,
      permissions: this.parsePermissions(room.permissions_json),
      controllers: [...new Set(controllers)].map((controllerSessionId) => ({ controllerSessionId })),
    });
  }

  /** host ACKを共通形で返す */
  private sendAck(
    connection: Connection,
    requestId: string,
    action: "openJoin" | "closeJoin" | "setPermissions" | "requestState",
    ok: boolean,
    joinSecret?: string,
  ): void {
    this.send(connection, { v: 1, type: "hostAck", requestId, action, ok, ...(joinSecret ? { joinSecret } : {}) });
  }

  /** 現在のhost接続だけへmessageを送り旧hostとcontrollerへの漏洩を防ぐ */
  private sendToHosts(message: unknown): void {
    const currentHostId = this.getRoom()?.current_host_connection_id;
    if (!currentHostId) return;
    const host = this.getConnection(currentHostId);
    if (host) this.send(host, message);
  }

  /** 指定controller sessionだけへmessageを送る */
  private sendToController(controllerSessionId: string, message: unknown): void {
    for (const controller of this.getConnections(`controller:${controllerSessionId}`)) this.send(controller, message);
  }

  /** JSON server messageを単一接続へ送る */
  private send(connection: Connection, message: unknown): void {
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
  }

  /** schema拒否理由をidentity情報なしで接続元へ返す */
  private sendError(connection: Connection, code: string, message: string): void {
    this.send(connection, { v: 1, type: "error", code, message });
  }

  /** binaryと1 KiB超過messageをJSON parse前に拒否する */
  private messageText(message: WSMessage): string | null {
    if (typeof message !== "string") return null;
    return payloadWithinLimit(message) ? message : null;
  }

  /** room stateの現在permissionsを安全な初期値付きで取得する */
  private currentPermissions(): Permissions {
    const room = this.getRoom();
    return room ? this.parsePermissions(room.permissions_json) : { ...DEFAULT_PERMISSIONS };
  }

  /** 永続JSONをZod検証して破損時は安全な初期権限へ戻す */
  private parsePermissions(value: string): Permissions {
    try {
      const parsed: unknown = JSON.parse(value);
      const result = permissionsSchema.safeParse(parsed);
      return result.success ? result.data : { ...DEFAULT_PERMISSIONS };
    } catch {
      return { ...DEFAULT_PERMISSIONS };
    }
  }

  /** 現在のalarmより早いsession期限だけを登録する */
  private async scheduleSessionAlarm(expiresAt: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || expiresAt < current) await this.ctx.storage.setAlarm(expiresAt);
  }

  /** singleton room rowを取得する */
  private getRoom(): RoomRow | undefined {
    this.ensureSchema();
    return this.ctx.storage.sql.exec<RoomRow>(
      "SELECT host_token_hash, join_open, join_secret_hash, permissions_json, current_host_connection_id FROM room_state WHERE singleton = 1",
    ).toArray()[0];
  }

  /** constructorを軽量に保つためentry pointからSQLite schemaを冪等作成する */
  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        host_token_hash TEXT NOT NULL,
        join_open INTEGER NOT NULL DEFAULT 0,
        join_secret_hash TEXT,
        permissions_json TEXT NOT NULL,
        current_host_connection_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_hash TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('host', 'controller')),
        controller_session_id TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tickets_expires_at ON tickets(expires_at);
      CREATE TABLE IF NOT EXISTS controllers (
        session_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL DEFAULT -1,
        current_connection_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }
}
