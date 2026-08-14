import type { VjUiElements } from "../ui/createVjUi";
import { detectMediaFileKind } from "./mediaFileKind";

export interface FileDropActions {
  assignFile(index: number, file: File): void;
  assignPending(id: string, index: number): void;
  handleFiles(files: File[], skipAssign: boolean): void;
  closeAssignment(): void;
  log(message: string): void;
}

/** スロットと割り当て画面とステージのファイルD&Dを管理する */
export class FileDropController {
  private dropOverlaySuppressed = false;
  private skipAssign = false;
  private readonly host: HTMLElement;
  private readonly ui: VjUiElements;
  private readonly signal: AbortSignal;
  private readonly actions: FileDropActions;

  /** 各ドロップ領域へファイル操作を設定する */
  constructor(host: HTMLElement, ui: VjUiElements, signal: AbortSignal, actions: FileDropActions) {
    this.host = host;
    this.ui = ui;
    this.signal = signal;
    this.actions = actions;
    this.setupAssignmentTargets();
    this.setupSlots();
    this.setupStage();
  }

  /** 全画面割り当てを省略する設定を更新する */
  setSkipAssign(enabled: boolean): void {
    this.skipAssign = enabled;
  }

  /** 表示中の全画面ドロップ案内をEscで抑制する */
  cancelDropOverlay(): boolean {
    if (!document.body.classList.contains("is-dragging")) return false;
    document.body.classList.remove("is-dragging");
    this.dropOverlaySuppressed = true;
    this.actions.log("DROP OVERLAY CANCEL");
    return true;
  }

  /** ドラッグ中の全画面表示を破棄する */
  destroy(): void {
    document.body.classList.remove("is-dragging");
  }

  /** 割り当て画面の各対象へ素材IDのドロップ処理を設定する */
  private setupAssignmentTargets(): void {
    this.ui.assignOverlay.querySelector<HTMLElement>("[data-action=cancel-assign]")?.addEventListener(
      "click",
      () => this.actions.closeAssignment(),
      { signal: this.signal },
    );
    [...this.ui.assignTargets.children].forEach((targetElement, index) => {
      const target = targetElement as HTMLElement;
      target.addEventListener("dragover", (event) => {
        event.preventDefault();
        target.classList.add("drag");
      }, { signal: this.signal });
      target.addEventListener("dragleave", () => target.classList.remove("drag"), { signal: this.signal });
      target.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.remove("is-dragging");
        target.classList.remove("drag");
        const id = event.dataTransfer?.getData("text/pending-id");
        if (id) this.actions.assignPending(id, index);
      }, { signal: this.signal });
    });
  }

  /** パネル内の各スロットへ直接割り当てを設定する */
  private setupSlots(): void {
    this.ui.slotElements.forEach((slot, index) => {
      slot.addEventListener("dragover", (event) => {
        event.preventDefault();
        slot.classList.add("drag");
      }, { signal: this.signal });
      slot.addEventListener("dragleave", () => slot.classList.remove("drag"), { signal: this.signal });
      // パネル上への直接ドロップは全画面割り当てを経由せず即時反映する
      slot.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        slot.classList.remove("drag");
        const file = event.dataTransfer?.files[0];
        if (file) this.actions.assignFile(index, file);
      }, { signal: this.signal });
    });
  }

  /** ステージ全体へ複数ファイルのドロップ処理を設定する */
  private setupStage(): void {
    this.host.addEventListener("dragover", (event) => {
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      const overUi = Boolean(target?.closest(".control-panel, .assign-overlay, .key-guide"));
      if (overUi || this.dropOverlaySuppressed) {
        document.body.classList.remove("is-dragging");
        return;
      }
      document.body.classList.add("is-dragging");
    }, { signal: this.signal });
    this.host.addEventListener("dragleave", (event) => {
      const nextTarget = event.relatedTarget;
      // 子要素間の移動ではなくステージ外へ出た時だけドラッグ状態を解除する
      if (nextTarget instanceof Node && this.host.contains(nextTarget)) return;
      document.body.classList.remove("is-dragging");
      this.dropOverlaySuppressed = false;
    }, { signal: this.signal });
    this.host.addEventListener("drop", (event) => {
      event.preventDefault();
      document.body.classList.remove("is-dragging");
      this.dropOverlaySuppressed = false;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".control-panel, .key-guide")) return;
      // 割り当て画面内の内部ドラッグを新規ファイルドロップとして処理しない
      if (event.dataTransfer?.getData("text/pending-id")) return;
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => this.isSupported(file));
      if (files.length) this.actions.handleFiles(files, this.skipAssign);
    }, { signal: this.signal });
  }

  /** 割り当て対象として扱える画像または音声か返す */
  private isSupported(file: File): boolean {
    return detectMediaFileKind(file) !== null;
  }
}
