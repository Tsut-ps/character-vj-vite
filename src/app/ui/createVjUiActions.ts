import type { Application } from "pixi.js";
import type { BeatClock } from "../BeatClock";
import type { CueEngine } from "../cues/CueEngine";
import type { InputRouter } from "../InputRouter";
import type { MediaAssignmentController } from "../media/MediaAssignmentController";
import type { SlotStore } from "../media/SlotStore";
import type { StageRenderer } from "../rendering/StageRenderer";
import type { AppAction } from "../types";
import type { VjUiActions } from "./bindings/VjUiActions";

interface VjUiActionDependencies {
  app: Application;
  clock: BeatClock;
  cueEngine: CueEngine;
  router: InputRouter;
  slots: SlotStore;
  stage: StageRenderer;
  assignments: MediaAssignmentController;
  handleAction: (action: AppAction) => void;
  selectSlot: (index: number, shouldLog?: boolean) => void;
  log: (message: string) => void;
}

/** アプリの各機能をUI向けの操作インターフェースへ変換する */
export function createVjUiActions(dependencies: VjUiActionDependencies): VjUiActions {
  const { app, clock, cueEngine, router, slots, stage, assignments, log } = dependencies;
  return {
    handleAction: dependencies.handleAction,
    selectSlot: dependencies.selectSlot,
    setBpm: (value) => {
      clock.setBpm(value);
      log(`BPM ${clock.bpm.toFixed(2)}`);
      return clock.bpm;
    },
    cycleQuantize: () => cueEngine.cycleQuantize(),
    setOffset: (value) => {
      clock.setOffsetMs(value);
      log(`OFFSET ${clock.offsetMs}ms`);
      return clock.offsetMs;
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
    enableMidi: () => router.enableMidi(),
    log,
  };
}
