import "pixi.js/prepare";
import { Application, Container, Sprite, Texture } from "pixi.js";
import { BeatClock } from "./BeatClock";
import { CueEngine, type SecretLane } from "./cues/CueEngine";
import { playEffect, type EffectHost } from "./effects";
import { InputRouter } from "./InputRouter";
import { SlotStore } from "./media/SlotStore";
import { StageRenderer } from "./rendering/StageRenderer";
import { AnimationScheduler } from "./services/AnimationScheduler";
import { createPanelPreview } from "./services/ImageLoader";
import { EFFECTS, type AppAction, type EffectId } from "./types";
import { queryRequired } from "./ui/createVjUi";
import { VjUiController } from "./ui/VjUiController";

export class VJApp implements EffectHost {
  readonly app = new Application();
  readonly root = new Container();
  readonly actorLayer = new Container();
  readonly fxLayer = new Container();
  readonly secretLayer = new Container();
  width = 1280;
  height = 720;

  private activeActor: Sprite | null = null;
  private characterPresenceUntil = 0;
  private slotStore = new SlotStore(8);
  private selectedSlot = 0;
  private activeSlot: number | null = null;
  private clock = new BeatClock();
  private stageRenderer = new StageRenderer(this.slotStore, this.clock);
  private cueEngine = new CueEngine(this.clock, {
    hasCue: (cue) => this.slotStore.hasCue(cue),
    hasImage: (slot) => this.slotStore.hasImage(slot),
    randomImageSlot: () => this.slotStore.randomImageSlot(),
    playCue: (cue, strength) => this.playCueNow(cue, strength),
    playSecret: (slot, lane) => this.playSecretNow(slot, lane),
    playLatchedPulse: (cue, strength, wholeBeat) => this.playLatchedPulse(cue, strength, wholeBeat),
    immediateFeedback: (effect) => this.immediateFeedback(effect),
    flash: (amount) => this.flash(amount),
    setLatchVisual: (cue, active) => this.setLatchVisual(cue, active),
    onRecordStateChange: () => this.updateRecordButton(),
    onClear: () => this.handleClearAction(),
    log: (message) => this.logAction(message),
  });
  private router = new InputRouter((action) => this.handleAction(action));
  private animation = new AnimationScheduler();
  private uiController!: VjUiController;
  private panel!: HTMLElement;
  private slotElements: HTMLElement[] = [];
  private cueButtons: HTMLButtonElement[] = [];
  private keyGuide!: HTMLElement;
  private virtualShift = false;
  private resetGeneration = 0;
  private fxPool: Sprite[] = [];
  private lastHudUpdate = 0;
  private limitFps60 = false;
  private hideBackground = false;
  private skipAssign = false;
  private assignOverlay!: HTMLElement;
  private assignSources!: HTMLElement;
  private assignTargets!: HTMLElement;
  private pendingAssignments: Array<{ id: number; file: File; kind: "IMG" | "SFX"; preview: string }> = [];
  private nextPendingAssignmentId = 1;
  private panelWasHiddenBeforeAssign = false;
  private dropOverlaySuppressed = false;
  private lifecycleAbort = new AbortController();
  private initialized = false;

  /** Pixiのフレーム更新を各責務へ振り分ける */
  private onTick = (): void => {
    const now = performance.now();
    this.router.pollGamepads();
    this.updateAnimatedGifs(now);
    this.animation.update(now);
    this.cueEngine.update(now);
    this.stageRenderer.update(now, this.activeSlot, this.characterPresenceUntil, this.cueEngine.latchedCueNumbers());
    this.updateBpmGraph(now);
    this.updateHud(now);
    if (this.activeActor && now > this.characterPresenceUntil) this.activeActor.visible = false;
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
      this.fxLayer,
      this.stageRenderer.latchedLayer,
      this.actorLayer,
      this.secretLayer,
    );
    this.createUi(host);
    this.resize();
    window.addEventListener("resize", () => this.resize(), { signal: this.lifecycleAbort.signal });
    this.setupDrop(host);
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
    this.app.ticker.remove(this.onTick);
    this.animation.clear();
    this.cueEngine.destroy();
    this.stageRenderer.destroy();
    this.slotStore.destroy();
    this.uiController.destroy();
    this.app.destroy({ removeView: true }, { children: true });
    this.fxPool = [];
  }

  /** 演出対象のアクターを返す */
  getCharacter(): Sprite | null {
    return this.activeActor;
  }

  /** 非同期演出を無効化するためのリセット世代を返す */
  getResetGeneration(): number {
    return this.resetGeneration;
  }

  /** 指定スロットの確定済み表示変形を返す */
  private transformFor(index: number): { scale: number; anchorX: number; anchorY: number } {
    return this.slotStore.transformFor(index);
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

  /** 現在アクターの画面座標と表示スケールを返す */
  getActorPlacement(): { x: number; y: number; scale: number } {
    const index = this.activeSlot ?? this.selectedSlot;
    const transform = this.transformFor(index);
    const fit = this.slotStore.fitScaleFor(index);
    return {
      x: this.width * transform.anchorX,
      y: this.height * transform.anchorY,
      scale: fit * transform.scale,
    };
  }

  /** 残像用に現在キャラクターのスプライトを借りて配置する */
  cloneCharacter(alpha = 1): Sprite | null {
    const slot = this.activeSlot === null ? null : this.slotStore.get(this.activeSlot);
    if (!slot?.texture) return null;
    const sprite = this.acquireFxSprite(slot.texture);
    const placement = this.getActorPlacement();
    sprite.position.set(placement.x, placement.y);
    sprite.scale.set(placement.scale);
    sprite.alpha = alpha;
    return sprite;
  }

  /** 毎フレーム更新する時間ベースのアニメーションを登録する */
  animate(
    duration: number,
    update: (t: number) => void,
    complete?: () => void,
    isActive: () => boolean = () => true,
  ): void {
    this.animation.animate(duration, update, complete, isActive);
  }

  /** プールから演出用スプライトを取得して初期状態へ戻す */
  private acquireFxSprite(texture: Texture): Sprite {
    const sprite = this.fxPool.pop() ?? new Sprite(texture);
    sprite.texture = texture;
    sprite.anchor.set(0.5);
    sprite.position.set(0, 0);
    sprite.scale.set(1);
    sprite.rotation = 0;
    sprite.alpha = 1;
    sprite.visible = true;
    this.fxLayer.addChild(sprite);
    return sprite;
  }

  /** 演出用スプライトを再利用プールへ返す */
  private releaseFxSprite(sprite: Sprite): void {
    if (sprite.destroyed) return;
    sprite.removeFromParent();
    sprite.visible = false;
    sprite.alpha = 1;
    sprite.rotation = 0;
    // 長時間運用でプールが増え続けないよう同時演出数に十分な48個へ制限する
    if (this.fxPool.length < 48) this.fxPool.push(sprite);
    else sprite.destroy();
  }

  /** スプライトを拡大しながらフェードさせて残像として解放する */
  addAfterimage(sprite: Sprite, lifetimeMs: number): void {
    const initialAlpha = sprite.alpha;
    const initialScaleX = sprite.scale.x;
    const initialScaleY = sprite.scale.y;
    this.animate(lifetimeMs, (t) => {
      sprite.alpha = initialAlpha * (1 - t);
      const grow = 1 + t * 0.06;
      sprite.scale.set(initialScaleX * grow, initialScaleY * grow);
    }, () => this.releaseFxSprite(sprite), () => !sprite.destroyed);
  }

  /** ルート全体へ減衰するランダム揺れを加える */
  shake(amount: number, durationMs: number): void {
    const generation = this.resetGeneration;
    this.animate(durationMs, (t) => {
      const power = amount * (1 - t);
      this.root.position.set((Math.random() - 0.5) * power, (Math.random() - 0.5) * power);
    }, () => this.root.position.set(0, 0), () => generation === this.resetGeneration);
  }

  /** 後から一括解除できる遅延処理を登録する */
  schedule(callback: () => void, delayMs: number): void {
    this.animation.schedule(callback, delayMs);
  }

  /** 画面を瞬時に明るくしてフェードアウトさせる */
  flash(amount = 0.55): void {
    this.uiController.flash(amount);
  }

  /** 音声ファイルをデコードして指定スロットへ割り当てる */
  private async assignAudioFile(index: number, file: File): Promise<void> {
    if (!file.type.startsWith("audio/")) return;
    const assignment = await this.slotStore.assignAudio(index, file);
    const el = this.slotElements[index];
    const audioLabel = el.querySelector<HTMLElement>("[data-audio]");
    if (audioLabel) audioLabel.textContent = `SFX ${file.name.replace(/\.[^.]+$/, "").slice(0, 10)}`;
    this.logAction(`SFX ${index + 1} ${assignment.name} / TRIM ${Math.round(assignment.trimmedMs)}ms`);
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
    if (!slot.texture || !this.activateSlot(cue)) return;
    this.stageRenderer.setAmbientSlot(cue);
    this.stageRenderer.seedBackgroundCharacters(cue);
    playEffect(effect, this, strength);
    this.characterPresenceUntil = performance.now() + 720;
  }

  /** 9番のGRAVITY演出を指定スロットで再生する */
  private playSecretNow(
    slot: number,
    lane?: SecretLane,
  ): void {
    const texture = this.slotStore.get(slot).texture;
    if (!texture) return;
    this.activeSlot = slot;
    this.stageRenderer.setAmbientSlot(slot);
    this.stageRenderer.seedBackgroundCharacters(slot);

    const sprite = this.acquireFxSprite(texture);
    // 9番演出を通常アクターやラッチ列や他の演出より常に前面へ出す
    this.secretLayer.addChild(sprite);
    const transform = this.transformFor(slot);
    const fit = this.slotStore.fitScaleFor(slot);
    const baseScale = fit * transform.scale * 1.5;
    const laneCount = Math.max(1, lane?.count ?? 1);
    const laneColumn = Math.max(0, Math.min(laneCount - 1, lane?.column ?? 0));
    const laneWidth = this.width / laneCount;
    const centerX = lane
      ? this.width * ((laneColumn + 0.5) / laneCount) + this.width * (transform.anchorX - 0.5)
      : this.width * transform.anchorX;
    // 視線が散らないよう横移動は小さく保ち左右の変化だけランダムにする
    const horizontalBasis = lane ? laneWidth : this.width;
    const driftMagnitude = horizontalBasis * (0.02 + Math.random() * 0.04);
    const horizontalDrift = driftMagnitude * (Math.random() < 0.5 ? -1 : 1);
    const startX = centerX - horizontalDrift * 0.5;
    const endX = centerX + horizontalDrift * 0.5;
    const anchorY = this.height * transform.anchorY;
    const startY = anchorY + this.height * 0.14;
    const arcHeight = this.height * 0.22;
    sprite.position.set(startX, startY);
    sprite.scale.set(baseScale);

    const start = performance.now();
    const duration = this.clock.msPerBeat;
    this.slotStore.activateGif(slot, start + duration + 100);
    this.characterPresenceUntil = Math.max(this.characterPresenceUntil, start + duration);
    this.animate(duration, (t) => {
      // 同じ放物線を時間変換してゆっくり上昇し素早く落下する重さを作る
      const risePower = 1.6;
      const fallPower = 0.72;
      const timeBias = 1.4783532205046865;
      const ta = Math.pow(Math.max(0, t), risePower);
      const tb = timeBias * Math.pow(Math.max(0, 1 - t), fallPower);
      const s = ta + tb > 0 ? ta / (ta + tb) : 1;
      const x = startX + (endX - startX) * s;
      const y = startY - 4 * arcHeight * s * (1 - s);
      const motionPhase = 2 * s - 1;
      const stretch = s < 0.5
        ? 0.012 * (s / 0.5)
        : Math.min(0.075, Math.pow((s - 0.5) / 0.5, 1.5) * 0.075);
      const sx = 1 - stretch * 0.22;
      const sy = 1 + stretch;
      const alpha = t < 0.1 ? t / 0.1 : t > 0.96 ? (1 - t) / 0.04 : 1;
      sprite.position.set(x, y);
      sprite.rotation = motionPhase * 0.008;
      sprite.scale.set(baseScale * sx, baseScale * sy);
      sprite.alpha = Math.max(0, Math.min(1, alpha));
    }, () => this.releaseFxSprite(sprite), () => !sprite.destroyed);
  }

  /** 録音とループ状態を操作ボタンへ反映する */
  private updateRecordButton(): void {
    this.uiController?.setRecordState(this.cueEngine.isRecording, this.cueEngine.isLooping);
  }

  /** 録音操作をキューエンジンへ委譲する */
  private toggleRecord(): void {
    this.cueEngine.toggleRecord();
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
    if (cue === 3) this.shake(10 * strength, 150);
    else if (cue === 7 && wholeBeat % 2 === 0) this.flash(0.18);
  }

  /** 割り当て画面または全演出を現在の表示状態に応じてクリアする */
  private handleClearAction(): void {
    if (!this.assignOverlay.hidden) {
      const remaining = this.pendingAssignments.length;
      this.closeAssignOverlay(true);
      this.logAction(`D&D ASSIGN CONFIRM${remaining ? ` / SKIP ${remaining}` : ""}`);
      return;
    }
    this.clearAllAnimations();
  }

  /** 演出と音声と自動再生状態をまとめて初期化する */
  private clearAllAnimations(): void {
    this.resetGeneration += 1;
    this.animation.clear();
    this.cueEngine.clear();

    this.characterPresenceUntil = 0;
    if (this.activeActor) this.activeActor.visible = false;
    this.activeSlot = null;
    this.stageRenderer.clear();

    const pooledChildren = [
      ...this.fxLayer.removeChildren(),
      ...this.secretLayer.removeChildren(),
    ];
    for (const child of pooledChildren) {
      if (child instanceof Sprite && !child.destroyed && this.fxPool.length < 48) {
        child.visible = false;
        this.fxPool.push(child);
      } else {
        child.destroy();
      }
    }
    this.slotStore.stopAudio();
    this.root.position.set(0, 0);
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
    const index = this.activeSlot ?? this.selectedSlot;
    const scale = this.slotStore.adjustScale(index, delta, individual);
    this.logAction(individual
      ? `CUE ${index + 1} SIZE ${Math.round(scale * 100)}%`
      : `ALL SIZE ${Math.round(scale * 100)}%`);
    this.fitActor();
    this.stageRenderer.fitAmbient(this.activeSlot);
  }

  /** 全体または現在スロットだけの表示基準位置を調整する */
  private moveActiveAnchor(dx: number, dy: number, individual = false): void {
    const index = this.activeSlot ?? this.selectedSlot;
    const transform = this.slotStore.moveAnchor(index, dx, dy, individual);
    this.logAction(individual
      ? `CUE ${index + 1} POS ${Math.round(transform.anchorX * 100)},${Math.round(transform.anchorY * 100)}`
      : `ALL POS ${Math.round(transform.anchorX * 100)},${Math.round(transform.anchorY * 100)}`);
    this.fitActor();
    this.stageRenderer.fitAmbient(this.activeSlot);
  }

  /** 実キーまたは仮想キーの押下状態をガイドへ反映する */
  private setKeyVisual(code: string, active: boolean): void {
    this.uiController.setKeyVisual(code, active);
  }

  /** クリック操作用のShiftトグル状態を更新する */
  private setVirtualShift(active: boolean): void {
    this.virtualShift = active;
    this.uiController.setVirtualShift(active);
  }

  /** ガイド上のキー押下を実キーボードと同じ操作へ変換する */
  private virtualKeyDown(code: string, sourceId: string): boolean {
    this.slotStore.resumeAudio();
    const cue = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (cue) {
      this.handleAction({
        type: "cue",
        cue: Number(cue[1]) - 1,
        phase: "down",
        source: "ui",
        sourceId,
        strength: 1,
        latchToggle: this.virtualShift,
      });
      // ラッチ操作は押し続ける概念がないため通常キューだけ解放通知を要求する
      return !this.virtualShift;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(code)) {
      this.moveActiveAnchor(
        code === "ArrowLeft" ? -0.025 : code === "ArrowRight" ? 0.025 : 0,
        code === "ArrowUp" ? -0.025 : code === "ArrowDown" ? 0.025 : 0,
        this.virtualShift,
      );
      return false;
    }
    if (code === "Equal" || code === "NumpadAdd") {
      this.adjustActiveScale(0.1, this.virtualShift);
      return false;
    }
    if (code === "Minus" || code === "NumpadSubtract") {
      this.adjustActiveScale(-0.1, this.virtualShift);
      return false;
    }
    if (code === "Enter") {
      this.handleAction({ type: "clear", source: "keyboard" });
      return false;
    }
    if (code === "Escape") {
      if (this.cancelDropOverlay()) return false;
      if (!this.assignOverlay.hidden) {
        this.closeAssignOverlay(true);
        return false;
      }
      this.panel.classList.toggle("hidden");
      this.logAction(this.panel.classList.contains("hidden") ? "MENU HIDE" : "MENU SHOW");
      return false;
    }
    if (code === "Space") {
      if (this.virtualShift) {
        this.clock.sync();
        this.logAction("SYNC");
      } else {
        const value = this.clock.tap();
        const bpmInput = this.panel.querySelector<HTMLInputElement>("[data-field=bpm]");
        if (bpmInput) bpmInput.value = value.toFixed(2);
        this.logAction(`TAP ${this.clock.bpm.toFixed(2)}`);
      }
      return false;
    }
    if (code === "KeyR") {
      this.toggleRecord();
      return false;
    }
    return false;
  }

  /** 画面内キーボードへクリックと長押し操作を設定する */
  private setupKeyGuide(): void {
    for (const button of this.keyGuide.querySelectorAll<HTMLButtonElement>("button[data-code]")) {
      const code = button.dataset.code!;
      if (code === "ShiftLeft") {
        button.addEventListener("click", () => this.setVirtualShift(!this.virtualShift));
        continue;
      }
      let held = false;
      const sourceId = `ui:${code}`;
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        button.setPointerCapture?.(event.pointerId);
        this.setKeyVisual(code, true);
        held = this.virtualKeyDown(code, sourceId);
      });
      /** 仮想キーの押下表示と長押し状態を解除する */
      const end = () => {
        this.setKeyVisual(code, false);
        if (!held) return;
        this.handleAction({ type: "cue", cue: Number(/([1-9])$/.exec(code)?.[1] ?? 1) - 1, phase: "up", source: "ui", sourceId, strength: 1 });
        held = false;
      };
      button.addEventListener("pointerup", end);
      button.addEventListener("pointercancel", end);
    }
  }

  /** HUDと操作パネルと割り当て画面を生成してイベントを接続する */
  private createUi(host: HTMLElement): void {
    this.uiController = new VjUiController(host);
    const ui = this.uiController.elements;
    this.keyGuide = ui.keyGuide;
    this.panel = ui.panel;
    this.assignOverlay = ui.assignOverlay;
    this.assignSources = ui.assignSources;
    this.assignTargets = ui.assignTargets;
    this.slotElements = ui.slotElements;
    this.cueButtons = ui.cueButtons;
    this.setupKeyGuide();

    // キャンセル時は未割り当て素材を残さず通常画面へ戻す
    queryRequired<HTMLElement>(this.assignOverlay, "[data-action=cancel-assign]").addEventListener("click", () => this.closeAssignOverlay(true));
    [...this.assignTargets.children].forEach((targetElement, index) => {
      const target = targetElement as HTMLElement;
      target.addEventListener("dragover", (event) => { event.preventDefault(); target.classList.add("drag"); });
      target.addEventListener("dragleave", () => target.classList.remove("drag"));
      // 割り当て画面の素材IDを受け取り元のFileを対象スロットへ渡す
      target.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.remove("is-dragging");
        target.classList.remove("drag");
        const id = event.dataTransfer?.getData("text/pending-id");
        if (id) void this.assignPendingToSlot(id, index);
      });
    });

    this.slotElements.forEach((slot, index) => {
      slot.addEventListener("click", () => this.selectSlot(index));
      slot.addEventListener("dragover", (event) => { event.preventDefault(); slot.classList.add("drag"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("drag"));
      // パネル上への直接ドロップは全画面割り当てを経由せず即時反映する
      slot.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        slot.classList.remove("drag");
        const file = event.dataTransfer?.files[0];
        if (file) void this.assignFile(index, file);
      });
    });

    this.cueButtons.forEach((button, index) => {
      button.addEventListener("click", (event) => {
        this.cueEngine.trigger(index, 1, event.shiftKey);
      });
    });

    const bpm = this.panel.querySelector<HTMLInputElement>("[data-field=bpm]")!;
    bpm.addEventListener("change", () => { this.clock.setBpm(Number(bpm.value)); this.logAction(`BPM ${this.clock.bpm.toFixed(2)}`); });
    const quantizeButton = this.panel.querySelector<HTMLButtonElement>("[data-action=quantize]")!;
    // 選択肢が少ないためプルダウンではなくクリックで順番に切り替える
    quantizeButton.addEventListener("click", () => {
      const label = this.cueEngine.cycleQuantize();
      quantizeButton.textContent = `Q ${label}`;
    });
    const offset = this.panel.querySelector<HTMLInputElement>("[data-field=offset]")!;
    offset.addEventListener("change", () => { this.clock.setOffsetMs(Number(offset.value)); this.logAction(`OFFSET ${Number(offset.value)}ms`); });
    const fpsLimit = this.panel.querySelector<HTMLInputElement>("[data-field=limit-fps]")!;
    fpsLimit.addEventListener("change", () => {
      this.limitFps60 = fpsLimit.checked;
      this.app.ticker.maxFPS = this.limitFps60 ? 60 : 0;
      this.logAction(this.limitFps60 ? "60 FPS LIMIT ON" : "60 FPS LIMIT OFF");
    });
    const hideBackground = this.panel.querySelector<HTMLInputElement>("[data-field=hide-background]")!;
    hideBackground.addEventListener("change", () => {
      this.hideBackground = hideBackground.checked;
      this.stageRenderer.setBackgroundVisible(!this.hideBackground);
      host.classList.toggle("background-hidden", this.hideBackground);
      this.logAction(this.hideBackground ? "BACKGROUND HIDDEN" : "BACKGROUND SHOWN");
    });
    const skipAssign = this.panel.querySelector<HTMLInputElement>("[data-field=skip-assign]")!;
    skipAssign.addEventListener("change", () => {
      this.skipAssign = skipAssign.checked;
      this.logAction(this.skipAssign ? "D&D ASSIGN SKIP ON" : "D&D ASSIGN SKIP OFF");
    });
    const masterVolume = this.panel.querySelector<HTMLInputElement>("[data-field=master-volume]")!;
    const masterVolumeValue = this.panel.querySelector<HTMLElement>("[data-field=master-volume-value]")!;
    masterVolume.addEventListener("input", () => {
      this.slotStore.setVolume(Number(masterVolume.value) / 100);
      masterVolumeValue.textContent = `${Math.round(this.slotStore.volume * 100)}%`;
    });
    masterVolume.addEventListener("change", () => {
      this.logAction(`SFX VOLUME ${Math.round(this.slotStore.volume * 100)}%`);
    });

    this.panel.querySelector("[data-action=tap]")!.addEventListener("click", () => {
      bpm.value = this.clock.tap().toFixed(2);
      this.logAction(`TAP ${this.clock.bpm.toFixed(2)}`);
    });
    this.panel.querySelector("[data-action=sync]")!.addEventListener("click", () => { this.clock.sync(); this.logAction("SYNC"); });
    this.panel.querySelector("[data-action=hide]")!.addEventListener("click", () => { this.panel.classList.add("hidden"); this.logAction("MENU HIDE"); });
    this.panel.querySelector<HTMLButtonElement>("[data-action=record]")!.addEventListener("click", () => this.toggleRecord());
    this.panel.querySelector("[data-action=fullscreen]")!.addEventListener("click", () => { this.logAction("FULLSCREEN"); void document.documentElement.requestFullscreen?.(); });
    this.panel.querySelector("[data-action=midi]")!.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      try {
        const names = await this.router.enableMidi();
        button.textContent = names.length ? `MIDI: ${names.length} INPUT` : "MIDI: READY";
        this.logAction(`MIDI READY ${names.length}`);
      } catch (error) {
        button.textContent = error instanceof Error ? error.message : "MIDI ERROR";
        this.logAction("MIDI ERROR");
      }
    });

    // InputRouter対象外の表示調整やテンポ操作をUI層で処理する
    window.addEventListener("keydown", (event) => {
      this.setKeyVisual(event.code, true);
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) {
        event.preventDefault();
        this.moveActiveAnchor(
          event.code === "ArrowLeft" ? -0.025 : event.code === "ArrowRight" ? 0.025 : 0,
          event.code === "ArrowUp" ? -0.025 : event.code === "ArrowDown" ? 0.025 : 0,
          event.shiftKey,
        );
        return;
      }
      if (event.code === "NumpadAdd" || event.key === "+") {
        event.preventDefault();
        this.adjustActiveScale(0.1, event.shiftKey);
        return;
      }
      if (event.code === "NumpadSubtract" || event.code === "Minus") {
        event.preventDefault();
        this.adjustActiveScale(-0.1, event.shiftKey);
        return;
      }
      if (event.repeat) return;
      if (event.code === "Escape") {
        event.preventDefault();
        if (this.cancelDropOverlay()) return;
        if (!this.assignOverlay.hidden) {
          this.closeAssignOverlay(true);
          return;
        }
        this.panel.classList.toggle("hidden");
        this.logAction(this.panel.classList.contains("hidden") ? "MENU HIDE" : "MENU SHOW");
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        if (event.shiftKey) {
          this.clock.sync();
          this.logAction("SYNC");
        } else {
          bpm.value = this.clock.tap().toFixed(2);
          this.logAction(`TAP ${this.clock.bpm.toFixed(2)}`);
        }
        return;
      }

      if (event.code === "KeyR") {
        event.preventDefault();
        this.toggleRecord();
      }
    }, { capture: true, signal: this.lifecycleAbort.signal });
    window.addEventListener(
      "keyup",
      (event) => this.setKeyVisual(event.code, false),
      { capture: true, signal: this.lifecycleAbort.signal },
    );

    this.makePanelDraggable();
    this.selectSlot(0, false);
  }

  /** パネル見出しをドラッグして画面内で移動できるようにする */
  private makePanelDraggable(): void {
    const head = this.panel.querySelector<HTMLElement>(".panel-head");
    if (!head) return;

    let drag: { pointerId: number; dx: number; dy: number; moved: boolean } | null = null;
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button, input, select")) return;

      const rect = this.panel.getBoundingClientRect();
      this.panel.style.left = `${rect.left}px`;
      this.panel.style.top = `${rect.top}px`;
      this.panel.style.right = "auto";
      this.panel.classList.add("moving");
      drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
      head.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    head.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      // パネルが画面外へ消えて再操作不能にならないよう座標を制限する
      const maxX = Math.max(0, window.innerWidth - this.panel.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - this.panel.offsetHeight);
      const left = Math.max(0, Math.min(maxX, event.clientX - drag.dx));
      const top = Math.max(0, Math.min(maxY, event.clientY - drag.dy));
      this.panel.style.left = `${left}px`;
      this.panel.style.top = `${top}px`;
      drag.moved = true;
    });

    /** パネル移動のポインター追跡を終了する */
    const finish = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      this.panel.classList.remove("moving");
      if (moved) this.logAction("MENU MOVED");
    };
    head.addEventListener("pointerup", finish);
    head.addEventListener("pointercancel", finish);
  }

  /** ドロップ素材を最大16件まで割り当て画面へ読み込む */
  private async openAssignOverlay(files: File[]): Promise<void> {
    // 8スロットへ画像と音声を1件ずつ置ける最大数に制限する
    const valid = files.filter((file) => file.type.startsWith("image/") || file.type.startsWith("audio/")).slice(0, 16);
    if (!valid.length) return;
    this.panelWasHiddenBeforeAssign = this.panel.classList.contains("hidden");
    this.panel.classList.add("hidden");
    this.pendingAssignments = [];
    for (const file of valid) {
      const kind = file.type.startsWith("audio/") ? "SFX" as const : "IMG" as const;
      let preview = "";
      if (kind === "IMG") {
        try { preview = await createPanelPreview(file, 420); } catch { preview = ""; }
      }
      this.pendingAssignments.push({ id: this.nextPendingAssignmentId++, file, kind, preview });
    }
    this.renderAssignOverlay();
    this.logAction(`D&D ASSIGN ${valid.length} FILE${valid.length === 1 ? "" : "S"}`);
  }

  /** 未割り当て素材の一覧を割り当て画面へ再描画する */
  private renderAssignOverlay(): void {
    this.assignOverlay.hidden = this.pendingAssignments.length === 0;
    this.assignSources.replaceChildren();
    for (const item of this.pendingAssignments) {
      const source = document.createElement("button");
      source.type = "button";
      source.className = `assign-source${item.kind === "SFX" ? " audio" : ""}`;
      source.draggable = true;
      if (item.preview) source.style.backgroundImage = `url(${item.preview})`;
      source.innerHTML = `<span class="kind">${item.kind}</span><span class="name"></span>`;
      source.querySelector<HTMLElement>(".name")!.textContent = item.file.name;
      source.addEventListener("dragstart", (event) => {
        source.classList.add("dragging");
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData("text/pending-id", String(item.id));
      });
      source.addEventListener("dragend", () => source.classList.remove("dragging"));
      this.assignSources.appendChild(source);
    }
    this.updateAssignTargets();
    if (this.pendingAssignments.length === 0 && !this.panelWasHiddenBeforeAssign) this.panel.classList.remove("hidden");
  }

  /** 各割り当て先へ現在の画像と音声名を反映する */
  private updateAssignTargets(): void {
    const targets = [...this.assignTargets.children] as HTMLElement[];
    targets.forEach((target, index) => {
      const panelBackground = this.slotElements[index]?.style.backgroundImage ?? "";
      target.style.backgroundImage = panelBackground;
      const names: string[] = [];
      const slot = this.slotStore.get(index);
      if (slot.texture) names.push(`${slot.isGif ? "GIF" : "IMG"} ${slot.name}`);
      if (slot.audioBuffer) names.push(`SFX ${slot.audioName}`);
      const label = target.querySelector("small");
      if (label) label.textContent = names.join(" + ") || "EMPTY";
    });
  }

  /** 必要に応じて未割り当て素材を破棄して割り当て画面を閉じる */
  private closeAssignOverlay(clear: boolean): void {
    if (clear) this.pendingAssignments = [];
    this.renderAssignOverlay();
    this.logAction("D&D ASSIGN CLOSE");
  }

  /** 未割り当て素材をIDで取り出して指定スロットへ移す */
  private async assignPendingToSlot(idText: string, slotIndex: number): Promise<void> {
    const id = Number(idText);
    const index = this.pendingAssignments.findIndex((item) => item.id === id);
    if (index < 0) return;
    const item = this.pendingAssignments[index];
    this.pendingAssignments.splice(index, 1);
    if (item.kind === "SFX") await this.assignAudioFile(slotIndex, item.file);
    else await this.assignFile(slotIndex, item.file);
    this.logAction(`${item.kind} → ${slotIndex + 1} ${item.file.name}`);
    this.renderAssignOverlay();
  }

  /** 表示中の全画面ドロップ案内をEscで抑制する */
  private cancelDropOverlay(): boolean {
    if (!document.body.classList.contains("is-dragging")) return false;
    document.body.classList.remove("is-dragging");
    this.dropOverlaySuppressed = true;
    this.logAction("DROP OVERLAY CANCEL");
    return true;
  }

  /** ステージ全体の画像と音声ドロップ処理を設定する */
  private setupDrop(host: HTMLElement): void {
    host.addEventListener("dragover", (event) => {
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      const overUi = Boolean(target?.closest(".control-panel, .assign-overlay, .key-guide"));
      if (overUi || this.dropOverlaySuppressed) {
        document.body.classList.remove("is-dragging");
        return;
      }
      document.body.classList.add("is-dragging");
    }, { signal: this.lifecycleAbort.signal });
    host.addEventListener("dragleave", (event) => {
      if (event.target === host) {
        document.body.classList.remove("is-dragging");
        this.dropOverlaySuppressed = false;
      }
    }, { signal: this.lifecycleAbort.signal });
    host.addEventListener("drop", (event) => {
      event.preventDefault();
      document.body.classList.remove("is-dragging");
      this.dropOverlaySuppressed = false;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".control-panel, .key-guide")) return;
      // 割り当て画面内の内部ドラッグを新規ファイルドロップとして処理しない
      if (event.dataTransfer?.getData("text/pending-id")) return;
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/") || file.type.startsWith("audio/"));
      if (!files.length) return;
      if (!this.skipAssign) {
        void this.openAssignOverlay(files);
        return;
      }
      const images = files.filter((file) => file.type.startsWith("image/")).slice(0, 8);
      const audio = files.filter((file) => file.type.startsWith("audio/")).slice(0, 8);
      const jobs: Promise<void>[] = [];
      // 単一素材は選択先へ、複数素材は演奏順が分かりやすい1番から割り当てる
      if (images.length === 1) jobs.push(this.assignFile(this.selectedSlot, images[0]));
      else images.forEach((file, index) => jobs.push(this.assignFile(index, file)));
      if (audio.length === 1) jobs.push(this.assignAudioFile(this.selectedSlot, audio[0]));
      else audio.forEach((file, index) => jobs.push(this.assignAudioFile(index, file)));
      if (!jobs.length) return;
      void Promise.all(jobs).then(() => this.selectSlot(images.length > 1 || audio.length > 1 ? 0 : this.selectedSlot));
    }, { signal: this.lifecycleAbort.signal });
  }

  /** 画像またはGIFをデコードして指定スロットへ割り当てる */
  private async assignFile(index: number, file: File): Promise<void> {
    if (file.type.startsWith("audio/")) {
      await this.assignAudioFile(index, file);
      return;
    }
    if (!file.type.startsWith("image/")) return;
    const loaded = await this.slotStore.assignImage(
      index,
      file,
      (texture) => this.app.renderer.prepare.upload(texture),
    );
    const el = this.slotElements[index];
    el.classList.add("loaded");
    el.style.backgroundImage = `url(${loaded.preview})`;
    el.querySelector<HTMLElement>("[data-image]")!.textContent = `${loaded.isGif ? "GIF" : "IMG"} ${file.name.replace(/\.[^.]+$/, "").slice(0, 10)}`;
    const wasActive = this.activeSlot === index;
    if (wasActive) {
      if (this.activeActor && !this.activeActor.destroyed) {
        this.activeActor.texture = loaded.texture;
        this.activeActor.visible = false;
      }
      this.stageRenderer.refreshSlot(index, index);
      this.activeSlot = null;
      this.characterPresenceUntil = 0;
    } else {
      this.stageRenderer.refreshSlot(index, this.activeSlot);
    }
    this.updateAssignTargets();
    this.logAction(`LOAD ${index + 1} ${file.name}${loaded.isGif ? ` / GIF DECODER ${loaded.gifFrameCount}F` : ""}`);
  }

  /** 操作対象のスロットを選択してパネル表示を更新する */
  private selectSlot(index: number, shouldLog = true): void {
    this.selectedSlot = index;
    this.slotElements.forEach((element, i) => element.classList.toggle("selected", i === index));
    if (shouldLog) this.logAction(`SELECT SLOT ${index + 1}`);
  }

  /** 指定スロットを前景アクターとして表示可能な状態へ切り替える */
  private activateSlot(index: number): boolean {
    const texture = this.slotStore.get(index).texture;
    if (!texture) return false;

    if (!this.activeActor) {
      this.activeActor = new Sprite(texture);
      this.activeActor.anchor.set(0.5);
      this.actorLayer.addChild(this.activeActor);
    } else if (this.activeActor.texture !== texture) {
      this.activeActor.texture = texture;
    }
    this.activeSlot = index;

    this.fitActor();
    this.activeActor.visible = true;
    return true;
  }

  /** 前景アクターを現在の基準位置とスケールへ合わせる */
  private fitActor(): void {
    if (!this.activeActor) return;
    const placement = this.getActorPlacement();
    this.activeActor.position.set(placement.x, placement.y);
    this.activeActor.scale.set(placement.scale);
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
    this.fitActor();
    this.stageRenderer.resize(this.width, this.height, this.activeSlot);
  }

  /** ライブ状態を一定間隔でHUDへ反映する */
  private updateHud(now: number): void {
    // テキストDOMを毎フレーム更新せず描画負荷を抑える
    if (now - this.lastHudUpdate < 80) return;
    this.lastHudUpdate = now;
    const position = this.clock.barBeat(now);
    const live = this.activeSlot === null ? "—" : String(this.activeSlot + 1);
    const mode = this.cueEngine.isRecording ? "REC 2 BARS" : this.cueEngine.isLooping ? "LOOP 2 BARS" : "LIVE";
    const auto = this.cueEngine.latchedCueNumbers().map((cue) => cue + 1).join(",") || "—";
    const target = this.transformFor(this.activeSlot ?? this.selectedSlot);
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
