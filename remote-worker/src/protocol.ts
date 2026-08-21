import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_CLIENT_MESSAGE_BYTES = 1024;
export const SESSION_TICKET_TTL_MS = 60 * 60 * 1000;
export const MAX_CONTROLLER_SESSIONS = 200;
export const MAX_ACTIVE_CONTROLLERS = 100;
export const MAX_ROOM_COMMANDS_PER_SECOND = 600;

const cueSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
  z.literal(6), z.literal(7), z.literal(8), z.literal(9),
]);

export const permissionsSchema = z.object({
  cue: z.boolean(),
  tapSync: z.boolean(),
  record: z.boolean(),
  clear: z.boolean(),
}).strict();

export type Permissions = z.infer<typeof permissionsSchema>;

export const DEFAULT_PERMISSIONS: Permissions = {
  cue: true,
  tapSync: false,
  record: false,
  clear: false,
};

export const remoteCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cue"), cue: cueSchema, state: z.enum(["down", "up"]), latch: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("tap") }).strict(),
  z.object({ type: z.literal("sync") }).strict(),
  z.object({ type: z.literal("record") }).strict(),
  z.object({ type: z.literal("clear") }).strict(),
]);

export const remoteEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().nonnegative().safe(),
  command: remoteCommandSchema,
}).strict();

export type RemoteCommand = z.infer<typeof remoteCommandSchema>;
export type RemoteEnvelope = z.infer<typeof remoteEnvelopeSchema>;

export const controllerMessageSchema = z.union([
  remoteEnvelopeSchema,
  z.object({ v: z.literal(1), type: z.literal("pong"), nonce: z.string().uuid() }).strict(),
]);

export const hostMessageSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("openJoin"), requestId: z.string().uuid() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("closeJoin"), requestId: z.string().uuid() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("setPermissions"), requestId: z.string().uuid(), permissions: permissionsSchema }).strict(),
  z.object({ v: z.literal(1), type: z.literal("requestState"), requestId: z.string().uuid() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("ping"), controllerSessionId: z.string().uuid(), nonce: z.string().uuid() }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("latency"),
    controllerSessionId: z.string().uuid(),
    rttMs: z.number().finite().nonnegative().max(60_000),
  }).strict(),
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;

export const joinRequestSchema = z.object({ joinSecret: z.string().min(32).max(256) }).strict();
export const hostTicketRequestSchema = z.object({ hostToken: z.string().min(32).max(256) }).strict();

/** JSON parse失敗をexceptionとしてmessage handler外へ漏らさない */
export function parseJsonCandidate(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 通常client messageが1 KiB以内かUTF-8 byte数で判定する */
export function payloadWithinLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= MAX_CLIENT_MESSAGE_BYTES;
}

/** session内で単調増加するseqだけを新規入力として認める */
export function sequenceIsFresh(seq: number, lastSeq: number): boolean {
  return Number.isSafeInteger(seq) && seq >= 0 && seq > lastSeq;
}

/** commandが現在の観客権限に含まれるか判定する */
export function isCommandAllowed(command: RemoteCommand, permissions: Permissions): boolean {
  switch (command.type) {
    case "cue": return permissions.cue;
    case "tap":
    case "sync": return permissions.tapSync;
    case "record": return permissions.record;
    case "clear": return permissions.clear;
  }
}
