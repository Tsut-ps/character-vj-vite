import type { Texture } from "pixi.js";
import type { ForegroundRenderer } from "../rendering/ForegroundRenderer";
import type { StageRenderer } from "../rendering/StageRenderer";
import { createPanelPreview } from "../services/ImageLoader";
import type { VjUiElements } from "../ui/createVjUi";
import { FileDropController } from "./FileDropController";
import { MediaAssignmentView, type PendingAssignment } from "./MediaAssignmentView";
import { detectMediaFileKind } from "./mediaFileKind";
import type { SlotStore } from "./SlotStore";

interface MediaAssignmentOptions {
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
  private pendingRevision = 0;
  private panelWasHiddenBeforeAssign = false;
  private destroyed = false;
  private readonly options: MediaAssignmentOptions;
  private readonly view: MediaAssignmentView;
  private readonly fileDrop: FileDropController;

  /** 必要なUIと素材管理処理を受け取って割り当て機能を作る */
  constructor(options: MediaAssignmentOptions) {
    this.options = options;
    this.view = new MediaAssignmentView(options.ui, options.slots);
    this.fileDrop = new FileDropController(options.host, options.ui, options.signal, {
      assignFile: (index, file) => this.runTask(`LOAD ${index + 1}`, () => this.assignFile(index, file)),
      assignPending: (id, index) => this.runTask(`ASSIGN ${index + 1}`, () => this.assignPendingToSlot(id, index)),
      handleFiles: (files, skipAssign) => this.handleDroppedFiles(files, skipAssign),
      closeAssignment: () => this.close(),
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
    if (detectMediaFileKind(file) !== "audio") return;
    const assignment = await this.options.slots.assignAudio(index, file);
    if (this.destroyed) return;
    this.view.showAudio(index, file);
    this.view.updateTargets();
    this.options.log(`SFX ${index + 1} ${assignment.name} / TRIM ${Math.round(assignment.trimmedMs)}ms`);
  }

  /** 画像やGIFや音声を種別に応じて指定スロットへ割り当てる */
  async assignFile(index: number, file: File): Promise<void> {
    const kind = detectMediaFileKind(file);
    if (kind === "audio") {
      await this.assignAudio(index, file);
      return;
    }
    if (kind !== "image") return;
    const loaded = await this.options.slots.assignImage(index, file, this.options.uploadTexture);
    if (this.destroyed) return;
    this.view.showImage(index, file, loaded.preview, loaded.isGif);
    const wasActive = this.options.foreground.activeSlot === index;
    this.options.stage.refreshSlot(index, wasActive ? index : this.options.foreground.activeSlot);
    this.options.foreground.refreshSlot(index);
    this.view.updateTargets();
    const gifInfo = loaded.isGif
      ? loaded.gifFrameCount > 0 ? ` / GIF DECODER ${loaded.gifFrameCount}F` : " / GIF NATIVE"
      : "";
    this.options.log(`LOAD ${index + 1} ${file.name}${gifInfo}`);
  }

  /** 未割り当て素材を破棄して通常画面へ戻す */
  close(): void {
    this.pendingRevision += 1;
    this.pendingAssignments = [];
    this.view.renderOverlay(this.pendingAssignments, this.panelWasHiddenBeforeAssign);
    this.options.log("D&D ASSIGN CLOSE");
  }

  /** Enter操作で残り素材を破棄して割り当てを確定する */
  confirm(): void {
    const remaining = this.pendingAssignments.length;
    this.close();
    this.options.log(`D&D ASSIGN CONFIRM${remaining ? ` / SKIP ${remaining}` : ""}`);
  }

  /** 表示中の全画面ドロップ案内をEscで抑制する */
  cancelDropOverlay(): boolean {
    return this.fileDrop.cancelDropOverlay();
  }

  /** 一時割り当て状態とドラッグ表示を破棄する */
  destroy(): void {
    this.destroyed = true;
    this.pendingRevision += 1;
    this.pendingAssignments = [];
    this.fileDrop.destroy();
  }

  /** ドロップされた素材を設定に応じて割り当て画面または直接割り当てへ送る */
  private handleDroppedFiles(files: File[], skipAssign: boolean): void {
    if (skipAssign) this.runTask("D&D AUTO ASSIGN", () => this.assignSequentially(files));
    else this.runTask("D&D ASSIGN", () => this.openOverlay(files));
  }

  /** ドロップ素材を最大16件まで割り当て画面へ読み込む */
  private async openOverlay(files: File[]): Promise<void> {
    // 8スロットへ画像と音声を1件ずつ置ける最大数に制限する
    const valid = files.filter((file) => detectMediaFileKind(file) !== null).slice(0, 16);
    if (!valid.length) return;
    const revision = ++this.pendingRevision;
    const { panel } = this.options.ui;
    this.panelWasHiddenBeforeAssign = panel.classList.contains("hidden");
    panel.classList.add("hidden");
    const pendingAssignments: PendingAssignment[] = [];
    for (const file of valid) {
      const kind = detectMediaFileKind(file) === "audio" ? "SFX" as const : "IMG" as const;
      let preview = "";
      if (kind === "IMG") {
        try { preview = await createPanelPreview(file, 420); } catch { preview = ""; }
      }
      // 閉じた後や新しいドロップ後に古いプレビュー処理で画面を再表示しない
      if (this.destroyed || revision !== this.pendingRevision) return;
      pendingAssignments.push({ id: this.nextPendingAssignmentId++, file, kind, preview });
    }
    this.pendingAssignments = pendingAssignments;
    this.view.renderOverlay(this.pendingAssignments, this.panelWasHiddenBeforeAssign);
    this.options.log(`D&D ASSIGN ${valid.length} FILE${valid.length === 1 ? "" : "S"}`);
  }

  /** 未割り当て素材をIDで取り出して指定スロットへ移す */
  private async assignPendingToSlot(idText: string, slotIndex: number): Promise<void> {
    const id = Number(idText);
    const index = this.pendingAssignments.findIndex((item) => item.id === id);
    if (index < 0) return;
    const item = this.pendingAssignments[index];
    const revision = this.pendingRevision;
    this.pendingAssignments.splice(index, 1);
    this.view.renderOverlay(this.pendingAssignments, this.panelWasHiddenBeforeAssign);
    try {
      if (item.kind === "SFX") await this.assignAudio(slotIndex, item.file);
      else await this.assignFile(slotIndex, item.file);
    } catch (error) {
      // 失敗した素材を失わず同じ割り当て画面から再試行できるよう戻す
      if (!this.destroyed && revision === this.pendingRevision) {
        this.pendingAssignments.splice(Math.min(index, this.pendingAssignments.length), 0, item);
        this.view.renderOverlay(this.pendingAssignments, this.panelWasHiddenBeforeAssign);
      }
      throw error;
    }
    if (this.destroyed || revision !== this.pendingRevision) return;
    this.options.log(`${item.kind} → ${slotIndex + 1} ${item.file.name}`);
    this.view.renderOverlay(this.pendingAssignments, this.panelWasHiddenBeforeAssign);
  }

  /** 複数素材を画像と音声ごとに1番から順番に割り当てる */
  private async assignSequentially(files: File[]): Promise<void> {
    const images = files.filter((file) => detectMediaFileKind(file) === "image").slice(0, 8);
    const audio = files.filter((file) => detectMediaFileKind(file) === "audio").slice(0, 8);
    const selected = this.options.getSelectedSlot();
    const jobs: Promise<void>[] = [];
    // 単一素材は選択先へ、複数素材は演奏順が分かりやすい1番から割り当てる
    if (images.length === 1) jobs.push(this.assignFile(selected, images[0]));
    else images.forEach((file, index) => jobs.push(this.assignFile(index, file)));
    if (audio.length === 1) jobs.push(this.assignAudio(selected, audio[0]));
    else audio.forEach((file, index) => jobs.push(this.assignAudio(index, file)));
    if (!jobs.length) return;
    await Promise.all(jobs);
    if (this.destroyed) return;
    this.options.selectSlot(images.length > 1 || audio.length > 1 ? 0 : selected);
  }

  /** 非同期イベントの失敗を操作ログへ集約して未処理Promiseを防ぐ */
  private runTask(label: string, task: () => Promise<void>): void {
    void task().catch((error: unknown) => {
      if (this.destroyed || (error instanceof DOMException && error.name === "AbortError")) return;
      console.error(`${label} failed`, error);
      const detail = error instanceof Error ? error.message : "UNKNOWN ERROR";
      this.options.log(`${label} ERROR / ${detail}`);
    });
  }
}
