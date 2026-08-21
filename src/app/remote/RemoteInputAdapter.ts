import type { AppAction } from "../types.ts";
import {
  commandAllowed,
  DEFAULT_REMOTE_PERMISSIONS,
  REMOTE_ROOM_RATE_LIMIT,
  remoteEnvelopeSchema,
  type RemoteEnvelope,
  type RemotePermissions,
} from "./RemoteProtocol.ts";

interface RateWindow {
  startedAt: number;
  count: number;
}

/** 検証済みRemoteCommandだけを既存AppAction経路へ変換する */
export class RemoteInputAdapter {
  private readonly dispatch: (action: AppAction) => void;
  private permissions: RemotePermissions = { ...DEFAULT_REMOTE_PERMISSIONS };
  private readonly lastSeq = new Map<string, number>();
  private readonly downCues = new Map<string, Set<number>>();
  private readonly rateWindows = new Map<string, RateWindow>();
  private roomRateWindow: RateWindow = { startedAt: 0, count: 0 };

  /** AppAction dispatcherへRemote入力を接続する */
  constructor(dispatch: (action: AppAction) => void) {
    this.dispatch = dispatch;
  }

  /** permissionを更新しCue禁止時は既存holdを解放する */
  setPermissions(permissions: RemotePermissions): void {
    const cueWasAllowed = this.permissions.cue;
    this.permissions = { ...permissions };
    if (cueWasAllowed && !permissions.cue) this.releaseAllControllers();
  }

  /** schema、seq、rate、permissionを通過したcommandだけをAppActionへ変換する */
  handle(controllerSessionId: string, candidate: RemoteEnvelope, now = performance.now()): boolean {
    const parsed = remoteEnvelopeSchema.safeParse(candidate);
    if (!parsed.success) return false;
    const envelope = parsed.data;
    const previous = this.lastSeq.get(controllerSessionId) ?? -1;
    if (envelope.seq <= previous) return false;
    this.lastSeq.set(controllerSessionId, envelope.seq);
    const existingDowns = this.downCues.get(controllerSessionId);
    const knownCueUp = envelope.command.type === "cue"
      && envelope.command.state === "up"
      && Boolean(existingDowns?.has(envelope.command.cue - 1));
    if ((!this.acceptRate(controllerSessionId, now) || !this.acceptRoomRate(now)) && !knownCueUp) return false;
    if (!commandAllowed(envelope.command, this.permissions)) return false;

    const command = envelope.command;
    if (command.type === "cue") {
      const cue = command.cue - 1;
      const downs = this.downCues.get(controllerSessionId) ?? new Set<number>();
      if (command.state === "down") {
        if (downs.has(cue)) return false;
        downs.add(cue);
        this.downCues.set(controllerSessionId, downs);
      } else {
        if (!downs.delete(cue)) return false;
        if (downs.size === 0) this.downCues.delete(controllerSessionId);
      }
      this.dispatch({
        type: "cue",
        cue,
        phase: command.state,
        source: "remote",
        sourceId: `remote:${controllerSessionId}:${command.cue}`,
        strength: 1,
        latchToggle: command.state === "down" ? command.latch : undefined,
      });
      return true;
    }

    if (command.type === "tap") this.dispatch({ type: "tap", source: "remote" });
    else if (command.type === "sync") this.dispatch({ type: "sync", source: "remote" });
    else if (command.type === "record") this.dispatch({ type: "toggle-record", source: "remote" });
    else this.dispatch({ type: "clear", source: "remote" });
    return true;
  }

  /** controller切断時にdown中Cueを個別sourceIdのupとして解放する */
  releaseController(controllerSessionId: string): void {
    const downs = this.downCues.get(controllerSessionId);
    if (downs) {
      for (const cue of downs) {
        this.dispatch({
          type: "cue",
          cue,
          phase: "up",
          source: "remote",
          sourceId: `remote:${controllerSessionId}:${cue + 1}`,
          strength: 1,
        });
      }
    }
    this.downCues.delete(controllerSessionId);
    this.lastSeq.delete(controllerSessionId);
    this.rateWindows.delete(controllerSessionId);
  }

  /** 全controllerのholdとreplay stateを破棄する */
  releaseAllControllers(): void {
    for (const controllerSessionId of [...this.downCues.keys()]) this.releaseController(controllerSessionId);
  }

  /** 1秒窓で60件まで許可して異常連打だけを落とす */
  private acceptRate(controllerSessionId: string, now: number): boolean {
    let window = this.rateWindows.get(controllerSessionId);
    if (!window || now - window.startedAt >= 1000) {
      window = { startedAt: now, count: 0 };
      this.rateWindows.set(controllerSessionId, window);
    }
    window.count += 1;
    return window.count <= 60;
  }

  /** room全体で1秒600件まで許可してHost負荷を制限する */
  private acceptRoomRate(now: number): boolean {
    if (now - this.roomRateWindow.startedAt >= 1000) this.roomRateWindow = { startedAt: now, count: 0 };
    this.roomRateWindow.count += 1;
    return this.roomRateWindow.count <= REMOTE_ROOM_RATE_LIMIT;
  }
}
