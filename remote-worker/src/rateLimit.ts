export interface CommandRateState {
  rateStartedAt: number;
  rateCount: number;
}

export interface CommandRateResult {
  allowed: boolean;
  state: CommandRateState;
}

/** 常駐timerを使わず指定時間窓のmessage数を制限する */
export function checkCommandRate(state: CommandRateState, now: number, limit = 60, windowMs = 1000): CommandRateResult {
  const current = now - state.rateStartedAt >= windowMs
    ? { rateStartedAt: now, rateCount: 0 }
    : state;
  const next = { rateStartedAt: current.rateStartedAt, rateCount: current.rateCount + 1 };
  return { allowed: next.rateCount <= limit, state: next };
}
