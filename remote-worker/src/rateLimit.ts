export interface CommandRateState {
  rateStartedAt: number;
  rateCount: number;
}

export interface CommandRateResult {
  allowed: boolean;
  state: CommandRateState;
}

/** controller単位で1秒60件まで許可し常駐timerを使わず窓を更新する */
export function checkCommandRate(state: CommandRateState, now: number, limit = 60): CommandRateResult {
  const current = now - state.rateStartedAt >= 1000
    ? { rateStartedAt: now, rateCount: 0 }
    : state;
  const next = { rateStartedAt: current.rateStartedAt, rateCount: current.rateCount + 1 };
  return { allowed: next.rateCount <= limit, state: next };
}
