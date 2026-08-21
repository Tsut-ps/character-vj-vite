import { z } from "zod";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_MESSAGE_MAX_BYTES = 1024;
export const REMOTE_SERVER_MESSAGE_MAX_BYTES = 64 * 1024;
export const REMOTE_ROOM_RATE_LIMIT = 600;
export const REMOTE_TICKET_PROTOCOL_PREFIX = "cvj-ticket.";

const cueNumberSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
  z.literal(6), z.literal(7), z.literal(8), z.literal(9),
]);

export const remotePermissionsSchema = z.object({
  cue: z.boolean(),
  tapSync: z.boolean(),
  record: z.boolean(),
  clear: z.boolean(),
}).strict();

export type RemotePermissions = z.infer<typeof remotePermissionsSchema>;

export const DEFAULT_REMOTE_PERMISSIONS: RemotePermissions = {
  cue: true,
  tapSync: false,
  record: false,
  clear: false,
};

export const remoteCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cue"),
    cue: cueNumberSchema,
    state: z.enum(["down", "up"]),
    latch: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("tap") }).strict(),
  z.object({ type: z.literal("sync") }).strict(),
  z.object({ type: z.literal("record") }).strict(),
  z.object({ type: z.literal("clear") }).strict(),
]);

export const remoteEnvelopeSchema = z.object({
  v: z.literal(REMOTE_PROTOCOL_VERSION),
  seq: z.number().int().nonnegative().safe(),
  command: remoteCommandSchema,
}).strict();

export type RemoteCommand = z.infer<typeof remoteCommandSchema>;
export type RemoteEnvelope = z.infer<typeof remoteEnvelopeSchema>;

export const controllerClientMessageSchema = z.union([
  remoteEnvelopeSchema,
  z.object({ v: z.literal(1), type: z.literal("pong"), nonce: z.string().uuid() }).strict(),
]);

export const hostClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("openJoin"), requestId: z.string().uuid() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("closeJoin"), requestId: z.string().uuid() }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("setPermissions"),
    requestId: z.string().uuid(),
    permissions: remotePermissionsSchema,
  }).strict(),
  z.object({ v: z.literal(1), type: z.literal("requestState"), requestId: z.string().uuid() }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("ping"),
    controllerSessionId: z.string().uuid(),
    nonce: z.string().uuid(),
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("latency"),
    controllerSessionId: z.string().uuid(),
    rttMs: z.number().finite().nonnegative().max(60_000),
  }).strict(),
]);

const controllerSummarySchema = z.object({
  controllerSessionId: z.string().uuid(),
}).strict();

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(1),
    type: z.literal("ready"),
    role: z.enum(["host", "controller"]),
    roomId: z.string().uuid(),
    controllerSessionId: z.string().uuid().optional(),
    permissions: remotePermissionsSchema,
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("hostAck"),
    requestId: z.string().uuid(),
    action: z.enum(["openJoin", "closeJoin", "setPermissions", "requestState"]),
    ok: z.boolean(),
    joinSecret: z.string().min(32).max(256).optional(),
    error: z.string().max(160).optional(),
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("state"),
    joinOpen: z.boolean(),
    permissions: remotePermissionsSchema,
    controllers: z.array(controllerSummarySchema).max(500),
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("controllerConnected"),
    controllerSessionId: z.string().uuid(),
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("controllerDisconnected"),
    controllerSessionId: z.string().uuid(),
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("remote"),
    controllerSessionId: z.string().uuid(),
    envelope: remoteEnvelopeSchema,
  }).strict(),
  z.object({ v: z.literal(1), type: z.literal("permissions"), permissions: remotePermissionsSchema }).strict(),
  z.object({ v: z.literal(1), type: z.literal("ping"), nonce: z.string().uuid() }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("pong"),
    nonce: z.string().uuid(),
    controllerSessionId: z.string().uuid(),
  }).strict(),
  z.object({ v: z.literal(1), type: z.literal("latency"), rttMs: z.number().finite().nonnegative().max(60_000) }).strict(),
  z.object({ v: z.literal(1), type: z.literal("error"), code: z.string().max(64), message: z.string().max(160) }).strict(),
]);

export type HostClientMessage = z.infer<typeof hostClientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const createRoomResponseSchema = z.object({
  v: z.literal(1),
  roomId: z.string().uuid(),
  hostToken: z.string().min(32).max(256),
  sessionTicket: z.string().min(32).max(256),
  expiresAt: z.number().int().positive(),
}).strict();

export const joinRoomResponseSchema = z.object({
  v: z.literal(1),
  roomId: z.string().uuid(),
  controllerSessionId: z.string().uuid(),
  sessionTicket: z.string().min(32).max(256),
  expiresAt: z.number().int().positive(),
  permissions: remotePermissionsSchema,
}).strict();

/** commandがHostで設定された観客権限に含まれるか判定する */
export function commandAllowed(command: RemoteCommand, permissions: RemotePermissions): boolean {
  switch (command.type) {
    case "cue": return permissions.cue;
    case "tap":
    case "sync": return permissions.tapSync;
    case "record": return permissions.record;
    case "clear": return permissions.clear;
  }
}

/** server JSONをZod検証し不正messageをnullへ畳み込む */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > REMOTE_SERVER_MESSAGE_MAX_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    const result = serverMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
