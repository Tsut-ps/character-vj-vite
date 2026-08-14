import { EFFECT_LABELS, EFFECTS } from "../types";
import {
  ASSIGN_OVERLAY_HTML,
  BPM_GRAPH_HTML,
  CONTROL_PANEL_HTML,
  KEY_GUIDE_HTML,
} from "./templates";

export interface VjUiElements {
  flashElement: HTMLElement;
  beatPulse: HTMLElement;
  hud: HTMLElement;
  bpmGraphPath: SVGPathElement;
  bpmGraphValue: HTMLElement;
  keyGuide: HTMLElement;
  actionLog: HTMLElement;
  panel: HTMLElement;
  assignOverlay: HTMLElement;
  assignSources: HTMLElement;
  assignTargets: HTMLElement;
  slotElements: HTMLElement[];
  cueButtons: HTMLButtonElement[];
}

/** 必須の子要素を取得してテンプレート不整合を早期検出する */
function queryRequired<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Required UI element not found: ${selector}`);
  return element;
}

/** VJ画面のDOM構造を生成して操作に必要な要素を返す */
export function createVjUi(host: HTMLElement): VjUiElements {
  const flashElement = document.createElement("div");
  flashElement.className = "screen-flash";
  host.appendChild(flashElement);

  const beatPulse = document.createElement("div");
  beatPulse.className = "beat-pulse";
  host.appendChild(beatPulse);

  const hud = document.createElement("div");
  hud.className = "hud";
  host.appendChild(hud);

  const bpmGraph = document.createElement("div");
  bpmGraph.className = "bpm-graph";
  bpmGraph.innerHTML = BPM_GRAPH_HTML;
  host.appendChild(bpmGraph);

  const keyGuide = document.createElement("div");
  keyGuide.className = "key-guide";
  keyGuide.setAttribute("aria-label", "対応キーボードショートカット");
  keyGuide.innerHTML = KEY_GUIDE_HTML;
  host.appendChild(keyGuide);

  const actionLog = document.createElement("div");
  actionLog.className = "action-log";
  actionLog.setAttribute("aria-live", "polite");
  actionLog.setAttribute("aria-label", "操作ログ");
  host.appendChild(actionLog);

  const panel = document.createElement("aside");
  panel.className = "control-panel";
  panel.innerHTML = CONTROL_PANEL_HTML;
  host.appendChild(panel);

  const assignOverlay = document.createElement("section");
  assignOverlay.className = "assign-overlay";
  assignOverlay.hidden = true;
  assignOverlay.setAttribute("aria-label", "D&D割り当て");
  assignOverlay.innerHTML = ASSIGN_OVERLAY_HTML;
  host.appendChild(assignOverlay);

  const assignTargets = queryRequired<HTMLElement>(assignOverlay, ".assign-targets");
  for (let index = 0; index < 8; index += 1) {
    const target = document.createElement("button");
    target.className = "assign-target";
    target.dataset.index = String(index);
    target.innerHTML = `<b>${index + 1}</b><small>EMPTY</small>`;
    assignTargets.appendChild(target);
  }

  const slots = queryRequired<HTMLElement>(panel, ".slots");
  const slotElements: HTMLElement[] = [];
  for (let index = 0; index < 8; index += 1) {
    const slot = document.createElement("button");
    slot.className = "slot";
    slot.dataset.index = String(index);
    slot.innerHTML = `<span>${index + 1}</span><small data-image>IMG DROP</small><em data-audio>SFX —</em>`;
    slots.appendChild(slot);
    slotElements.push(slot);
  }

  const effects = queryRequired<HTMLElement>(panel, ".effects");
  const cueButtons = EFFECTS.map((effect, index) => {
    const button = document.createElement("button");
    button.innerHTML = `<b>${index + 1}</b><span>${EFFECT_LABELS[effect]}</span>`;
    effects.appendChild(button);
    return button;
  });

  return {
    flashElement,
    beatPulse,
    hud,
    bpmGraphPath: queryRequired<SVGPathElement>(bpmGraph, "path"),
    bpmGraphValue: queryRequired<HTMLElement>(bpmGraph, "b"),
    keyGuide,
    actionLog,
    panel,
    assignOverlay,
    assignSources: queryRequired<HTMLElement>(assignOverlay, ".assign-sources"),
    assignTargets,
    slotElements,
    cueButtons,
  };
}
