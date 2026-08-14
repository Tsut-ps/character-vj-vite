import type { Application } from "pixi.js";
import type { BeatClock } from "../BeatClock";
import type { CueEngine } from "../cues/CueEngine";
import type { InputRouter } from "../InputRouter";
import type { MediaAssignmentController } from "../media/MediaAssignmentController";
import type { SlotStore } from "../media/SlotStore";
import type { StageRenderer } from "../rendering/StageRenderer";
import type { AppAction } from "../types";
import type { VjUiActions } from "./bindings/VjUiActions";

export interface VjUiActionDependencies {
  app: Application;
  clock: BeatClock;
  cueEngine: CueEngine;
  router: InputRouter;
  slots: SlotStore;
  stage: StageRenderer;
  assignments: MediaAssignmentController;
  handleAction: (action: AppAction) => void;
  adjustScale: (delta: number, individual: boolean) => void;
  moveAnchor: (dx: number, dy: number, individual: boolean) => void;
  selectSlot: (index: number, shouldLog?: boolean) => void;
  log: (message: string) => void;
}

/** アプリの各機能をUI向けの操作インターフェースへ変換する */
export function createVjUiActions(dependencies: VjUiActionDependencies): VjUiActions {
  const { app, clock, cueEngine, router, slots, stage, assignments, log } = dependencies;
  return {
    handleAction: dependencies.handleAction,
    triggerCue: (cue, latchToggle) => {
      slots.resumeAudio();
      cueEngine.trigger(cue, 1, latchToggle);
    },
    adjustScale: dependencies.adjustScale,
    moveAnchor: dependencies.moveAnchor,
    selectSlot: dependencies.selectSlot,
    setBpm: (value) => {
      clock.setBpm(value);
      log(`BPM ${clock.bpm.toFixed(2)}`);
      return clock.bpm;
    },
    tap: () => {
      const bpm = clock.tap();
      log(`TAP ${bpm.toFixed(2)}`);
      return bpm;
    },
    sync: () => {
      clock.sync();
      log("SYNC");
    },
    cycleQuantize: () => cueEngine.cycleQuantize(),
    setOffset: (value) => {
      clock.setOffsetMs(value);
      log(`OFFSET ${clock.offsetMs}ms`);
    },
    setFpsLimit: (enabled) => {
      app.ticker.maxFPS = enabled ? 60 : 0;
      log(enabled ? "60 FPS LIMIT ON" : "60 FPS LIMIT OFF");
    },
    setBackgroundHidden: (hidden) => {
      stage.setBackgroundVisible(!hidden);
      log(hidden ? "BACKGROUND HIDDEN" : "BACKGROUND SHOWN");
    },
    setSkipAssign: (enabled) => {
      assignments.setSkipAssign(enabled);
      log(enabled ? "D&D ASSIGN SKIP ON" : "D&D ASSIGN SKIP OFF");
    },
    setVolume: (value) => {
      slots.setVolume(value);
      return slots.volume;
    },
    toggleRecord: () => cueEngine.toggleRecord(),
    enableMidi: () => router.enableMidi(),
    cancelDropOverlay: () => assignments.cancelDropOverlay(),
    isAssignmentOpen: () => assignments.isOpen,
    closeAssignment: () => assignments.close(true),
    log,
  };
}
