import { GlobalShortcutBindings } from "./bindings/GlobalShortcutBindings";
import { KeyGuideBindings } from "./bindings/KeyGuideBindings";
import { PanelBindings } from "./bindings/PanelBindings";
import { PanelDragController } from "./bindings/PanelDragController";
import type { VjUiActions } from "./bindings/VjUiActions";
import type { VjUiController } from "./VjUiController";

/** UIの各入力バインディングをまとめて初期化する */
export class VjUiBindings {
  private readonly ui: VjUiController;
  private readonly actions: VjUiActions;

  /** UI操作を責務別のバインディングへ接続する */
  constructor(host: HTMLElement, ui: VjUiController, actions: VjUiActions, signal: AbortSignal) {
    this.ui = ui;
    this.actions = actions;
    const handleEscape = () => this.handleEscape();
    new KeyGuideBindings(ui, actions, signal, handleEscape);
    new PanelBindings(host, ui, actions, signal);
    new GlobalShortcutBindings(ui, actions, signal, handleEscape);
    new PanelDragController(ui, actions, signal);
    actions.selectSlot(0, false);
  }

  /** Esc操作をドロップ案内と割り当て画面とパネルへ順番に適用する */
  private handleEscape(): void {
    if (this.actions.cancelDropOverlay()) return;
    if (this.actions.isAssignmentOpen()) {
      this.actions.closeAssignment();
      return;
    }
    const panel = this.ui.elements.panel;
    panel.classList.toggle("hidden");
    this.actions.log(panel.classList.contains("hidden") ? "MENU HIDE" : "MENU SHOW");
  }
}
