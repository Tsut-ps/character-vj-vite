import type { VjUiController } from "../VjUiController";
import type { VjUiActions } from "./VjUiActions";

/** 操作パネルを画面内で移動できるようにする */
export class PanelDragController {
  private readonly ui: VjUiController;
  private readonly actions: VjUiActions;
  private readonly signal: AbortSignal;

  /** パネル見出しへポインタードラッグを設定する */
  constructor(ui: VjUiController, actions: VjUiActions, signal: AbortSignal) {
    this.ui = ui;
    this.actions = actions;
    this.signal = signal;
    this.setup();
  }

  /** パネル見出しをドラッグして画面内で移動できるようにする */
  private setup(): void {
    const panel = this.ui.elements.panel;
    const head = panel.querySelector<HTMLElement>(".panel-head");
    if (!head) return;
    let drag: { pointerId: number; dx: number; dy: number; moved: boolean } | null = null;
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button, input, select")) return;
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      panel.classList.add("moving");
      drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
      head.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }, { signal: this.signal });
    head.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      // パネルが画面外へ消えて再操作不能にならないよう座標を制限する
      const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
      const left = Math.max(0, Math.min(maxX, event.clientX - drag.dx));
      const top = Math.max(0, Math.min(maxY, event.clientY - drag.dy));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      drag.moved = true;
    }, { signal: this.signal });
    /** パネル移動のポインター追跡を終了する */
    const finish = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      panel.classList.remove("moving");
      if (moved) this.actions.log("MENU MOVED");
    };
    head.addEventListener("pointerup", finish, { signal: this.signal });
    head.addEventListener("pointercancel", finish, { signal: this.signal });
  }
}
