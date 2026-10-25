const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/**
 * Tracks which form sections have unsaved user edits so auto-refresh never
 * overwrites in-progress work.  Cleared on a successful save of that section.
 * Every change redraws the save bar and the nav markers.
 */
class DirtySet extends Set {
  add(value) {
    const result = super.add(value);
    renderSaveBar();
    return result;
  }
  delete(value) {
    const result = super.delete(value);
    renderSaveBar();
    return result;
  }
  clear() {
    super.clear();
    renderSaveBar();
  }
}
const dirtyForms = new DirtySet();

const state = {
  config: null,
  overrides: {},
  shadowedEnv: {},
  configError: null,
  skills: [],
  composedSystemPrompt: '',
  providers: [],
  csrfToken: null,
  selectedSkillId: null,
  dirtySkill: false,
};

/**
 * Maps a ResolvedConfig key to:
 *   - inputId : the form control to mark read-only when an override is active
 *   - flag    : the CLI flag the user would have to drop to regain control
 *   - env     : the env var alternative
 *   - section : dirty-form section that should also be considered "locked"
 */
const FIELD_INFO = {
  provider: { inputId: 'cfg-provider', flag: '--provider', env: 'LLM_PROVIDER' },
  baseUrl: { inputId: 'cfg-baseUrl', flag: '--base-url', env: 'LLM_BASE_URL' },
  model: { inputId: 'cfg-model', flag: '--model', env: 'LLM_MODEL' },
  apiKey: { inputId: 'cfg-apiKey', flag: '--api-key', env: 'LLM_API_KEY' },
  temperature: { inputId: 'cfg-temperature', flag: '--temperature', env: 'LLM_TEMPERATURE' },
  whisperCliPath: { inputId: 'cfg-whisperCliPath', flag: '--whisper-cli', env: 'WHISPER_CLI_PATH' },
  whisperModelPath: {
    inputId: 'cfg-whisperModelPath',
    flag: '--whisper-model',
    env: 'WHISPER_MODEL_PATH',
  },
  hotkeyCombo: { inputId: 'cfg-hotkeyCombo', flag: '--hotkey', env: 'MURMUR_HOTKEY' },
  hotkeyMode: {
    inputId: 'cfg-hotkeyMode',
    flag: '--hotkey-mode',
    env: 'MURMUR_HOTKEY_MODE',
  },
  toggleHotkeyCombo: {
    inputId: 'cfg-toggleHotkeyCombo',
    flag: '--toggle-hotkey',
    env: 'MURMUR_TOGGLE_HOTKEY',
  },
  clipboardRestoreDelayMs: {
    inputId: 'cfg-clipboardRestoreDelayMs',
    flag: '--clipboard-restore-delay',
    env: 'MURMUR_CLIPBOARD_RESTORE_DELAY_MS',
  },
  clipboardRetention: {
    inputId: 'cfg-clipboardRetention',
    flag: '--clipboard-retention',
    env: 'MURMUR_CLIPBOARD_RETENTION',
  },
  injectionMethod: {
    inputId: 'cfg-injectionMethod',
    flag: '--injection-method',
    env: 'MURMUR_INJECTION_METHOD',
  },
  focusChangePolicy: {
    inputId: 'cfg-focusChangePolicy',
    flag: '--focus-change-policy',
    env: 'MURMUR_FOCUS_CHANGE_POLICY',
  },
  progressiveInjection: {
    inputId: 'cfg-progressiveInjection',
    flag: '--progressive-injection',
    env: 'MURMUR_PROGRESSIVE_INJECTION',
  },
  vadEnabled: { inputId: 'cfg-vadEnabled', flag: '--vad', env: 'MURMUR_VAD_ENABLED' },
  vadThresholdDb: {
    inputId: 'cfg-vadThresholdDb',
    flag: '--vad-threshold',
    env: 'MURMUR_VAD_THRESHOLD_DB',
  },
  vadSilenceMs: {
    inputId: 'cfg-vadSilenceMs',
    flag: '--vad-silence',
    env: 'MURMUR_VAD_SILENCE_MS',
  },
  vadLeadInMs: { inputId: 'cfg-vadLeadInMs', flag: '--vad-lead-in', env: 'MURMUR_VAD_LEAD_IN_MS' },
  contextCapture: {
    inputId: 'cfg-contextCapture',
    flag: '--context',
    env: 'MURMUR_CONTEXT_CAPTURE',
  },
  clipboardContextEntries: {
    inputId: 'cfg-clipboardContextEntries',
    flag: '--clipboard-entries',
    env: 'MURMUR_CLIPBOARD_CONTEXT_ENTRIES',
  },
  screenshotContext: {
    inputId: 'cfg-screenshotContext',
    flag: '--screenshot',
    env: 'MURMUR_SCREENSHOT_CONTEXT',
  },
  systemPrompt: { inputId: 'system-prompt', flag: '--system-prompt', env: 'MURMUR_SYSTEM_PROMPT' },
  controlPanelPort: {
    inputId: 'cfg-controlPanelPort',
    flag: '--control-panel-port',
    env: 'MURMUR_CONTROL_PANEL_PORT',
  },
  logMode: { inputId: 'cfg-logMode', flag: '--log-mode', env: 'MURMUR_LOG_MODE' },
  logsDir: { inputId: 'cfg-logsDir', flag: '--logs-dir', env: 'MURMUR_LOGS_DIR' },
  skillsDir: { inputId: 'cfg-skillsDir', flag: '--skills-dir', env: 'MURMUR_SKILLS_DIR' },
};

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (method !== 'GET' && state.csrfToken) opts.headers['X-Murmur-Token'] = state.csrfToken;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.rejected = json.rejected;
    err.status = res.status;
    err.existingId = json.existingId;
    err.requestedId = json.requestedId;
    throw err;
  }
  return json;
}

function clearFieldErrors() {
  for (const el of $$('.field-error')) el.remove();
  for (const el of $$('.invalid')) el.classList.remove('invalid');
}

/**
 * Marks the inputs the server refused (`rejected` is `{ field: reason }`) so a
 * failed save never looks like a successful one.  The form stays dirty because
 * callers only clear it after a successful save.
 */
function showFieldErrors(rejected) {
  clearFieldErrors();
  for (const [key, reason] of Object.entries(rejected ?? {})) {
    const input = document.getElementById(`cfg-${key.replace(/^overlay\./, '')}`);
    const wrapper = input?.closest('.field') ?? input?.parentElement;
    if (!input || !wrapper) continue;
    input.classList.add('invalid');
    const note = document.createElement('span');
    note.className = 'field-hint field-error';
    note.textContent = `Not saved: ${reason}`;
    wrapper.appendChild(note);
  }
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind ? `toast-${kind}` : ''}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 2400);
}

/** Announced to screen readers; the visible feedback is the save bar and the toast. */
function setSaveStatus(text) {
  $('#save-status').textContent = text;
}

function applyStateToDom() {
  const c = state.config;
  if (!c) return;

  // Each form section is only written when it has no unsaved user edits.
  // dirtyForms entries are set by input listeners and cleared on save.

  if (!dirtyForms.has('provider')) {
    $('#cfg-provider').value = c.provider;
    $('#cfg-baseUrl').value = c.baseUrl;
    $('#cfg-model').value = c.model;
    $('#cfg-apiKey').placeholder = c.apiKeySet
      ? '•••••••• (stored, leave blank to keep)'
      : '(not set)';
    $('#cfg-apiKey').value = '';
    $('#cfg-temperature').value = c.temperature;
    updateOnlineWarning(c.baseUrl);
    updateBaseUrlHint(c.provider, c.baseUrl);
  }

  if (!dirtyForms.has('system-prompt')) {
    $('#system-prompt').value = c.systemPrompt;
    updatePromptCharCount();
  }
  $('#composed-prompt').textContent = state.composedSystemPrompt;

  if (!dirtyForms.has('whisper')) {
    $('#cfg-whisperCliPath').value = c.whisperCliPath;
    $('#cfg-whisperModelPath').value = c.whisperModelPath;
  }

  if (!dirtyForms.has('hotkeys')) {
    $('#cfg-hotkeyCombo').value = c.hotkeyCombo;
    $('#cfg-hotkeyMode').value = c.hotkeyMode ?? 'hold';
    $('#cfg-toggleHotkeyCombo').value = c.toggleHotkeyCombo;
    $('#cfg-clipboardRestoreDelayMs').value = c.clipboardRestoreDelayMs;
    $('#cfg-clipboardRetention').value = c.clipboardRetention ?? 'keep-generated';
    $('#cfg-injectionMethod').value = c.injectionMethod ?? 'auto';
    $('#cfg-focusChangePolicy').value = c.focusChangePolicy ?? 'copy';
    $('#cfg-progressiveInjection').checked = Boolean(c.progressiveInjection);
  }

  if (!dirtyForms.has('voice')) {
    $('#cfg-vadEnabled').checked = Boolean(c.vadEnabled);
    $('#cfg-vadThresholdDb').value = c.vadThresholdDb;
    $('#cfg-vadSilenceMs').value = c.vadSilenceMs;
    $('#cfg-vadLeadInMs').value = c.vadLeadInMs;
    $('#cfg-contextCapture').checked = Boolean(c.contextCapture);
    $('#cfg-clipboardContextEntries').value = c.clipboardContextEntries ?? 0;
    $('#cfg-screenshotContext').checked = Boolean(c.screenshotContext);
    const routes = c.appSkillRoutes ?? [];
    $('#cfg-appSkillRoutes').value = routes.length ? JSON.stringify(routes, null, 2) : '';
  }

  if (!dirtyForms.has('paths')) {
    $('#cfg-logsDir').value = c.logsDir;
    $('#cfg-logMode').value = c.logMode ?? 'metadata-only';
    $('#cfg-skillsDir').value = c.skillsDir;
    $('#cfg-controlPanelPort').value = c.controlPanelPort;
    $('#cfg-configFilePath').value = c.configFilePath;
  }

  syncSliders();
  renderSkillList();
  if (state.selectedSkillId) {
    if (state.selectedSkillId === '__new__') {
      // User is filling in a new skill — never clobber it on refresh.
    } else {
      const found = state.skills.find((s) => s.id === state.selectedSkillId);
      if (found) selectSkill(found.id, true);
      else showSkillForm(null);
    }
  }
}

/**
 * For every field in `state.overrides`, lock the matching input and attach a
 * small chip explaining which CLI flag / env var is shadowing it.  Saves to
 * locked fields would silently no-op on the next config reload, so making
 * them read-only is the only honest UX.
 */
function applyOverridesToDom() {
  const overrides = state.overrides ?? {};
  for (const [key, info] of Object.entries(FIELD_INFO)) {
    const input = document.getElementById(info.inputId);
    if (!input) continue;
    const source = overrides[key];
    setFieldLocked(input, info, source);
  }
}

/**
 * An env var that is set but outranked (by a CLI flag or config.json) locks
 * nothing, since the field is still editable here.  Say why the env var does
 * nothing so nobody wonders why their `.env` edit had no effect.
 */
function applyShadowedEnvToDom() {
  const shadowed = state.shadowedEnv ?? {};
  for (const [key, info] of Object.entries(FIELD_INFO)) {
    const input = document.getElementById(info.inputId);
    const wrapper = input?.closest('.field') ?? input?.parentElement;
    if (!wrapper) continue;
    const existing = wrapper.querySelector('.shadow-note');
    const entry = shadowed[key];
    if (!entry) {
      existing?.remove();
      continue;
    }
    const text =
      entry.by === 'cli'
        ? `${entry.envVar} is set, but the ${info.flag} CLI flag overrides it.`
        : `${entry.envVar} is set, but config.json overrides it. Remove "${key}" from config.json to use the env var.`;
    if (existing) {
      existing.textContent = text;
      continue;
    }
    const note = document.createElement('span');
    note.className = 'field-hint shadow-note';
    note.textContent = text;
    wrapper.appendChild(note);
  }
}

/**
 * config.json exists but can't be parsed: Murmur is running on built-in defaults
 * and refuses to save over the file, so say so instead of looking healthy.
 */
function applyConfigErrorToDom() {
  const el = $('#config-error');
  if (!el) return;
  const message = state.configError;
  el.hidden = !message;
  el.textContent = message
    ? `config.json could not be parsed, so built-in defaults are in use and nothing will be saved until it is fixed. ${message}`
    : '';
}

function setFieldLocked(input, info, source) {
  const wrapper = input.closest('.field') ?? input.parentElement;
  const existing = wrapper?.querySelector('.override-chip');

  // A slider or Record button beside the field follows the field's lock.
  const companions = [input._range, input._record].filter(Boolean);

  if (!source) {
    input.readOnly = false;
    input.disabled = false;
    input.classList.remove('locked');
    for (const c of companions) c.disabled = false;
    existing?.remove();
    return;
  }

  // SELECTs and checkboxes don't honour readOnly, so we disable them instead.
  if (input.tagName === 'SELECT' || input.type === 'checkbox') input.disabled = true;
  else input.readOnly = true;
  input.classList.add('locked');
  for (const c of companions) c.disabled = true;

  const label =
    source === 'cli' ? `Locked by ${info.flag} CLI flag` : `Locked by ${info.env} env var`;
  const tip = `Restart Murmur without ${
    source === 'cli' ? `the ${info.flag} flag` : `the ${info.env} environment variable`
  } to edit this here.`;

  if (existing) {
    existing.textContent = label;
    existing.title = tip;
    return;
  }
  if (!wrapper) return;
  const chip = document.createElement('span');
  chip.className = 'override-chip';
  chip.textContent = label;
  chip.title = tip;
  wrapper.appendChild(chip);
}

function updatePromptCharCount() {
  const el = $('#prompt-charcount');
  el.textContent = `${$('#system-prompt').value.length} chars`;
}

/** Two skill files with one id: only one is used, so say which ones are ignored. */
function renderSkillConflicts() {
  const note = $('#skill-conflicts');
  const conflicts = state.skillConflicts ?? [];
  note.classList.toggle('hidden', conflicts.length === 0);
  note.textContent = conflicts
    .map(
      (c) =>
        `${c.file} is ignored: ${c.keptFile} already provides the skill “${c.id}”. ` +
        'Rename the id in one of the files, or delete the one you do not want.',
    )
    .join('\n');
}

function renderSkillList() {
  const list = $('#skill-list');
  list.innerHTML = '';
  const count = $('#skill-count');
  const enabled = new Set(state.config?.enabledSkills ?? []);
  count.textContent = `${state.skills.length} total · ${
    state.skills.filter((s) => enabled.has(s.id)).length
  } active`;
  renderSkillConflicts();
  if (state.skills.length === 0) {
    const li = document.createElement('li');
    li.className = 'skill-item';
    li.innerHTML =
      '<div class="text"><span class="name" style="color:var(--text-faint)">No skills yet — click “+ New skill”.</span></div>';
    list.appendChild(li);
    return;
  }
  for (const s of state.skills) {
    const li = document.createElement('li');
    li.className = `skill-item${state.selectedSkillId === s.id ? ' selected' : ''}`;
    li.dataset.id = s.id;
    li.innerHTML = `
      <span class="dot ${enabled.has(s.id) ? 'on' : ''}" title="${
        enabled.has(s.id) ? 'Active' : 'Disabled'
      }"></span>
      <div class="text">
        <span class="name">${escapeHtml(s.name)}</span>
        ${s.description ? `<span class="desc">${escapeHtml(s.description)}</span>` : ''}
      </div>
    `;
    // Focusable and operable from the keyboard, like the buttons beside it.
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-pressed', String(state.selectedSkillId === s.id));
    li.addEventListener('click', () => selectSkill(s.id));
    li.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      selectSkill(s.id);
    });
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function showSkillForm(skill) {
  state.selectedSkillId = skill ? skill.id : null;
  $('#skill-empty').classList.toggle('hidden', !!skill);
  $('#skill-form').classList.toggle('hidden', !skill);
  if (!skill) return;
  $('#skill-id').value = skill.id;
  $('#skill-id').readOnly = true;
  $('#skill-name').value = skill.name;
  $('#skill-desc').value = skill.description;
  $('#skill-content').value = skill.content;
  $('#skill-enabled').checked = (state.config?.enabledSkills ?? []).includes(skill.id);
  $('#btn-delete-skill').style.display = 'inline-flex';
  renderSkillList();
}

function showNewSkillForm() {
  state.selectedSkillId = '__new__';
  $('#skill-empty').classList.add('hidden');
  $('#skill-form').classList.remove('hidden');
  $('#skill-id').value = '';
  $('#skill-id').readOnly = false;
  $('#skill-name').value = '';
  $('#skill-desc').value = '';
  $('#skill-content').value = '';
  $('#skill-import-warning').classList.add('hidden');
  $('#skill-enabled').checked = false;
  $('#btn-delete-skill').style.display = 'none';
  renderSkillList();
  $('#skill-name').focus();
}

function selectSkill(id, skipScroll) {
  const skill = state.skills.find((s) => s.id === id);
  if (!skill) return;
  showSkillForm(skill);
  if (!skipScroll) {
    const el = $(`.skill-item[data-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }
}

async function refresh() {
  try {
    const snap = await api('GET', '/api/state');
    state.config = snap.config;
    state.overrides = snap.overrides ?? {};
    state.shadowedEnv = snap.shadowedEnv ?? {};
    state.configError = snap.configError ?? null;
    state.skills = snap.skills;
    state.skillConflicts = snap.skillConflicts ?? [];
    state.composedSystemPrompt = snap.composedSystemPrompt;
    state.providers = snap.providers;
    state.csrfToken = snap.security?.csrfToken ?? state.csrfToken;
    state.overlay = snap.overlay ?? { visible: null };
    applyStateToDom();
    applyOverridesToDom();
    applyShadowedEnvToDom();
    applyConfigErrorToDom();
    applyOverlayStateToDom();
    setSaveStatus('');
  } catch (err) {
    toast(`Failed to load state: ${err.message}`, 'error');
  }
}

function applyOverlayStateToDom() {
  const el = $('#overlay-state');
  if (!el) return;
  const visible = state.overlay?.visible;
  if (visible === true) {
    el.dataset.state = 'visible';
    el.querySelector('.text').textContent = 'visible';
  } else if (visible === false) {
    el.dataset.state = 'hidden';
    el.querySelector('.text').textContent = 'hidden';
  } else {
    el.dataset.state = 'unknown';
    el.querySelector('.text').textContent = '—';
  }
  const showBtn = $('#btn-overlay-show');
  const hideBtn = $('#btn-overlay-hide');
  if (showBtn) showBtn.disabled = visible === true;
  if (hideBtn) hideBtn.disabled = visible === false;
}

function wireOverlayControls() {
  const showBtn = $('#btn-overlay-show');
  const hideBtn = $('#btn-overlay-hide');
  if (!showBtn || !hideBtn) return;
  showBtn.addEventListener('click', async () => {
    try {
      const res = await api('POST', '/api/overlay/show');
      state.overlay = { visible: res.visible };
      applyOverlayStateToDom();
      toast('Overlay shown', 'ok');
    } catch (err) {
      toast(`Could not show overlay: ${err.message}`, 'error');
    }
  });
  hideBtn.addEventListener('click', async () => {
    try {
      const res = await api('POST', '/api/overlay/hide');
      state.overlay = { visible: res.visible };
      applyOverlayStateToDom();
      toast('Overlay hidden', 'ok');
    } catch (err) {
      toast(`Could not hide overlay: ${err.message}`, 'error');
    }
  });
}

function _activeTab() {
  return $$('.tab').find((t) => t.classList.contains('active'))?.dataset.tab ?? 'system-prompt';
}

function setTab(name) {
  for (const t of $$('.tab')) {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    if (active) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
  for (const p of $$('.pane')) p.classList.toggle('active', p.dataset.pane === name);
  history.replaceState(null, '', `#${name}`);
}

function wireTabs() {
  for (const t of $$('.tab')) {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  }
  const initial = location.hash.slice(1) || 'system-prompt';
  setTab(initial);
}

function wireSystemPrompt() {
  $('#system-prompt').addEventListener('input', () => {
    dirtyForms.add('system-prompt');
    updatePromptCharCount();
  });
  // Like every other edit, resetting waits for "Save changes", so Discard undoes it.
  $('#btn-reset-prompt').addEventListener('click', () => {
    if ($('#system-prompt').readOnly) return;
    $('#system-prompt').value = DEFAULT_PROMPT;
    dirtyForms.add('system-prompt');
    updatePromptCharCount();
  });
}

function wireSkills() {
  $('#btn-new-skill').addEventListener('click', showNewSkillForm);
  $('#skill-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      id: $('#skill-id').value.trim() || undefined,
      name: $('#skill-name').value.trim(),
      description: $('#skill-desc').value.trim(),
      content: $('#skill-content').value,
    };
    if (!payload.name || !payload.content) {
      toast('Name and instructions are required', 'error');
      return;
    }
    const isNew = state.selectedSkillId === '__new__';
    try {
      if (isNew) {
        let snap;
        let savedId;
        try {
          snap = await api('POST', '/api/skills', payload);
          // Use the id the server assigned (may differ from the client-guessed slug).
          savedId = snap.createdId;
        } catch (err) {
          // Creating never overwrites. Replacing is only offered for the skill that owns this id.
          const owner = err.status === 409 && err.existingId && err.existingId === err.requestedId;
          if (!owner) throw err;
          const replace = confirm(
            `A skill with the ID “${err.existingId}” already exists.\n\n` +
              'OK replaces it with this one. Cancel keeps it so you can change the name or ID.',
          );
          if (!replace) {
            toast(err.message, 'error');
            return;
          }
          snap = await api('PUT', `/api/skills/${encodeURIComponent(err.existingId)}`, payload);
          savedId = err.existingId;
        }
        applySnapshot(snap);
        state.selectedSkillId = savedId;
      } else {
        const id = state.selectedSkillId;
        const snap = await api('PUT', `/api/skills/${encodeURIComponent(id)}`, payload);
        applySnapshot(snap);
      }
      const wantEnabled = $('#skill-enabled').checked;
      const currentEnabled = (state.config?.enabledSkills ?? []).includes(state.selectedSkillId);
      if (wantEnabled !== currentEnabled) {
        const snap = await api(
          'POST',
          `/api/skills/${encodeURIComponent(state.selectedSkillId)}/toggle`,
          { enabled: wantEnabled },
        );
        applySnapshot(snap);
      }
      toast('Skill saved', 'success');
      applyStateToDom();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#btn-delete-skill').addEventListener('click', async () => {
    const id = state.selectedSkillId;
    if (!id || id === '__new__') return;
    if (!confirm(`Delete skill “${id}”?`)) return;
    try {
      const snap = await api('DELETE', `/api/skills/${encodeURIComponent(id)}`);
      applySnapshot(snap);
      state.selectedSkillId = null;
      showSkillForm(null);
      toast('Skill deleted', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#skill-enabled').addEventListener('change', async (e) => {
    const id = state.selectedSkillId;
    if (!id || id === '__new__') return;
    try {
      const snap = await api('POST', `/api/skills/${encodeURIComponent(id)}/toggle`, {
        enabled: e.target.checked,
      });
      applySnapshot(snap);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function applySnapshot(snap) {
  state.config = snap.config;
  state.overrides = snap.overrides ?? state.overrides ?? {};
  state.shadowedEnv = snap.shadowedEnv ?? state.shadowedEnv ?? {};
  state.configError = snap.configError ?? null;
  state.skills = snap.skills;
  state.skillConflicts = snap.skillConflicts ?? [];
  state.composedSystemPrompt = snap.composedSystemPrompt;
  state.providers = snap.providers ?? state.providers;
  state.csrfToken = snap.security?.csrfToken ?? state.csrfToken;
  applyStateToDom();
  applyOverridesToDom();
  applyShadowedEnvToDom();
  applyConfigErrorToDom();
}

function wireProvider() {
  // Mark provider form dirty whenever any field is touched.
  for (const id of ['cfg-provider', 'cfg-baseUrl', 'cfg-model', 'cfg-apiKey', 'cfg-temperature']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', () => dirtyForms.add('provider'));
    el.addEventListener('change', () => dirtyForms.add('provider'));
  }

  // Saving goes through the save bar, never a per-form submit.
  $('#provider-form').addEventListener('submit', (e) => e.preventDefault());
  $('#btn-test-llm').addEventListener('click', async () => {
    const el = $('#llm-test-result');
    // The test uses the saved provider, so it would say nothing about unsaved edits.
    if (dirtyForms.has('provider')) {
      el.textContent = 'Save your changes first. The test uses the saved provider settings.';
      el.style.color = 'var(--caution)';
      return;
    }
    el.textContent = 'Testing…';
    el.style.color = 'var(--text-dim)';
    try {
      const res = await api('POST', '/api/test/llm', {});
      if (res.ok) {
        el.textContent = `OK · ${res.message || 'connected'}${
          res.latencyMs ? ` (${res.latencyMs} ms)` : ''
        }`;
        el.style.color = 'var(--good)';
      } else {
        el.textContent = `Failed · ${res.message || 'unknown error'}`;
        el.style.color = 'var(--bad)';
      }
    } catch (err) {
      el.textContent = `Failed · ${err.message}`;
      el.style.color = 'var(--bad)';
    }
  });
  for (const btn of $$('.preset')) {
    btn.addEventListener('click', (e) => {
      const which = e.currentTarget.dataset.preset;
      if (which === 'ollama') {
        $('#cfg-provider').value = 'ollama';
        $('#cfg-baseUrl').value = 'http://localhost:11434';
        $('#cfg-model').value = 'qwen3:4b';
      } else if (which === 'lmstudio') {
        $('#cfg-provider').value = 'openai-compat';
        $('#cfg-baseUrl').value = 'http://localhost:1234/v1';
      } else if (which === 'llamacpp') {
        $('#cfg-provider').value = 'openai-compat';
        $('#cfg-baseUrl').value = 'http://localhost:8080/v1';
      } else if (which === 'openai') {
        $('#cfg-provider').value = 'openai-compat';
        $('#cfg-baseUrl').value = 'https://api.openai.com/v1';
        $('#cfg-model').value = 'gpt-4o-mini';
      } else if (which === 'anthropic-haiku') {
        $('#cfg-provider').value = 'anthropic';
        $('#cfg-baseUrl').value = 'https://api.anthropic.com/v1';
        $('#cfg-model').value = 'claude-haiku-4-5';
      } else if (which === 'openrouter') {
        $('#cfg-provider').value = 'openai-compat';
        $('#cfg-baseUrl').value = 'https://openrouter.ai/api/v1';
        $('#cfg-model').value = 'meta-llama/llama-3.1-8b-instruct:free';
      } else if (which === 'groq') {
        $('#cfg-provider').value = 'openai-compat';
        $('#cfg-baseUrl').value = 'https://api.groq.com/openai/v1';
        $('#cfg-model').value = 'llama-3.1-8b-instant';
      }
      dirtyForms.add('provider');
      // Preset buttons make an intentional choice — show warning immediately.
      updateOnlineWarning($('#cfg-baseUrl').value);
      updateBaseUrlHint($('#cfg-provider').value, $('#cfg-baseUrl').value);
    });
  }
  // Validate base URL live and on provider change.
  const checkBaseUrl = () => {
    const url = $('#cfg-baseUrl').value.trim();
    const provider = $('#cfg-provider').value;
    // The badge follows what is typed; the warning banner waits for a deliberate choice.
    updateLocalityBadge(url);
    const hint = $('#baseurl-hint');
    if (!hint) return;
    if (provider === 'openai-compat' && url && !/\/v\d+\/?$/.test(url.replace(/\/$/, ''))) {
      hint.textContent = '⚠ Most OpenAI-compatible servers need a version suffix — e.g. /v1';
      hint.classList.remove('hidden');
    } else {
      hint.textContent = '';
      hint.classList.add('hidden');
    }
  };
  $('#cfg-baseUrl').addEventListener('input', checkBaseUrl);
  $('#cfg-provider').addEventListener('change', checkBaseUrl);

  $('#goto-model-guide')?.addEventListener('click', () => setTab('model-guide'));
}

/** Marks `dirtyKey` dirty on any edit in the form. Saving is the save bar's job. */
function wireGenericForm(selector, dirtyKey) {
  const form = $(selector);
  for (const el of form.querySelectorAll('input, textarea, select')) {
    el.addEventListener('input', () => dirtyForms.add(dirtyKey));
    el.addEventListener('change', () => dirtyForms.add(dirtyKey));
  }
  form.addEventListener('submit', (e) => e.preventDefault());
}

function wireWhisper() {
  wireGenericForm('#whisper-form', 'whisper');
}

function wireHotkeys() {
  wireGenericForm('#hotkeys-form', 'hotkeys');
}

/** Throws a readable error so the save toast explains what is wrong. */
function parseAppSkillRoutes(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`App skill routes: invalid JSON (${err.message})`);
  }
  if (!Array.isArray(parsed)) throw new Error('App skill routes must be a JSON array');
  return parsed.map((r) => ({
    match: String(r?.match ?? ''),
    enable: Array.isArray(r?.enable) ? r.enable : [],
    disable: Array.isArray(r?.disable) ? r.disable : [],
  }));
}

function readVoiceForm() {
  return {
    vadEnabled: $('#cfg-vadEnabled').checked,
    vadThresholdDb: Number($('#cfg-vadThresholdDb').value),
    vadSilenceMs: Number($('#cfg-vadSilenceMs').value),
    vadLeadInMs: Number($('#cfg-vadLeadInMs').value),
    contextCapture: $('#cfg-contextCapture').checked,
    clipboardContextEntries: Number($('#cfg-clipboardContextEntries').value),
    screenshotContext: $('#cfg-screenshotContext').checked,
    appSkillRoutes: parseAppSkillRoutes($('#cfg-appSkillRoutes').value),
  };
}

function wireVoice() {
  wireGenericForm('#voice-form', 'voice');
}

function wirePaths() {
  wireGenericForm('#paths-form', 'paths');
}

// ── One save model ────────────────────────────────────────────

/**
 * What each config section sends. Only sections with unsaved edits are read, merged
 * into one PUT /api/config, so the server validates and writes them together and
 * reports any rejected field by name.
 */
const SECTIONS = {
  provider: {
    label: 'Provider',
    read: () => {
      const patch = {
        provider: $('#cfg-provider').value,
        baseUrl: $('#cfg-baseUrl').value.trim(),
        model: $('#cfg-model').value.trim(),
        temperature: Number($('#cfg-temperature').value),
      };
      const apiKey = $('#cfg-apiKey').value;
      if (apiKey) patch.apiKey = apiKey;
      else if ($('#cfg-apiKey').dataset.clear === '1') patch.apiKey = null;
      return patch;
    },
  },
  whisper: {
    label: 'Whisper',
    read: () => ({
      whisperCliPath: $('#cfg-whisperCliPath').value.trim(),
      whisperModelPath: $('#cfg-whisperModelPath').value.trim(),
    }),
  },
  hotkeys: {
    label: 'Hotkeys',
    read: () => ({
      hotkeyCombo: $('#cfg-hotkeyCombo').value.trim(),
      hotkeyMode: $('#cfg-hotkeyMode').value,
      toggleHotkeyCombo: $('#cfg-toggleHotkeyCombo').value.trim(),
      clipboardRestoreDelayMs: Number($('#cfg-clipboardRestoreDelayMs').value),
      clipboardRetention: $('#cfg-clipboardRetention').value,
      injectionMethod: $('#cfg-injectionMethod').value,
      focusChangePolicy: $('#cfg-focusChangePolicy').value,
      progressiveInjection: $('#cfg-progressiveInjection').checked,
    }),
  },
  voice: { label: 'Voice & context', read: readVoiceForm },
  paths: {
    label: 'Paths',
    read: () => ({
      logsDir: $('#cfg-logsDir').value.trim(),
      logMode: $('#cfg-logMode').value,
      skillsDir: $('#cfg-skillsDir').value.trim(),
      controlPanelPort: Number($('#cfg-controlPanelPort').value),
    }),
  },
  'system-prompt': { label: 'System prompt' },
};

let saving = false;

/** Shows the bar only while something is unsaved, and marks those sections in the nav. */
function renderSaveBar() {
  const bar = $('#savebar');
  if (!bar) return;
  const keys = [...dirtyForms].filter((k) => SECTIONS[k]);
  bar.hidden = keys.length === 0;
  const labels = keys.map((k) => SECTIONS[k].label);
  $('#savebar-text').innerHTML = keys.length
    ? `<strong>Unsaved changes</strong> in ${escapeHtml(labels.join(', '))}`
    : '';
  for (const t of $$('.tab')) {
    const dirty = keys.includes(t.dataset.tab);
    const suffix = t.querySelector('.tab-dirty');
    if (dirty) {
      t.dataset.dirty = '1';
      // Keeps the button's own name ("Hotkeys") and adds to it, instead of replacing it.
      if (!suffix) {
        const note = document.createElement('span');
        note.className = 'sr-only tab-dirty';
        note.textContent = ' (unsaved changes)';
        t.appendChild(note);
      }
    } else {
      delete t.dataset.dirty;
      suffix?.remove();
    }
  }
  const saveBtn = $('#btn-save');
  if (saveBtn) saveBtn.disabled = saving;
}

async function saveChanges() {
  if (saving || dirtyForms.size === 0) return;
  saving = true;
  renderSaveBar();
  setSaveStatus('Saving…');
  const configKeys = [...dirtyForms].filter((k) => SECTIONS[k]?.read);
  try {
    const patch = {};
    for (const key of configKeys) Object.assign(patch, SECTIONS[key].read());
    if (configKeys.length) {
      const snap = await api('PUT', '/api/config', patch);
      clearFieldErrors();
      for (const key of configKeys) dirtyForms.delete(key);
      applySnapshot(snap);
    }
    if (dirtyForms.has('system-prompt')) {
      await api('PUT', '/api/system-prompt', { prompt: $('#system-prompt').value });
      dirtyForms.delete('system-prompt');
      await refresh();
    }
    setSaveStatus('Saved');
    toast('Changes saved', 'success');
  } catch (err) {
    // The sections that failed stay dirty, so nothing that was refused looks saved.
    showFieldErrors(err.rejected);
    setSaveStatus('Not saved');
    toast(err.message, 'error');
  } finally {
    saving = false;
    renderSaveBar();
  }
}

function discardChanges() {
  dirtyForms.clear();
  clearFieldErrors();
  applyStateToDom();
  applyOverridesToDom();
  applyShadowedEnvToDom();
  setSaveStatus('Changes discarded');
}

function wireSaveBar() {
  // Editing a field the server refused clears its "Not saved" note; the next save re-checks it.
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.classList.contains('invalid')) return;
    el.classList.remove('invalid');
    (el.closest('.field') ?? el.parentElement)?.querySelector('.field-error')?.remove();
  });
  $('#btn-save').addEventListener('click', saveChanges);
  $('#btn-discard').addEventListener('click', discardChanges);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveChanges();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirtyForms.size === 0) return;
    e.preventDefault();
    e.returnValue = '';
  });
  renderSaveBar();
}

const DEFAULT_PROMPT = `You refine a raw voice transcription into a high-quality prompt for an AI coding assistant.

Rules:
- Rewrite the transcription as one concise prompt that preserves exactly what the user asked for.
- Remove filler words (um, like, you know, basically, actually, kind of, sort of).
- Fix obvious dictation artifacts and homophones using coding context (e.g. "react" not "wreaked", "async" not "a sink").
- Do not invent requirements, context, constraints, examples, or output formats the user did not state.
- Do not expand vague ideas into implementation plans. If something is ambiguous, keep it ambiguous.
- Keep the user's voice and level of detail. Do not make it corporate or verbose.
- Use bullets only when the user clearly dictated multiple distinct items.
- Output ONLY the refined prompt. No preamble like "Here is the refined prompt:". No meta-commentary. No markdown code fences unless the refined prompt itself needs them.`;

/**
 * Returns true when `url`'s hostname looks like a domain name (contains
 * at least one letter and at least one dot), as opposed to localhost, a bare
 * IPv4 address, or an IPv6 address.
 *
 * We only warn for domain-based URLs because an IP address could be the
 * user's own private or dedicated server — we can't know either way.
 */
function isDomainUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return false;
    if (h === 'localhost') return false;
    // IPv4: four groups of digits separated by dots
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
    // IPv6: contains colons
    if (h.includes(':')) return false;
    // Anything with letters and a dot is a domain name
    return /[a-z]/.test(h) && h.includes('.');
  } catch {
    return false;
  }
}

/**
 * Where prompts and transcriptions go for a base URL: this machine ('local'), a
 * named host presumed to be a third party ('cloud', the same rule as the warning
 * banner), another address Murmur cannot classify ('network'), or nothing to show
 * ('unknown'). Pure, so it is unit-tested without a DOM.
 */
function providerLocality(baseUrl) {
  let host;
  try {
    host = new URL(String(baseUrl ?? '').trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return 'unknown';
  }
  if (!host) return 'unknown';
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  ) {
    return 'local';
  }
  return isDomainUrl(baseUrl) ? 'cloud' : 'network';
}

const LOCALITY_LABEL = { local: 'Local', cloud: 'Cloud', network: 'Network' };
const LOCALITY_TITLE = {
  local: 'Requests stay on this machine',
  cloud: 'Requests go to a third-party server',
  network: 'Requests go to another machine on your network',
};

function updateLocalityBadge(baseUrl) {
  const el = $('#provider-locality');
  if (!el) return;
  const kind = providerLocality(baseUrl);
  el.dataset.locality = kind;
  el.classList.toggle('hidden', kind === 'unknown');
  el.textContent = LOCALITY_LABEL[kind] ?? '';
  el.title = LOCALITY_TITLE[kind] ?? '';
}

function updateBaseUrlHint(provider, url) {
  const hint = $('#baseurl-hint');
  if (!hint) return;
  if (provider === 'openai-compat' && url && !/\/v\d+\/?$/.test(String(url).replace(/\/$/, ''))) {
    hint.textContent = '⚠ Most OpenAI-compatible servers need a version suffix — e.g. /v1';
    hint.classList.remove('hidden');
  } else {
    hint.textContent = '';
    hint.classList.add('hidden');
  }
}

function updateOnlineWarning(baseUrl) {
  updateLocalityBadge(baseUrl);
  const el = $('#online-warning');
  if (!el) return;
  if (baseUrl && isDomainUrl(baseUrl)) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ── Sliders ───────────────────────────────────────────────────

/** Fills the track up to the thumb (the CSS draws the highlighter from --fill). */
function paintRange(range) {
  const min = Number(range.min);
  const span = Number(range.max) - min;
  const pct = span > 0 ? ((Number(range.value) - min) / span) * 100 : 0;
  range.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
}

/**
 * Pairs each `input[type=number][data-slider]` with a range input and a unit.
 * The number input stays the source of truth (ids, locks, saving all use it).
 */
function enhanceSliders() {
  for (const num of $$('input[type="number"][data-slider]')) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = num.min;
    range.max = num.max;
    range.step = num.step || '1';
    const label = document.querySelector(`label[for="${num.id}"]`);
    if (label) range.setAttribute('aria-label', label.textContent.trim());
    num.before(wrap);
    wrap.append(range, num);
    if (num.dataset.unit) {
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = num.dataset.unit;
      wrap.append(unit);
    }
    range.addEventListener('input', () => {
      num.value = range.value;
      paintRange(range);
      num.dispatchEvent(new Event('input', { bubbles: true }));
    });
    num.addEventListener('input', () => {
      if (num.value !== '') range.value = num.value;
      paintRange(range);
    });
    num._range = range;
  }
}

/** Re-reads every number input into its slider (values are also set from code). */
function syncSliders() {
  for (const num of $$('input[type="number"][data-slider]')) {
    const range = num._range;
    if (!range) continue;
    if (num.value !== '') range.value = num.value;
    paintRange(range);
  }
}

// ── Hotkey capture ────────────────────────────────────────────

/**
 * Names the hotkey library accepts (UiohookKey) that a KeyboardEvent.code can produce.
 * Letters and digits are handled separately (KeyA -> A, Digit1 -> 1).
 */
const CAPTURABLE_CODES = new Set([
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'Space',
  'Enter',
  'Tab',
  'Backspace',
  'CapsLock',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Delete',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'Semicolon',
  'Equal',
  'Comma',
  'Minus',
  'Period',
  'Slash',
  'Backquote',
  'BracketLeft',
  'Backslash',
  'BracketRight',
  'Quote',
  'PrintScreen',
  'ScrollLock',
  'NumLock',
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  'NumpadMultiply',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadDecimal',
  'NumpadDivide',
  'NumpadEnter',
]);

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

/** A key that is safe to bind with no modifier: it does not type anything. */
const BARE_OK = /^F([1-9]|1\d|2[0-4])$|^(PrintScreen|ScrollLock)$/;

/**
 * Turns a keydown into a combo string in the syntax the hotkey parser reads
 * ("Ctrl+Shift+Space"). Pure, so it is unit-tested without a DOM.
 *   { done: false }            only modifiers so far: keep listening
 *   { done: false, error }     this press cannot be used: say why, keep listening
 *   { done: true, combo }      finished
 */
function describeKeyCapture(e) {
  if (MODIFIER_CODES.has(e.code)) return { done: false };
  const letter = /^Key([A-Z])$/.exec(e.code) ?? /^Digit(\d)$/.exec(e.code);
  const key = letter ? letter[1] : CAPTURABLE_CODES.has(e.code) ? e.code : null;
  if (!key) return { done: false, error: 'That key cannot be used as a hotkey.' };
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.shiftKey) mods.push('Shift');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) mods.push('Meta');
  if (mods.length === 0 && !BARE_OK.test(key)) {
    return {
      done: false,
      error: 'Add Ctrl, Alt, Shift or Meta, or use a function key, so normal typing is unaffected.',
    };
  }
  return { done: true, combo: [...mods, key].join('+') };
}

function wireHotkeyCapture() {
  for (const button of $$('button[data-record]')) {
    const input = document.getElementById(button.dataset.record);
    if (!input) continue;
    input._record = button;
    const field = input.closest('.field') ?? input.parentElement;
    let previous = '';
    let note = null;

    const say = (text) => {
      if (!text) {
        note?.remove();
        note = null;
        return;
      }
      if (!note) {
        note = document.createElement('span');
        note.className = 'field-hint';
        note.setAttribute('role', 'status');
        field.appendChild(note);
      }
      note.textContent = text;
    };

    const stop = () => {
      input.classList.remove('capturing');
      input.placeholder = '';
      button.textContent = 'Record';
      input.removeEventListener('keydown', onKey, true);
      input.removeEventListener('blur', cancel);
    };

    function cancel() {
      input.value = previous;
      stop();
      say('');
    }

    function onKey(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        cancel();
        return;
      }
      const result = describeKeyCapture(e);
      if (!result.done) {
        say(result.error ?? 'Now press the other key.');
        return;
      }
      input.value = result.combo;
      stop();
      say('');
      dirtyForms.add('hotkeys');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Keep focus in the field while the button is pressed, or the field's blur would
    // cancel the capture before the click could turn it off (and then start it again).
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      if (input.classList.contains('capturing')) {
        cancel();
        return;
      }
      previous = input.value;
      input.classList.add('capturing');
      input.value = '';
      input.placeholder = 'Press the keys…';
      button.textContent = 'Cancel';
      say('Press the keys you want to use. Esc cancels.');
      input.addEventListener('keydown', onKey, true);
      input.addEventListener('blur', cancel);
      input.focus();
    });
  }
}

// ── Skill import ──────────────────────────────────────────────

/**
 * Parse a Markdown skill file (YAML frontmatter + body).
 * Returns id/name/description/content. Works with or without frontmatter.
 */
function parseSkillMarkdown(text) {
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!match) {
    return { id: '', name: '', description: '', content: text.trim() };
  }
  const yaml = match[1];
  const content = match[2].trim();
  const get = (key) => (yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')) || [])[1]?.trim() ?? '';
  return { id: get('id'), name: get('name'), description: get('description'), content };
}

function prefillNewSkillForm(parsed) {
  showNewSkillForm();
  if (parsed.name) $('#skill-name').value = parsed.name;
  if (parsed.description) $('#skill-desc').value = parsed.description;
  if (parsed.id) {
    $('#skill-id').value = parsed.id;
    $('#skill-id').readOnly = false; // let user adjust
  }
  if (parsed.content) $('#skill-content').value = parsed.content;
  $('#skill-import-warning').classList.remove('hidden');
  // Collapse the import panel
  $('#skill-import-panel').classList.add('hidden');
  // Focus the most useful field
  (parsed.name ? $('#skill-content') : $('#skill-name')).focus();
}

function wireImportSkill() {
  const btn = $('#btn-import-skill');
  const panel = $('#skill-import-panel');

  btn.addEventListener('click', () => panel.classList.toggle('hidden'));

  // Import sub-tabs (File / URL)
  for (const tab of $$('.import-tab')) {
    tab.addEventListener('click', () => {
      for (const t of $$('.import-tab')) t.classList.remove('active');
      tab.classList.add('active');
      for (const p of $$('.import-pane')) p.classList.add('hidden');
      $(`#import-pane-${tab.dataset.itab}`).classList.remove('hidden');
    });
  }

  // File import
  const fileInput = $('#skill-file-input');
  const fileLabel = $('#import-file-label');

  fileLabel.addEventListener('click', () => fileInput.click());
  fileLabel.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileLabel.classList.add('drag-over');
  });
  fileLabel.addEventListener('dragleave', () => fileLabel.classList.remove('drag-over'));
  fileLabel.addEventListener('drop', (e) => {
    e.preventDefault();
    fileLabel.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (file) readSkillFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) readSkillFile(file);
    fileInput.value = '';
  });

  function readSkillFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => prefillNewSkillForm(parseSkillMarkdown(String(e.target.result)));
    reader.onerror = () => toast('Could not read file', 'error');
    reader.readAsText(file);
  }

  // URL import
  const urlInput = $('#skill-url-input');
  const fetchBtn = $('#btn-fetch-skill');

  async function fetchSkillUrl() {
    const url = urlInput.value.trim();
    if (!url) {
      toast('Enter a URL first', 'error');
      return;
    }
    fetchBtn.textContent = 'Fetching\u2026';
    fetchBtn.disabled = true;
    try {
      const ok = confirm(
        'Import skills only from sources you trust. A skill can change the instructions sent to your LLM for future prompts. Fetch this URL?',
      );
      if (!ok) return;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      prefillNewSkillForm(parseSkillMarkdown(await res.text()));
      urlInput.value = '';
    } catch (err) {
      toast(`Could not fetch: ${err.message}`, 'error');
    } finally {
      fetchBtn.textContent = 'Fetch';
      fetchBtn.disabled = false;
    }
  }

  fetchBtn.addEventListener('click', fetchSkillUrl);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchSkillUrl();
  });
}

// Controls first: the form wiring below listens on the elements they create.
enhanceSliders();
wireHotkeyCapture();
wireTabs();
wireSystemPrompt();
wireSkills();
wireProvider();
wireWhisper();
wireHotkeys();
wireVoice();
wirePaths();
wireSaveBar();
wireOverlayControls();
wireImportSkill();

// Cross-tab navigation links inside panes
document.getElementById('goto-provider')?.addEventListener('click', () => setTab('provider'));

refresh();
setInterval(() => {
  // Don't overwrite fields while the user is actively typing in any input/textarea/select.
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
  refresh().catch(() => {});
}, 4000);
