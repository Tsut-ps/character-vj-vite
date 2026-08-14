export type EffectId =
  | "pop"
  | "rush"
  | "ghost"
  | "impact"
  | "flip"
  | "jump"
  | "spam"
  | "chaos";

export type Quantize = "off" | "1/8" | "1/4" | "1beat" | "1bar";

export interface ClearAction {
  type: "clear";
  source: "keyboard";
}

export interface CueAction {
  type: "cue";
  cue: number;
  phase: "down" | "up";
  source: "keyboard" | "gamepad" | "midi" | "ui";
  sourceId: string;
  strength: number;
  latchToggle?: boolean;
}

export type AppAction = CueAction | ClearAction;

export const EFFECTS: readonly EffectId[] = [
  "pop",
  "rush",
  "ghost",
  "impact",
  "flip",
  "jump",
  "spam",
  "chaos",
];

export const EFFECT_LABELS: Record<EffectId, string> = {
  pop: "POP",
  rush: "RUSH",
  ghost: "GHOST",
  impact: "IMPACT",
  flip: "FLIP",
  jump: "JUMP",
  spam: "SPAM",
  chaos: "CHAOS",
};
