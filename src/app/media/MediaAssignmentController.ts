import type { Texture } from "pixi.js";
import type { ForegroundRenderer } from "../rendering/ForegroundRenderer";
import type { StageRenderer } from "../rendering/StageRenderer";
import { createPanelPreview } from "../services/ImageLoader";
import type { VjUiElements } from "../ui/createVjUi";
import { FileDropController } from "./FileDropController";
import { MediaAssignmentView, type PendingAssignment } from "./MediaAssignmentView";
import type { SlotStore } from "./SlotStore";

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

/** 素材の割り当て状態と画像や音声の読み込みを管理する */
export class MediaAssignmentController {
  private pendingAssignments: PendingAssignment[] = [];
  private nextPendingAssignmentId = 1;
  private panelWasHiddenBeforeAssign = false;
  private readonly options: MediaAssignmentOptions;
  private readonly view: MediaAssignmentView;
  private readonly fileDrop: FileDropController;

  /** 必要なUIと素材管理処理を受け取って割り当て機能を作る */
  constructor(options: MediaAssignmentOptions) {
    this.options = options;
    this.view = new MediaAssignmentView(options.ui, options.slots);
    this.fileDrop = new FileDropController(options.host, options.ui, options.signal, {
      assignFile: (index, file) => { void this.assignFile(index, file); },
      assignPending: (id, index) => { void this.assignPendingToSlot(id, index); },
      handleFiles: (files, skipAssign) => this.handleDroppedFiles(files, skipAssign),
      closeAssignment: () => this.close(true),
      log: (message) => options.log(message),
    });
  }

  /** 割り当て画面が表示中かどうかを返す */
  get isOpen(): boolean {
    return !this.options.ui.assignOverlay.hidden;
  }

  /** 全画面割り当てを省略する設定を更新する */
  setSkipAssign(enabled: boolean): void {
    this.fileDrop.setSkipAssign(enabled);
  }

  /** 音声ファイルをデコードして指定スロットへ割り当てる */
  async assignAudio(index: number, file: File): Promise<void> {
    if (!file.type.startsWith("audio/")) return;
    const assignment = await this.options.slots.assignAudio(index, file);
    this.view.showAudio(index, file);
    this.view.updateTargets();
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
    this.view.showImage(index, file, loaded.preview, loaded.isGif);
    const wasActive = this.options.foreground.activeSlot === index;
    this.options.stage.refreshSlot(index, wasActive ? index : this.options.foreground.activeSlot);
    this.options.foreground.refreshSlot(index);
    this.view.updateTargets();
    this.options.log(`LOAD ${index + 1} ${file.name}${loaded.isGif ? ` / GIF DECODER ${loaded.gifFrameCount}F` : ""}`);
  }

  /** 未割り当て素材を破棄して通常画面へ戻す */
  close(clear = true): void {
    if (clear) this.pendingAssignments = [];
    this.view.renderOverlay(this.pendingAssignments, this.panelWasHiddenBeforeAssign);
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
    return this.fileDrop.cancelDropOverlay();
  }

  /** 一時割り当て状態とドラッグ表示を破棄する */
  destroy(): void {
    this.pendingAssignments = [];
    this.fileDrop.destroy();
  }

  /** ドロップされた素材を設定に応じて割り当て画面または直接割り当てへ送る */
  private handleDroppedFiles(files: File[], skipAssign: boolean): void {
    if (skipAssign) void this.assignSequentially(files);
    else void this.openOverlay(files);
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
    this.view.renderOverlay(this.pendingAssignments, this.panelWasHiddenBeforeAssign);
    this.options.log(`D&D ASSIGN ${valid.length} FILE${valid.length === 1 ? "" : "S"}`);
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
    this.view.renderOverlay(this.pendingAssignments, this.panelWasHiddenBeforeAssign);
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
