import { LOGO_SVG } from './logo.js';
import { startCapture, stopCapture } from './recorder.js';
import { createSoundbar } from './soundbar.js';

declare global {
  interface Window {
    murmur: {
      onStatus: (cb: (status: string) => void) => void;
      onStartRecording: (cb: () => void) => void;
      onStopRecording: (cb: () => void) => void;
      onInfo: (cb: (info: InfoView) => void) => void;
      sendAudioChunk: (buffer: ArrayBuffer) => void;
      toggleRecording: () => void;
      requestInfo: () => void;
      setMouseInteractive: (interactive: boolean) => void;
      hideOverlay: () => void;
      showContextMenu: () => void;
      beginWindowDrag: () => void;
      endWindowDrag: () => void;
      openControlPanel: () => void;
      quit: () => void;
    };
  }
}

interface InfoView {
  provider: string;
  providerDisplayName: string;
  baseUrl: string;
  model: string;
  hotkeyCombo: string;
  toggleHotkeyCombo: string;
  configFilePath: string;
  controlPanelUrl: string;
}

const STATES = [
  'idle',
  'recording',
  'transcribing',
  'refining',
  'injecting',
  'done',
  'error',
] as const;

type StateName = (typeof STATES)[number];

const STATE_LABELS: Record<StateName, string> = {
  idle: 'idle',
  recording: 'Recording\u2026',
  transcribing: 'Transcribing\u2026',
  refining: 'Refining\u2026',
  injecting: 'Pasting\u2026',
  done: 'Done',
  error: 'Error',
};

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const overlay = required<HTMLDivElement>('overlay');
const logoWrap = required<HTMLSpanElement>('logo-wrap');
const barsEl = required<HTMLDivElement>('bars');
const statusChip = required<HTMLDivElement>('status-chip');
const infoTooltip = required<HTMLDivElement>('info-tooltip');

logoWrap.innerHTML = LOGO_SVG;

const soundbar = createSoundbar(barsEl);

function setState(state: StateName): void {
  for (const s of STATES) overlay.classList.remove(`state-${s}`);
  overlay.classList.add(`state-${state}`);
  statusChip.textContent = STATE_LABELS[state];

  if (state === 'recording') {
    overlay.classList.add('expanded');
    soundbar.start();
  } else if (state === 'idle') {
    overlay.classList.remove('expanded');
    soundbar.stop();
  } else {
    overlay.classList.add('expanded');
    soundbar.stop();
  }
}

setState('idle');

window.murmur.onStatus((s) => {
  if ((STATES as readonly string[]).includes(s)) {
    setState(s as StateName);
  }
});

window.murmur.onStartRecording(async () => {
  try {
    await startCapture();
  } catch (err) {
    console.error('[renderer] startCapture failed:', err);
  }
});

window.murmur.onStopRecording(async () => {
  try {
    const buf = await stopCapture();
    window.murmur.sendAudioChunk(buf);
  } catch (err) {
    console.error('[renderer] stopCapture failed:', err);
    window.murmur.sendAudioChunk(new ArrayBuffer(0));
  }
});

window.murmur.onInfo((info) => {
  infoTooltip.textContent =
    `${info.providerDisplayName} \u00b7 ${info.model}\n` +
    `${info.baseUrl}\n` +
    `PTT ${info.hotkeyCombo}  \u00b7  Toggle ${info.toggleHotkeyCombo}\n` +
    `Panel ${info.controlPanelUrl}\n` +
    'Drag to move \u00b7 Right-click for menu';
  infoTooltip.style.whiteSpace = 'pre';
});

window.murmur.requestInfo();

// Toggle window-level mouse passthrough so transparent areas don't eat clicks.
overlay.addEventListener('mouseenter', () => {
  window.murmur.setMouseInteractive(true);
});
overlay.addEventListener('mouseleave', () => {
  window.murmur.setMouseInteractive(false);
});

// Right-click anywhere on the overlay opens the native context menu.
overlay.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.murmur.showContextMenu();
});

// Programmatic drag: a press becomes a click if it doesn't move past the
// threshold, and becomes a window drag if it does. Window movement happens
// in the main process via cursor polling.
const DRAG_THRESHOLD_PX = 4;

interface PressState {
  startX: number;
  startY: number;
  dragStarted: boolean;
}

let press: PressState | null = null;

overlay.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  press = { startX: e.screenX, startY: e.screenY, dragStarted: false };
});

document.addEventListener('mousemove', (e) => {
  if (!press) return;
  if (press.dragStarted) return;
  const dx = e.screenX - press.startX;
  const dy = e.screenY - press.startY;
  if (Math.abs(dx) + Math.abs(dy) >= DRAG_THRESHOLD_PX) {
    press.dragStarted = true;
    overlay.classList.add('dragging');
    window.murmur.beginWindowDrag();
  }
});

document.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !press) return;
  const wasDrag = press.dragStarted;
  press = null;
  if (wasDrag) {
    overlay.classList.remove('dragging');
    window.murmur.endWindowDrag();
  } else {
    window.murmur.toggleRecording();
  }
});
