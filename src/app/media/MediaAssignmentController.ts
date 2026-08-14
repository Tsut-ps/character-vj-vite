import type { Texture } from "pixi.js";
import type { ForegroundRenderer } from "../rendering/ForegroundRenderer";
import type { StageRenderer } from "../rendering/StageRenderer";
import { createPanelPreview } from "../services/ImageLoader";
import type { VjUiElements } from "../ui/createVjUi";
import type { SlotStore } from "./SlotStore";

interface PendingAssignment {
  id: number;
  file: File;
  kind: "IMG" | "SFX";
  preview: string;
}

export interface MediaAssignmentOptions {
  host: HTMLElement;
  ui: VjUiElements;
  slots: SlotStore;
  foreground: ForegroundRenderer;
  stage: StageRenderer;
  signal: AbortSignal;
  getSelectedSlot: () => number;
  selectSlot: (index: number) => void;
  uploadTexture: (texture: Texture) => Promise<void>;
  log: (message: string) => void;
}

/** ファイルD&Dと割り当て画面とスロット表示を管理する */
export class MediaAssignmentController {
  private pendingAssignments: PendingAssignment[] = [];
  private nextPendingAssignmentId = 1;
  private panelWasHiddenBeforeAssign = false;
  private dropOverlaySuppressed = false;
  private skipAssign = false;
  private readonly options: MediaAssignmentOptions;

  /** 必要なUIと素材管理処理を受け取ってイベントを接続する */
  constructor(options: MediaAssignmentOptions) {
    this.options = options;
    this.setupAssignmentUi();
    this.setupStageDrop();
  }

  /** 割り当て画面が表示中かどうかを返す */
  get isOpen(): boolean {
    return !this.options.ui.assignOverlay.hidden;
  }

  /** 全画面割り当てを省略する設定を更新する */
  setSkipAssign(enabled: boolean): void {
    this.skipAssign = enabled;
  }

  /** 音声ファイルをデコードして指定スロットへ割り当てる */
  async assignAudio(index: number, file: File): Promise<void> {
    if (!file.type.startsWith("audio/")) return;
    const assignment = await this.options.slots.assignAudio(index, file);
    const audioLabel = this.options.ui.slotElements[index]?.querySelector<HTMLElement>("[data-audio]");
    if (audioLabel) audioLabel.textContent = `SFX ${file.name.replace(/\.[^.]+$/, "").slice(0, 10)}`;
    this.options.log(`SFX ${index + 1} ${assignment.name} / TRIM ${Math.round(assignment.trimmedMs)}ms`);
  }

  /** 画像やGIFや音声を種別に応じて指定スロットへ割り当てる */
  async assignFile(index: number, file: File): Promise<void> {
    if (file.type.startsWith("audio/")) {
      await this.assignAudio(index, file);
      return;
    }
    if (!file.type.startsWith("image/")) return;
    const loaded = await this.options.slots.assignImage(index, file, this.options.uploadTexture);
    const slotElement = this.options.ui.slotElements[index];
    slotElement.classList.add("loaded");
    slotElement.style.backgroundImage = `url(${loaded.preview})`;
    slotElement.querySelector<HTMLElement>("[data-image]")!.textContent = `${loaded.isGif ? "GIF" : "IMG"} ${file.name.replace(/\.[^.]+$/, "").slice(0, 10)}`;
    const wasActive = this.options.foreground.activeSlot === index;
    this.options.stage.refreshSlot(index, wasActive ? index : this.options.foreground.activeSlot);
    this.options.foreground.refreshSlot(index);
    this.updateTargets();
    this.options.log(`LOAD ${index + 1} ${file.name}${loaded.isGif ? ` / GIF DECODER ${loaded.gifFrameCount}F` : ""}`);
  }

  /** 未割り当て素材を破棄して通常画面へ戻す */
  close(clear = true): void {
    if (clear) this.pendingAssignments = [];
    this.renderOverlay();
    this.options.log("D&D ASSIGN CLOSE");
  }

  /** Enter操作で残り素材を破棄して割り当てを確定する */
  confirm(): void {
    const remaining = this.pendingAssignments.length;
    this.close(true);
    this.options.log(`D&D ASSIGN CONFIRM${remaining ? ` / SKIP ${remaining}` : ""}`);
  }

  /** 表示中の全画面ドロップ案内をEscで抑制する */
  cancelDropOverlay(): boolean {
    if (!document.body.classList.contains("is-dragging")) return false;
    document.body.classList.remove("is-dragging");
    this.dropOverlaySuppressed = true;
    this.options.log("DROP OVERLAY CANCEL");
    return true;
  }

  /** 一時割り当て状態とドラッグ表示を破棄する */
  destroy(): void {
    this.pendingAssignments = [];
    document.body.classList.remove("is-dragging");
  }

  /** 割り当て画面と各スロットへD&D操作を設定する */
  private setupAssignmentUi(): void {
    const { ui, signal } = this.options;
    ui.assignOverlay.querySelector<HTMLElement>("[data-action=cancel-assign]")?.addEventListener(
      "click",
      () => this.close(true),
      { signal },
    );
    [...ui.assignTargets.children].forEach((targetElement, index) => {
      const target = targetElement as HTMLElement;
      target.addEventListener("dragover", (event) => {
        event.preventDefault();
        target.classList.add("drag");
      }, { signal });
      target.addEventListener("dragleave", () => target.classList.remove("drag"), { signal });
      target.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.remove("is-dragging");
        target.classList.remove("drag");
        const id = event.dataTransfer?.getData("text/pending-id");
        if (id) void this.assignPendingToSlot(id, index);
      }, { signal });
    });

    ui.slotElements.forEach((slot, index) => {
      slot.addEventListener("dragover", (event) => {
        event.preventDefault();
        slot.classList.add("drag");
      }, { signal });
      slot.addEventListener("dragleave", () => slot.classList.remove("drag"), { signal });
      // パネル上への直接ドロップは全画面割り当てを経由せず即時反映する
      slot.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        slot.classList.remove("drag");
        const file = event.dataTransfer?.files[0];
        if (file) void this.assignFile(index, file);
      }, { signal });
    });
  }

  /** ステージ全体へ画像と音声のドロップ処理を設定する */
  private setupStageDrop(): void {
    const { host, signal } = this.options;
    host.addEventListener("dragover", (event) => {
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      const overUi = Boolean(target?.closest(".control-panel, .assign-overlay, .key-guide"));
      if (overUi || this.dropOverlaySuppressed) {
        document.body.classList.remove("is-dragging");
        return;
      }
      document.body.classList.add("is-dragging");
    }, { signal });
    host.addEventListener("dragleave", (event) => {
      if (event.target === host) {
        document.body.classList.remove("is-dragging");
        this.dropOverlaySuppressed = false;
      }
    }, { signal });
    host.addEventListener("drop", (event) => {
      event.preventDefault();
      document.body.classList.remove("is-dragging");
      this.dropOverlaySuppressed = false;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".control-panel, .key-guide")) return;
      // 割り当て画面内の内部ドラッグを新規ファイルドロップとして処理しない
      if (event.dataTransfer?.getData("text/pending-id")) return;
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => this.isSupported(file));
      if (!files.length) return;
      if (!this.skipAssign) {
        void this.openOverlay(files);
        return;
      }
      void this.assignSequentially(files);
    }, { signal });
  }

  /** ドロップ素材を最大16件まで割り当て画面へ読み込む */
  private async openOverlay(files: File[]): Promise<void> {
    // 8スロットへ画像と音声を1件ずつ置ける最大数に制限する
    const valid = files.filter((file) => this.isSupported(file)).slice(0, 16);
    if (!valid.length) return;
    const { panel } = this.options.ui;
    this.panelWasHiddenBeforeAssign = panel.classList.contains("hidden");
    panel.classList.add("hidden");
    this.pendingAssignments = [];
    for (const file of valid) {
      const kind = file.type.startsWith("audio/") ? "SFX" as const : "IMG" as const;
      let preview = "";
      if (kind === "IMG") {
        try { preview = await createPanelPreview(file, 420); } catch { preview = ""; }
      }
      this.pendingAssignments.push({ id: this.nextPendingAssignmentId++, file, kind, preview });
    }
    this.renderOverlay();
    this.options.log(`D&D ASSIGN ${valid.length} FILE${valid.length === 1 ? "" : "S"}`);
  }

  /** 未割り当て素材の一覧を割り当て画面へ再描画する */
  private renderOverlay(): void {
    const { assignOverlay, assignSources, panel } = this.options.ui;
    assignOverlay.hidden = this.pendingAssignments.length === 0;
    assignSources.replaceChildren();
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
      assignSources.appendChild(source);
    }
    this.updateTargets();
    if (!this.pendingAssignments.length && !this.panelWasHiddenBeforeAssign) panel.classList.remove("hidden");
  }

  /** 各割り当て先へ現在の画像と音声名を反映する */
  private updateTargets(): void {
    const { assignTargets, slotElements } = this.options.ui;
    const targets = [...assignTargets.children] as HTMLElement[];
    targets.forEach((target, index) => {
      target.style.backgroundImage = slotElements[index]?.style.backgroundImage ?? "";
      const names: string[] = [];
      const slot = this.options.slots.get(index);
      if (slot.texture) names.push(`${slot.isGif ? "GIF" : "IMG"} ${slot.name}`);
      if (slot.audioBuffer) names.push(`SFX ${slot.audioName}`);
      const label = target.querySelector("small");
      if (label) label.textContent = names.join(" + ") || "EMPTY";
    });
  }

  /** 未割り当て素材をIDで取り出して指定スロットへ移す */
  private async assignPendingToSlot(idText: string, slotIndex: number): Promise<void> {
    const id = Number(idText);
    const index = this.pendingAssignments.findIndex((item) => item.id === id);
    if (index < 0) return;
    const item = this.pendingAssignments[index];
    this.pendingAssignments.splice(index, 1);
    if (item.kind === "SFX") await this.assignAudio(slotIndex, item.file);
    else await this.assignFile(slotIndex, item.file);
    this.options.log(`${item.kind} → ${slotIndex + 1} ${item.file.name}`);
    this.renderOverlay();
  }

  /** 複数素材を画像と音声ごとに1番から順番に割り当てる */
  private async assignSequentially(files: File[]): Promise<void> {
    const images = files.filter((file) => file.type.startsWith("image/")).slice(0, 8);
    const audio = files.filter((file) => file.type.startsWith("audio/")).slice(0, 8);
    const selected = this.options.getSelectedSlot();
    const jobs: Promise<void>[] = [];
    // 単一素材は選択先へ、複数素材は演奏順が分かりやすい1番から割り当てる
    if (images.length === 1) jobs.push(this.assignFile(selected, images[0]));
    else images.forEach((file, index) => jobs.push(this.assignFile(index, file)));
    if (audio.length === 1) jobs.push(this.assignAudio(selected, audio[0]));
    else audio.forEach((file, index) => jobs.push(this.assignAudio(index, file)));
    if (!jobs.length) return;
    await Promise.all(jobs);
    this.options.selectSlot(images.length > 1 || audio.length > 1 ? 0 : selected);
  }

  /** 割り当て対象として扱える画像または音声か返す */
  private isSupported(file: File): boolean {
    return file.type.startsWith("image/") || file.type.startsWith("audio/");
  }
}
