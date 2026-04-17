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

const overlay = required<HTMLDivElement>('overlay');
const trigger = required<HTMLButtonElement>('trigger');
const logoWrap = required<HTMLSpanElement>('logo-wrap');
const barsEl = required<HTMLDivElement>('bars');
const statusChip = required<HTMLDivElement>('status-chip');
const infoTooltip = required<HTMLDivElement>('info-tooltip');

logoWrap.innerHTML = LOGO_SVG;

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const soundbar = createSoundbar(barsEl);

function setState(state: StateName): void {
  for (const s of STATES) overlay.classList.remove(`state-${s}`);
  overlay.classList.add(`state-${state}`);
  statusChip.textContent = state;

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
    `${info.providerDisplayName} · ${info.model}\n` +
    `${info.baseUrl}\n` +
    `PTT ${info.hotkeyCombo}  ·  Toggle ${info.toggleHotkeyCombo}\n` +
    'Drag to move · Right-click for menu';
  infoTooltip.style.whiteSpace = 'pre';
});

window.murmur.requestInfo();

trigger.addEventListener('click', (e) => {
  e.stopPropagation();
  window.murmur.toggleRecording();
});

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
