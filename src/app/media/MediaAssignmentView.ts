import type { VjUiElements } from "../ui/createVjUi";
import type { SlotStore } from "./SlotStore";

export interface PendingAssignment {
  id: number;
  file: File;
  kind: "IMG" | "SFX";
  preview: string;
}

/** 素材割り当て画面とスロット表示のDOM更新を管理する */
export class MediaAssignmentView {
  private readonly ui: VjUiElements;
  private readonly slots: SlotStore;

  /** UI要素とスロット状態を受け取る */
  constructor(ui: VjUiElements, slots: SlotStore) {
    this.ui = ui;
    this.slots = slots;
  }

  /** 指定スロットの音声名をパネルへ反映する */
  showAudio(index: number, file: File): void {
    const audioLabel = this.ui.slotElements[index]?.querySelector<HTMLElement>("[data-audio]");
    if (audioLabel) audioLabel.textContent = `SFX ${file.name.replace(/\.[^.]+$/, "").slice(0, 10)}`;
  }

  /** 指定スロットの画像プレビューと名前をパネルへ反映する */
  showImage(index: number, file: File, preview: string, isGif: boolean): void {
    const slotElement = this.ui.slotElements[index];
    slotElement.classList.add("loaded");
    slotElement.style.backgroundImage = `url(${preview})`;
    slotElement.querySelector<HTMLElement>("[data-image]")!.textContent = `${isGif ? "GIF" : "IMG"} ${file.name.replace(/\.[^.]+$/, "").slice(0, 10)}`;
  }

  /** 未割り当て素材の一覧を割り当て画面へ再描画する */
  renderOverlay(pending: PendingAssignment[], panelWasHidden: boolean): void {
    const { assignOverlay, assignSources, panel } = this.ui;
    assignOverlay.hidden = pending.length === 0;
    assignSources.replaceChildren();
    for (const item of pending) {
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
    if (!pending.length && !panelWasHidden) panel.classList.remove("hidden");
  }

  /** 各割り当て先へ現在の画像と音声名を反映する */
  updateTargets(): void {
    const targets = [...this.ui.assignTargets.children] as HTMLElement[];
    targets.forEach((target, index) => {
      target.style.backgroundImage = this.ui.slotElements[index]?.style.backgroundImage ?? "";
      const names: string[] = [];
      const slot = this.slots.get(index);
      if (slot.texture) names.push(`${slot.isGif ? "GIF" : "IMG"} ${slot.name}`);
      if (slot.audioBuffer) names.push(`SFX ${slot.audioName}`);
      const label = target.querySelector("small");
      if (label) label.textContent = names.join(" + ") || "EMPTY";
    });
  }
}
