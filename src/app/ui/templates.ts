export const BPM_GRAPH_HTML = `
  <div class="bpm-graph-head"><span>BPM / 12s</span><b>128.00</b></div>
  <svg viewBox="0 0 260 74" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="18.5" x2="260" y2="18.5"></line>
    <line x1="0" y1="37" x2="260" y2="37"></line>
    <line x1="0" y1="55.5" x2="260" y2="55.5"></line>
    <path d=""></path>
  </svg>
`;

export const KEY_GUIDE_HTML = `
  <div class="key-guide-head"><span>KEYBOARD</span><span>CLICK / HOLD</span></div>
  <div class="key-guide-body">
    <div class="key-main">
      <div class="key-row"><button data-code="Escape" class="esc">ESC</button><button data-code="Digit1">1</button><button data-code="Digit2">2</button><button data-code="Digit3">3</button><button data-code="Digit4">4</button><button data-code="Digit5">5</button><button data-code="Digit6">6</button><button data-code="Digit7">7</button><button data-code="Digit8">8</button><button data-code="Digit9">9</button><button data-code="Minus">−</button><button data-code="Equal">＋</button></div>
      <div class="key-row"><button data-code="KeyR">R</button><button data-code="ShiftLeft" class="shift">SHIFT</button><button data-code="Space" class="space">SPACE</button><button data-code="Enter" class="enter">ENTER</button><span class="key-hint">SHIFT = toggle</span></div>
      <div class="key-row"><div class="key-arrows"><button data-code="ArrowUp" class="up">↑</button><button data-code="ArrowLeft" class="left">←</button><button data-code="ArrowDown" class="down">↓</button><button data-code="ArrowRight" class="right">→</button></div></div>
    </div>
    <div class="key-num" aria-label="テンキー">
      <button data-code="Numpad7">7</button><button data-code="Numpad8">8</button><button data-code="Numpad9">9</button>
      <button data-code="Numpad4">4</button><button data-code="Numpad5">5</button><button data-code="Numpad6">6</button>
      <button data-code="Numpad1">1</button><button data-code="Numpad2">2</button><button data-code="Numpad3">3</button>
      <button data-code="NumpadSubtract">−</button><button data-code="NumpadAdd">＋</button><span></span>
    </div>
  </div>
`;

export const CONTROL_PANEL_HTML = `
  <div class="panel-head">
    <strong>CHARACTER VJ</strong>
    <button class="icon-btn" data-action="hide" title="Hide panel">×</button>
  </div>
  <div class="transport">
    <label>BPM <input data-field="bpm" type="number" min="30" max="300" step="1" value="128"></label>
    <button data-action="tap">TAP</button>
    <button data-action="sync">SYNC</button>
  </div>
  <div class="transport">
    <button data-action="quantize">Q 1/8 BEAT</button>
    <label>Offset <input data-field="offset" type="number" min="-300" max="300" step="1" value="0"> ms</label>
  </div>
  <div class="transport">
    <label class="fps-limit"><input data-field="limit-fps" type="checkbox"> 60 FPS LIMIT</label>
    <label class="fps-limit"><input data-field="skip-assign" type="checkbox"> SKIP D&D ASSIGN</label>
    <label class="fps-limit"><input data-field="hide-background" type="checkbox"> HIDE BACKGROUND</label>
  </div>
  <div class="transport volume-row">
    <label for="sfx-master-volume">SFX VOL</label>
    <input id="sfx-master-volume" data-field="master-volume" type="range" min="0" max="400" step="1" value="100">
    <span class="volume-value" data-field="master-volume-value">100%</span>
  </div>
  <div class="slots-title">IMAGES / SFX <span>drop anywhere → fullscreen assign</span></div>
  <div class="slots"></div>
  <div class="effects"></div>
  <div class="panel-actions">
    <button data-action="record">REC [R]</button>
    <button data-action="midi">ENABLE MIDI</button>
    <button data-action="fullscreen">FULLSCREEN</button>
  </div>
  <div class="hint">Drop anywhere → fullscreen assign · SKIP D&D ASSIGN = auto-assign · SFX silence is auto-trimmed · 1–8 / Numpad: cue · Hold: auto every beat · Shift+1–9: latch (max 4) · 9: random gravity jump / hold auto · +/-: global scale · Arrows: global anchor · Shift+ +/-/Arrows: per-cue adjust · R: 2-bar record / loop · Enter: clear all · Space: TAP · Shift+Space: SYNC · Esc: menu</div>
`;

export const ASSIGN_OVERLAY_HTML = `
  <div class="assign-top">
    <div><strong>D&D ASSIGN</strong><br><span>上の素材を下の1〜8へドラッグ</span></div>
    <button data-action="cancel-assign">CANCEL</button>
  </div>
  <div class="assign-sources"></div>
  <div class="assign-dest-title">DROP TO 1 / 2 / 3 / 4 / 5 / 6 / 7 / 8</div>
  <div class="assign-targets"></div>
`;
