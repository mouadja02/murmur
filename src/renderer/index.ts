import { LOGO_SVG } from './logo.js';
import { startCapture, stopCapture } from './recorder.js';
import { createSoundbar } from './soundbar.js';
import type { VadConfig } from './vad.js';

declare global {
  interface Window {
    murmur: {
      onStatus: (cb: (status: string) => void) => void;
      onStartRecording: (cb: () => void) => void;
      onStopRecording: (cb: () => void) => void;
      onInfo: (cb: (info: InfoView) => void) => void;
      onToken: (cb: (payload: TokenPayload) => void) => void;
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
      onQueueDepth: (cb: (depth: number) => void) => void;
      onError: (
        cb: (payload: {
          message: string;
          sessionDir: string;
          canInsertRaw?: boolean;
          notice?: boolean;
        }) => void,
      ) => void;
      retry: () => void;
      insertRaw: () => void;
      refineLast: () => void;
      openLogDir: (dir: string) => void;
      onVadConfig: (cb: (cfg: VadConfig) => void) => void;
      onVadMode: (cb: (mode: { autoStop: boolean }) => void) => void;
      vadSpeechStart: () => void;
      vadSilenceTimeout: () => void;
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
  progressiveInjection: boolean;
}

interface TokenPayload {
  token: string;
  phase: 'transcription' | 'refinement';
}

const STATES = [
  'idle',
  'vad-listening',
  'recording',
  'transcribing',
  'transcribing-streaming',
  'refining',
  'refining-streaming',
  'injecting',
  'done',
  'error',
  'queue-full',
] as const;

type StateName = (typeof STATES)[number];

const STATE_LABELS: Record<StateName, string> = {
  idle: 'idle',
  'vad-listening': 'Listening\u2026',
  recording: 'Recording\u2026',
  transcribing: 'Transcribing\u2026',
  'transcribing-streaming': 'Transcribing\u2026',
  refining: 'Refining\u2026',
  'refining-streaming': 'Refining\u2026',
  injecting: 'Pasting\u2026',
  done: 'Done',
  error: 'Error',
  'queue-full': 'Queue full',
};

let currentState: StateName = 'idle';

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
const queueBadge = required<HTMLDivElement>('queue-badge');
const errorToast = required<HTMLDivElement>('error-toast');
const errorMsgEl = required<HTMLSpanElement>('error-message');
const retryBtn = required<HTMLButtonElement>('retry-btn');
const insertRawBtn = required<HTMLButtonElement>('insert-raw-btn');
const logBtn = required<HTMLButtonElement>('log-btn');
const dismissBtn = required<HTMLButtonElement>('dismiss-btn');

logoWrap.innerHTML = LOGO_SVG;

const soundbar = createSoundbar(barsEl);
let latestInfo: InfoView | null = null;
let streamBuffer = '';
let streamPhase: 'transcription' | 'refinement' | null = null;
let hasLastTranscription = false;

function setState(state: StateName): void {
  currentState = state;
  for (const s of STATES) overlay.classList.remove(`state-${s}`);
  overlay.classList.add(`state-${state}`);
  statusChip.textContent = STATE_LABELS[state];
  if (latestInfo) renderInfoTooltip(latestInfo);

  if (state === 'transcribing-streaming') {
    streamBuffer = '';
    streamPhase = 'transcription';
  } else if (state === 'refining-streaming') {
    streamBuffer = '';
    streamPhase = 'refinement';
  } else if (state === 'idle' || state === 'done' || state === 'error') {
    if (state === 'done' && streamPhase === 'refinement') {
      hasLastTranscription = true;
    }
    streamBuffer = '';
    streamPhase = null;
  }

  if (state === 'recording' || state === 'vad-listening') {
    overlay.classList.add('expanded');
    soundbar.start();
  } else if (state === 'idle') {
    overlay.classList.remove('expanded');
    soundbar.idle();
  } else if (state === 'done') {
    overlay.classList.add('expanded');
    soundbar.idle();
  } else {
    overlay.classList.add('expanded');
    soundbar.stop();
  }
}

function div(className: string, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function compactUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}`;
  } catch {
    return value;
  }
}

function keyChip(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'tooltip-key';
  el.textContent = text;
  return el;
}

function tooltipRow(label: string, value: string): HTMLDivElement {
  const row = div('tooltip-row');
  row.append(div('tooltip-label', label), div('tooltip-value', value));
  return row;
}

function renderInfoTooltip(info: InfoView): void {
  const head = div('tooltip-head');
  const provider = div('tooltip-provider');
  provider.append(div('tooltip-name', info.providerDisplayName), div('tooltip-model', info.model));
  head.append(provider, div('tooltip-state', currentState));

  const rows = div('tooltip-rows');
  rows.append(
    tooltipRow('URL', compactUrl(info.baseUrl)),
    tooltipRow('Panel', compactUrl(info.controlPanelUrl)),
  );

  if (info.progressiveInjection) {
    rows.append(tooltipRow('Inject', 'Progressive'));
  }

  const hotkeys = div('tooltip-row');
  hotkeys.append(div('tooltip-label', 'Keys'));
  const keys = div('tooltip-keys');
  keys.append(keyChip(`PTT ${info.hotkeyCombo}`), keyChip(`Hide ${info.toggleHotkeyCombo}`));
  hotkeys.append(keys);
  rows.append(hotkeys);

  if (streamBuffer) {
    const streamPreview = div('stream-preview');
    streamPreview.append(
      div('stream-phase', streamPhase === 'transcription' ? 'Transcribing' : 'Refining'),
    );
    streamPreview.append(div('stream-text', streamBuffer));
    rows.append(streamPreview);
  }

  if (hasLastTranscription && (currentState === 'done' || currentState === 'idle')) {
    const refineRow = div('tooltip-row');
    refineRow.append(div('tooltip-label', 'Action'));
    const refineBtn = document.createElement('button');
    refineBtn.className = 'tooltip-key';
    refineBtn.textContent = 'Refine last';
    refineBtn.style.cursor = 'pointer';
    refineBtn.style.border = '1px solid rgba(255,255,255,0.1)';
    refineBtn.style.padding = '3px 8px';
    refineBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.murmur.refineLast();
    });
    refineRow.append(refineBtn);
    rows.append(refineRow);
  }

  const foot = div('tooltip-foot');
  foot.append(div('tooltip-dot'), div('tooltip-value', 'Drag to move. Right-click for menu.'));

  infoTooltip.replaceChildren(head, rows, foot);
}

setState('idle');

window.murmur.onStatus((s) => {
  if ((STATES as readonly string[]).includes(s)) {
    setState(s as StateName);
  }
  if (s === 'done') dismissErrorToast();
});

window.murmur.onToken((payload: TokenPayload) => {
  if (
    (payload.phase === 'transcription' && streamPhase === 'transcription') ||
    (payload.phase === 'refinement' && streamPhase === 'refinement')
  ) {
    streamBuffer += payload.token;
    if (latestInfo) renderInfoTooltip(latestInfo);
  }
});

let vadConfig: VadConfig = { enabled: false, thresholdDb: -40, silenceMs: 1500, leadInMs: 300 };
let autoStop = false;

window.murmur.onVadConfig((cfg) => {
  vadConfig = cfg;
});

window.murmur.onVadMode((mode) => {
  autoStop = mode.autoStop;
});

window.murmur.onStartRecording(async () => {
  try {
    await startCapture({
      vad: vadConfig,
      autoStop,
      onSpeechStart: () => window.murmur.vadSpeechStart(),
      onSilenceTimeout: () => window.murmur.vadSilenceTimeout(),
    });
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
  latestInfo = info;
  renderInfoTooltip(info);
});

window.murmur.requestInfo();

let lastErrorSessionDir: string | null = null;

function dismissErrorToast(): void {
  errorToast.classList.remove('visible');
  lastErrorSessionDir = null;
}

window.murmur.onQueueDepth((depth) => {
  if (depth > 0) {
    queueBadge.textContent = String(depth);
    queueBadge.classList.add('visible');
  } else {
    queueBadge.classList.remove('visible');
  }
});

window.murmur.onError((payload) => {
  lastErrorSessionDir = payload.sessionDir;
  errorMsgEl.textContent = payload.message;
  // A notice (e.g. "copied instead of typed") has nothing to retry or insert.
  retryBtn.hidden = payload.notice === true;
  insertRawBtn.hidden = payload.notice === true || payload.canInsertRaw !== true;
  errorToast.classList.add('visible');
});

retryBtn.addEventListener('click', () => {
  dismissErrorToast();
  window.murmur.retry();
});

insertRawBtn.addEventListener('click', () => {
  dismissErrorToast();
  window.murmur.insertRaw();
});

logBtn.addEventListener('click', () => {
  if (lastErrorSessionDir) window.murmur.openLogDir(lastErrorSessionDir);
});

dismissBtn.addEventListener('click', dismissErrorToast);

overlay.addEventListener('mouseenter', () => {
  window.murmur.setMouseInteractive(true);
});
overlay.addEventListener('mouseleave', () => {
  window.murmur.setMouseInteractive(false);
});

overlay.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.murmur.showContextMenu();
});

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
