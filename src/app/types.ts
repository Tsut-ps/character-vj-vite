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

export type InputSource = "keyboard" | "gamepad" | "midi" | "ui" | "remote";

interface BaseInputAction {
  source: InputSource;
}

export interface ClearAction extends BaseInputAction {
  type: "clear";
}

export interface CueAction extends BaseInputAction {
  type: "cue";
  cue: number;
  phase: "down" | "up";
  sourceId: string;
  strength: number;
  latchToggle?: boolean;
}

export interface AdjustScaleAction extends BaseInputAction {
  type: "adjust-scale";
  delta: number;
  individual: boolean;
}

export interface MoveAnchorAction extends BaseInputAction {
  type: "move-anchor";
  dx: number;
  dy: number;
  individual: boolean;
}

export interface TapAction extends BaseInputAction {
  type: "tap";
}

export interface SyncAction extends BaseInputAction {
  type: "sync";
}

export interface ToggleRecordAction extends BaseInputAction {
  type: "toggle-record";
}

export interface EscapeAction extends BaseInputAction {
  type: "escape";
}

export type CueEngineAction = CueAction | ClearAction;

export type AppAction =
  | CueEngineAction
  | AdjustScaleAction
  | MoveAnchorAction
  | TapAction
  | SyncAction
  | ToggleRecordAction
  | EscapeAction;

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
