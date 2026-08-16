import type { AppAction } from "../../types";

export interface VjUiActions {
  handleAction(action: AppAction): void;
  selectSlot(index: number, shouldLog?: boolean): void;
  setBpm(value: number): number;
  cycleQuantize(): string;
  setOffset(value: number): number;
  setFpsLimit(enabled: boolean): void;
  setBackgroundHidden(hidden: boolean): void;
  setSkipAssign(enabled: boolean): void;
  setVolume(value: number): number;
  enableMidi(): Promise<string[]>;
  log(message: string): void;
}
