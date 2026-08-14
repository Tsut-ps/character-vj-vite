import type { AppAction } from "../../types";

export interface VjUiActions {
  handleAction(action: AppAction): void;
  triggerCue(cue: number, latchToggle: boolean): void;
  adjustScale(delta: number, individual: boolean): void;
  moveAnchor(dx: number, dy: number, individual: boolean): void;
  selectSlot(index: number, shouldLog?: boolean): void;
  setBpm(value: number): number;
  tap(): number;
  sync(): void;
  cycleQuantize(): string;
  setOffset(value: number): number;
  setFpsLimit(enabled: boolean): void;
  setBackgroundHidden(hidden: boolean): void;
  setSkipAssign(enabled: boolean): void;
  setVolume(value: number): number;
  toggleRecord(): void;
  enableMidi(): Promise<string[]>;
  cancelDropOverlay(): boolean;
  isAssignmentOpen(): boolean;
  closeAssignment(): void;
  log(message: string): void;
}
