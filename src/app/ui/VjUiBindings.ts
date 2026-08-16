import { KeyGuideBindings } from "./bindings/KeyGuideBindings";
import { PanelBindings } from "./bindings/PanelBindings";
import { PanelDragController } from "./bindings/PanelDragController";
import type { VjUiActions } from "./bindings/VjUiActions";
import type { VjUiController } from "./VjUiController";

/** UIの各入力バインディングをまとめて初期化する */
export class VjUiBindings {
  /** UI操作を責務別のバインディングへ接続する */
  constructor(host: HTMLElement, ui: VjUiController, actions: VjUiActions, signal: AbortSignal) {
    new KeyGuideBindings(ui, actions, signal);
    new PanelBindings(host, ui, actions, signal);
    new PanelDragController(ui, actions, signal);
    actions.selectSlot(0, false);
  }
}
