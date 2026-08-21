export interface RemoteControllerStats {
  controllerSessionId: string;
  rttMs: number | null;
}

/** RTT/2の推定値へ必須の近似記号を付ける */
export function estimatedOneWay(rttMs: number): string {
  return `~${Math.round(rttMs / 2)} ms`;
}
