import "pixi.js/prepare";
import { Application, Container } from "pixi.js";
import { BeatClock } from "./BeatClock";
import { CueEngine, type SecretLane } from "./cues/CueEngine";
import { InputRouter } from "./InputRouter";
import { MediaAssignmentController } from "./media/MediaAssignmentController";
import { SlotStore } from "./media/SlotStore";
import { ForegroundRenderer } from "./rendering/ForegroundRenderer";
import { StageRenderer } from "./rendering/StageRenderer";
import { EFFECTS, type AppAction, type EffectId } from "./types";
import { VjUiController } from "./ui/VjUiController";
import { VjUiBindings } from "./ui/VjUiBindings";
import { createVjUiActions } from "./ui/createVjUiActions";

export class VJApp {
  readonly app = new Application();
  readonly root = new Container();
  width = 1280;
  height = 720;

  private slotStore = new SlotStore(8);
  private selectedSlot = 0;
  private clock = new BeatClock();
  private stageRenderer = new StageRenderer(this.slotStore, this.clock);
  private foregroundRenderer = new ForegroundRenderer(
    this.root,
    this.slotStore,
    this.clock,
    (amount) => this.uiController.flash(amount),
  );
  private cueEngine = new CueEngine(this.clock, {
    hasCue: (cue) => this.slotStore.hasCue(cue),
    hasImage: (slot) => this.slotStore.hasImage(slot),
    randomImageSlot: () => this.slotStore.randomImageSlot(),
    playCue: (cue, strength) => this.playCueNow(cue, strength),
    playSecret: (slot, lane) => this.playSecretNow(slot, lane),
    playLatchedPulse: (cue, strength, wholeBeat) => this.playLatchedPulse(cue, strength, wholeBeat),
    immediateFeedback: (effect) => this.immediateFeedback(effect),
    flash: (amount) => this.uiController.flash(amount),
    setLatchVisual: (cue, active) => this.setLatchVisual(cue, active),
    onRecordStateChange: () => this.updateRecordButton(),
    onClear: () => this.handleClearAction(),
    log: (message) => this.logAction(message),
  });
  private router = new InputRouter((action) => this.handleAction(action));
  private uiController!: VjUiController;
  private mediaAssignments!: MediaAssignmentController;
  private lastHudUpdate = 0;
  private lifecycleAbort = new AbortController();
  private initialized = false;

  /** Pixiのフレーム更新を各責務へ振り分ける */
  private onTick = (): void => {
    const now = performance.now();
    this.router.pollGamepads();
    this.updateAnimatedGifs(now);
    this.foregroundRenderer.update(now);
    this.cueEngine.update(now);
    this.stageRenderer.update(
      now,
      this.foregroundRenderer.activeSlot,
      this.foregroundRenderer.presenceUntil,
      this.cueEngine.latchedCueNumbers(),
    );
    this.updateBpmGraph(now);
    this.updateHud(now);
  };

  /** PixiJSとUIと入力監視を初期化する */
  async init(host: HTMLElement): Promise<void> {
    if (this.initialized) return;
    await this.app.init({
      resizeTo: window,
      backgroundAlpha: 0,
      antialias: true,
      // HiDPIで見えない過剰解像度を描画せずフレーム時間を安定させる
      resolution: this.renderResolution(),
      autoDensity: true,
    });

    this.app.canvas.id = "vj-canvas";
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.root);
    this.root.addChild(
      this.stageRenderer.ambientLayer,
      this.stageRenderer.backgroundLayer,
      this.foregroundRenderer.fxLayer,
      this.stageRenderer.latchedLayer,
      this.foregroundRenderer.actorLayer,
      this.foregroundRenderer.secretLayer,
    );
    this.createUi(host);
    this.resize();
    window.addEventListener("resize", () => this.resize(), { signal: this.lifecycleAbort.signal });
    this.router.start();

    // 入力や音声や拍は実時間基準なので通常は描画上限を設けず必要時だけ60 FPSへ制限する
    this.app.ticker.maxFPS = 0;
    this.app.ticker.add(this.onTick);
    this.initialized = true;
  }

  /** 入力監視とタイマーとDOMとメディアとPixiリソースを解放する */
  destroy(): void {
    if (!this.initialized) return;
    this.initialized = false;
    this.lifecycleAbort.abort();
    this.router.destroy();
    this.mediaAssignments.destroy();
    this.app.ticker.remove(this.onTick);
    this.cueEngine.destroy();
    this.foregroundRenderer.destroy();
    this.stageRenderer.destroy();
    this.slotStore.destroy();
    this.uiController.destroy();
    this.app.destroy({ removeView: true }, { children: true });
  }

  /** 画面サイズとDPRから負荷を抑えた描画解像度を決める */
  private renderResolution(): number {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    // バッキングバッファをWQHD相当までに抑えて高DPI環境のGPU負荷を制限する
    const maxPixels = 2560 * 1440;
    const pixelBound = Math.sqrt(maxPixels / (width * height));
    return Math.max(0.65, Math.min(window.devicePixelRatio || 1, 1.5, pixelBound));
  }

  /** 直近8件の操作ログを新しいほど濃く表示する */
  private logAction(message: string): void {
    this.uiController?.log(message);
  }

  /** 指定スロットのトリム済み音声を入力強度に応じて再生する */
  private playCueAudio(index: number, strength = 1): void {
    this.slotStore.playAudio(index, strength);
  }

  /** 共通入力アクションを解除やラッチやキュー発火へ振り分ける */
  private handleAction(action: AppAction): void {
    this.slotStore.resumeAudio();
    this.cueEngine.handleAction(action);
  }

  /** キューの音声と画像演出を実際に再生する */
  private playCueNow(cue: number, strength = 1): void {
    const effect = EFFECTS[cue];
    const slot = this.slotStore.get(cue);
    if (!effect || (!slot?.texture && !slot?.audioBuffer)) return;
    this.slotStore.activateGif(cue, performance.now() + 900);
    this.playCueAudio(cue, strength);
    if (!slot.texture || !this.foregroundRenderer.playCue(cue, effect, strength)) return;
    this.stageRenderer.setAmbientSlot(cue);
    this.stageRenderer.seedBackgroundCharacters(cue);
  }

  /** 9番のGRAVITY演出を指定スロットで再生する */
  private playSecretNow(
    slot: number,
    lane?: SecretLane,
  ): void {
    if (!this.foregroundRenderer.playSecret(slot, lane)) return;
    this.stageRenderer.setAmbientSlot(slot);
    this.stageRenderer.seedBackgroundCharacters(slot);
  }

  /** 録音とループ状態を操作ボタンへ反映する */
  private updateRecordButton(): void {
    this.uiController?.setRecordState(this.cueEngine.isRecording, this.cueEngine.isLooping);
  }

  /** ラッチ表示スプライトとキューボタンの状態を更新する */
  private setLatchVisual(cue: number, active: boolean): void {
    this.stageRenderer.setLatchVisual(cue, active);
    this.uiController?.setLatchState(cue, active);
  }

  /** ラッチ拍で音声と背景補助演出を再生する */
  private playLatchedPulse(cue: number, strength: number, wholeBeat: number): void {
    this.playCueAudio(cue, strength);
    this.stageRenderer.seedBackgroundCharacters(cue);
    if (cue === 3) this.foregroundRenderer.shake(10 * strength, 150);
    else if (cue === 7 && wholeBeat % 2 === 0) this.uiController.flash(0.18);
  }

  /** 割り当て画面または全演出を現在の表示状態に応じてクリアする */
  private handleClearAction(): void {
    if (this.mediaAssignments.isOpen) {
      this.mediaAssignments.confirm();
      return;
    }
    this.clearAllAnimations();
  }

  /** 演出と音声と自動再生状態をまとめて初期化する */
  private clearAllAnimations(): void {
    this.cueEngine.clear();
    this.foregroundRenderer.clear();
    this.stageRenderer.clear();
    this.slotStore.stopAudio();
    this.uiController.clearFeedback();
    this.logAction("ENTER / ALL ANIMATIONS CLEAR");
  }

  /** クオンタイズ待ちの前に入力受付を短い枠線アニメーションで示す */
  private immediateFeedback(effect: EffectId): void {
    this.uiController.immediateFeedback(effect);
  }

  /** 直近12秒のBPM履歴を100ms間隔でグラフへ反映する */
  private updateBpmGraph(now: number): void {
    this.uiController.updateBpmGraph(now, this.clock.bpm);
  }

  /** 全体または現在スロットだけの表示サイズを調整する */
  private adjustActiveScale(delta: number, individual = false): void {
    const index = this.foregroundRenderer.activeSlot ?? this.selectedSlot;
    const scale = this.slotStore.adjustScale(index, delta, individual);
    this.logAction(individual
      ? `CUE ${index + 1} SIZE ${Math.round(scale * 100)}%`
      : `ALL SIZE ${Math.round(scale * 100)}%`);
    this.foregroundRenderer.fit();
    this.stageRenderer.fitAmbient(this.foregroundRenderer.activeSlot);
  }

  /** 全体または現在スロットだけの表示基準位置を調整する */
  private moveActiveAnchor(dx: number, dy: number, individual = false): void {
    const index = this.foregroundRenderer.activeSlot ?? this.selectedSlot;
    const transform = this.slotStore.moveAnchor(index, dx, dy, individual);
    this.logAction(individual
      ? `CUE ${index + 1} POS ${Math.round(transform.anchorX * 100)},${Math.round(transform.anchorY * 100)}`
      : `ALL POS ${Math.round(transform.anchorX * 100)},${Math.round(transform.anchorY * 100)}`);
    this.foregroundRenderer.fit();
    this.stageRenderer.fitAmbient(this.foregroundRenderer.activeSlot);
  }

  /** HUDと操作パネルと割り当て画面を生成してイベントを接続する */
  private createUi(host: HTMLElement): void {
    this.uiController = new VjUiController(host);
    const ui = this.uiController.elements;
    this.mediaAssignments = new MediaAssignmentController({
      host,
      ui,
      slots: this.slotStore,
      foreground: this.foregroundRenderer,
      stage: this.stageRenderer,
      signal: this.lifecycleAbort.signal,
      getSelectedSlot: () => this.selectedSlot,
      selectSlot: (index) => this.selectSlot(index),
      uploadTexture: (texture) => this.app.renderer.prepare.upload(texture),
      log: (message) => this.logAction(message),
    });
    const actions = createVjUiActions({
      app: this.app,
      clock: this.clock,
      cueEngine: this.cueEngine,
      router: this.router,
      slots: this.slotStore,
      stage: this.stageRenderer,
      assignments: this.mediaAssignments,
      handleAction: (action) => this.handleAction(action),
      adjustScale: (delta, individual) => this.adjustActiveScale(delta, individual),
      moveAnchor: (dx, dy, individual) => this.moveActiveAnchor(dx, dy, individual),
      selectSlot: (index, shouldLog) => this.selectSlot(index, shouldLog),
      log: (message) => this.logAction(message),
    });
    new VjUiBindings(host, this.uiController, actions, this.lifecycleAbort.signal);
  }

  /** 操作対象のスロットを選択してパネル表示を更新する */
  private selectSlot(index: number, shouldLog = true): void {
    this.selectedSlot = index;
    this.foregroundRenderer.selectSlot(index);
    this.uiController.elements.slotElements.forEach((element, i) => element.classList.toggle("selected", i === index));
    if (shouldLog) this.logAction(`SELECT SLOT ${index + 1}`);
  }

  /** 表示中またはラッチ中のGIFだけ次フレームへ進める */
  private updateAnimatedGifs(now: number): void {
    this.slotStore.updateAnimatedGifs(now, (index) => this.cueEngine.isLatched(index));
  }

  /** ウィンドウサイズ変更後の座標とフィット率を更新する */
  private resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.slotStore.resize(this.width, this.height);
    this.foregroundRenderer.resize(this.width, this.height);
    this.stageRenderer.resize(this.width, this.height, this.foregroundRenderer.activeSlot);
  }

  /** ライブ状態を一定間隔でHUDへ反映する */
  private updateHud(now: number): void {
    // テキストDOMを毎フレーム更新せず描画負荷を抑える
    if (now - this.lastHudUpdate < 80) return;
    this.lastHudUpdate = now;
    const position = this.clock.barBeat(now);
    const activeSlot = this.foregroundRenderer.activeSlot;
    const live = activeSlot === null ? "—" : String(activeSlot + 1);
    const mode = this.cueEngine.isRecording ? "REC 2 BARS" : this.cueEngine.isLooping ? "LOOP 2 BARS" : "LIVE";
    const auto = this.cueEngine.latchedCueNumbers().map((cue) => cue + 1).join(",") || "—";
    const target = this.slotStore.transformFor(activeSlot ?? this.selectedSlot);
    this.uiController.updateHud({
      bpm: this.clock.bpm,
      bar: position.bar,
      beat: position.beat,
      phase: position.phase,
      quantize: this.cueEngine.quantize,
      liveCue: live,
      autoCues: auto,
      mode,
      scale: target.scale,
      anchorX: target.anchorX,
      anchorY: target.anchorY,
    });
  }
}
