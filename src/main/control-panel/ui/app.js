const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Tracks which form sections have unsaved user edits so auto-refresh never
// overwrites in-progress work.  Cleared on a successful save of that section.
const dirtyForms = new Set();

const state = {
  config: null,
  overrides: {},
  skills: [],
  composedSystemPrompt: '',
  providers: [],
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
  sampleRate: { inputId: 'cfg-sampleRate', flag: '--sample-rate', env: 'WHISPER_SAMPLE_RATE' },
  hotkeyCombo: { inputId: 'cfg-hotkeyCombo', flag: '--hotkey', env: 'MURMUR_HOTKEY' },
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
  systemPrompt: { inputId: 'system-prompt', flag: '--system-prompt', env: 'MURMUR_SYSTEM_PROMPT' },
  controlPanelPort: {
    inputId: 'cfg-controlPanelPort',
    flag: '--control-panel-port',
    env: 'MURMUR_CONTROL_PANEL_PORT',
  },
  logsDir: { inputId: 'cfg-logsDir', flag: '--logs-dir', env: 'MURMUR_LOGS_DIR' },
  skillsDir: { inputId: 'cfg-skillsDir', flag: '--skills-dir', env: 'MURMUR_SKILLS_DIR' },
};

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind ? `toast-${kind}` : ''}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 2400);
}

function setSaveStatus(text, kind = '') {
  const el = $('#save-status');
  el.textContent = text;
  el.style.color = kind === 'error' ? 'var(--bad)' : kind === 'ok' ? 'var(--good)' : '';
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
  }

  if (!dirtyForms.has('system-prompt')) {
    $('#system-prompt').value = c.systemPrompt;
    updatePromptCharCount();
  }
  $('#composed-prompt').textContent = state.composedSystemPrompt;

  if (!dirtyForms.has('whisper')) {
    $('#cfg-whisperCliPath').value = c.whisperCliPath;
    $('#cfg-whisperModelPath').value = c.whisperModelPath;
    $('#cfg-sampleRate').value = c.sampleRate;
  }

  if (!dirtyForms.has('hotkeys')) {
    $('#cfg-hotkeyCombo').value = c.hotkeyCombo;
    $('#cfg-toggleHotkeyCombo').value = c.toggleHotkeyCombo;
    $('#cfg-clipboardRestoreDelayMs').value = c.clipboardRestoreDelayMs;
  }

  if (!dirtyForms.has('paths')) {
    $('#cfg-logsDir').value = c.logsDir;
    $('#cfg-skillsDir').value = c.skillsDir;
    $('#cfg-controlPanelPort').value = c.controlPanelPort;
    $('#cfg-configFilePath').value = c.configFilePath;
  }

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

function setFieldLocked(input, info, source) {
  const wrapper = input.closest('.field') ?? input.parentElement;
  const existing = wrapper?.querySelector('.override-chip');

  if (!source) {
    input.readOnly = false;
    input.disabled = false;
    input.classList.remove('locked');
    existing?.remove();
    return;
  }

  // SELECTs don't honour readOnly, so we disable them instead.
  if (input.tagName === 'SELECT') input.disabled = true;
  else input.readOnly = true;
  input.classList.add('locked');

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

function renderSkillList() {
  const list = $('#skill-list');
  list.innerHTML = '';
  const count = $('#skill-count');
  const enabled = new Set(state.config?.enabledSkills ?? []);
  count.textContent = `${state.skills.length} total · ${
    state.skills.filter((s) => enabled.has(s.id)).length
  } active`;
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
    li.addEventListener('click', () => selectSkill(s.id));
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
    state.skills = snap.skills;
    state.composedSystemPrompt = snap.composedSystemPrompt;
    state.providers = snap.providers;
    state.overlay = snap.overlay ?? { visible: null };
    applyStateToDom();
    applyOverridesToDom();
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
  for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.tab === name);
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
  $('#btn-save-prompt').addEventListener('click', async () => {
    try {
      setSaveStatus('Saving…');
      await api('PUT', '/api/system-prompt', { prompt: $('#system-prompt').value });
      dirtyForms.delete('system-prompt');
      setSaveStatus('Saved', 'ok');
      toast('System prompt saved', 'success');
      await refresh();
    } catch (err) {
      setSaveStatus('Error', 'error');
      toast(err.message, 'error');
    }
  });
  $('#btn-reset-prompt').addEventListener('click', async () => {
    if (!confirm('Reset system prompt to the built-in default?')) return;
    try {
      await api('PUT', '/api/system-prompt', { prompt: DEFAULT_PROMPT });
      dirtyForms.delete('system-prompt');
      toast('Reset to default', 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
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
        const snap = await api('POST', '/api/skills', payload);
        applySnapshot(snap);
        // Use the id the server assigned (may differ from the client-guessed slug).
        const created = snap.skills.find((s) => s.name === payload.name);
        state.selectedSkillId = created?.id ?? slugify(payload.name);
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
  state.skills = snap.skills;
  state.composedSystemPrompt = snap.composedSystemPrompt;
  state.providers = snap.providers ?? state.providers;
  applyStateToDom();
  applyOverridesToDom();
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function readConfigForm(extra = {}) {
  const payload = {
    provider: $('#cfg-provider').value,
    baseUrl: $('#cfg-baseUrl').value.trim(),
    model: $('#cfg-model').value.trim(),
    temperature: Number($('#cfg-temperature').value),
    whisperCliPath: $('#cfg-whisperCliPath').value.trim(),
    whisperModelPath: $('#cfg-whisperModelPath').value.trim(),
    sampleRate: Number($('#cfg-sampleRate').value),
    hotkeyCombo: $('#cfg-hotkeyCombo').value.trim(),
    toggleHotkeyCombo: $('#cfg-toggleHotkeyCombo').value.trim(),
    clipboardRestoreDelayMs: Number($('#cfg-clipboardRestoreDelayMs').value),
    logsDir: $('#cfg-logsDir').value.trim(),
    skillsDir: $('#cfg-skillsDir').value.trim(),
    controlPanelPort: Number($('#cfg-controlPanelPort').value),
    ...extra,
  };
  const apiKey = $('#cfg-apiKey').value;
  if (apiKey) payload.apiKey = apiKey;
  return payload;
}

function wireProvider() {
  // Mark provider form dirty whenever any field is touched.
  for (const id of ['cfg-provider', 'cfg-baseUrl', 'cfg-model', 'cfg-apiKey', 'cfg-temperature']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', () => dirtyForms.add('provider'));
    el.addEventListener('change', () => dirtyForms.add('provider'));
  }

  $('#provider-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const apiKey = $('#cfg-apiKey').value;
    const patch = {
      provider: $('#cfg-provider').value,
      baseUrl: $('#cfg-baseUrl').value.trim(),
      model: $('#cfg-model').value.trim(),
      temperature: Number($('#cfg-temperature').value),
    };
    if (apiKey) patch.apiKey = apiKey;
    else if (apiKey === '' && $('#cfg-apiKey').dataset.clear === '1') patch.apiKey = null;
    try {
      const snap = await api('PUT', '/api/config', patch);
      dirtyForms.delete('provider');
      applySnapshot(snap);
      // Evaluate the online warning only after the user deliberately saves.
      updateOnlineWarning(patch.baseUrl);
      toast('Provider saved', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#btn-test-llm').addEventListener('click', async () => {
    const el = $('#llm-test-result');
    el.textContent = 'Testing…';
    el.style.color = 'var(--text-faint)';
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
    });
  }
  $('#goto-model-guide')?.addEventListener('click', () => setTab('model-guide'));
}

function wireGenericForm(selector, extract, dirtyKey) {
  const form = $(selector);
  if (dirtyKey) {
    for (const el of form.querySelectorAll('input, textarea, select')) {
      el.addEventListener('input', () => dirtyForms.add(dirtyKey));
      el.addEventListener('change', () => dirtyForms.add(dirtyKey));
    }
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const snap = await api('PUT', '/api/config', extract());
      if (dirtyKey) dirtyForms.delete(dirtyKey);
      applySnapshot(snap);
      toast('Saved', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function wireWhisper() {
  wireGenericForm(
    '#whisper-form',
    () => ({
      whisperCliPath: $('#cfg-whisperCliPath').value.trim(),
      whisperModelPath: $('#cfg-whisperModelPath').value.trim(),
      sampleRate: Number($('#cfg-sampleRate').value),
    }),
    'whisper',
  );
}

function wireHotkeys() {
  wireGenericForm(
    '#hotkeys-form',
    () => ({
      hotkeyCombo: $('#cfg-hotkeyCombo').value.trim(),
      toggleHotkeyCombo: $('#cfg-toggleHotkeyCombo').value.trim(),
      clipboardRestoreDelayMs: Number($('#cfg-clipboardRestoreDelayMs').value),
    }),
    'hotkeys',
  );
}

function wirePaths() {
  wireGenericForm(
    '#paths-form',
    () => ({
      logsDir: $('#cfg-logsDir').value.trim(),
      skillsDir: $('#cfg-skillsDir').value.trim(),
      controlPanelPort: Number($('#cfg-controlPanelPort').value),
    }),
    'paths',
  );
}

function wireSaveAll() {
  $('#btn-save-all').addEventListener('click', async () => {
    try {
      setSaveStatus('Saving…');
      await api('PUT', '/api/system-prompt', { prompt: $('#system-prompt').value });
      await api('PUT', '/api/config', readConfigForm());
      dirtyForms.clear();
      setSaveStatus('Saved', 'ok');
      toast('Everything saved', 'success');
      await refresh();
    } catch (err) {
      setSaveStatus('Error', 'error');
      toast(err.message, 'error');
    }
  });
}

const DEFAULT_PROMPT = `You refine a raw voice transcription into a high-quality prompt for an AI coding assistant.

Rules:
- Restructure as: Goal, then Context, then Constraints, then Output format.
- Remove filler words (um, like, you know, basically, actually, kind of, sort of).
- Fix obvious dictation artifacts and homophones using coding context (e.g. "react" not "wreaked", "async" not "a sink").
- Never invent requirements the user did not state. If something is ambiguous, keep it ambiguous.
- Keep the user's voice. Do not make it corporate or verbose.
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

function updateOnlineWarning(baseUrl) {
  const el = $('#online-warning');
  if (!el) return;
  if (baseUrl && isDomainUrl(baseUrl)) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
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

wireTabs();
wireSystemPrompt();
wireSkills();
wireProvider();
wireWhisper();
wireHotkeys();
wirePaths();
wireSaveAll();
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
