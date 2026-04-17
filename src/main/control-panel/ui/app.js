const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  config: null,
  skills: [],
  composedSystemPrompt: '',
  providers: [],
  selectedSkillId: null,
  dirtySkill: false,
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

  $('#cfg-provider').value = c.provider;
  $('#cfg-baseUrl').value = c.baseUrl;
  $('#cfg-model').value = c.model;
  $('#cfg-apiKey').placeholder = c.apiKeySet
    ? '•••••••• (stored, leave blank to keep)'
    : '(not set)';
  $('#cfg-apiKey').value = '';
  $('#cfg-temperature').value = c.temperature;
  $('#cfg-whisperCliPath').value = c.whisperCliPath;
  $('#cfg-whisperModelPath').value = c.whisperModelPath;
  $('#cfg-sampleRate').value = c.sampleRate;
  $('#cfg-hotkeyCombo').value = c.hotkeyCombo;
  $('#cfg-toggleHotkeyCombo').value = c.toggleHotkeyCombo;
  $('#cfg-clipboardRestoreDelayMs').value = c.clipboardRestoreDelayMs;
  $('#cfg-logsDir').value = c.logsDir;
  $('#cfg-skillsDir').value = c.skillsDir;
  $('#cfg-controlPanelPort').value = c.controlPanelPort;
  $('#cfg-configFilePath').value = c.configFilePath;

  $('#system-prompt').value = c.systemPrompt;
  updatePromptCharCount();
  $('#composed-prompt').textContent = state.composedSystemPrompt;

  renderSkillList();
  if (state.selectedSkillId) {
    const found = state.skills.find((s) => s.id === state.selectedSkillId);
    if (found) selectSkill(found.id, true);
    else showSkillForm(null);
  }
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
    state.skills = snap.skills;
    state.composedSystemPrompt = snap.composedSystemPrompt;
    state.providers = snap.providers;
    state.overlay = snap.overlay ?? { visible: null };
    applyStateToDom();
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
  $('#system-prompt').addEventListener('input', updatePromptCharCount);
  $('#btn-save-prompt').addEventListener('click', async () => {
    try {
      setSaveStatus('Saving…');
      await api('PUT', '/api/system-prompt', { prompt: $('#system-prompt').value });
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
        state.selectedSkillId = payload.id || slugify(payload.name);
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
  state.skills = snap.skills;
  state.composedSystemPrompt = snap.composedSystemPrompt;
  state.providers = snap.providers ?? state.providers;
  applyStateToDom();
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
      applySnapshot(snap);
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
      }
    });
  }
}

function wireGenericForm(selector, extract) {
  $(selector).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const snap = await api('PUT', '/api/config', extract());
      applySnapshot(snap);
      toast('Saved', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function wireWhisper() {
  wireGenericForm('#whisper-form', () => ({
    whisperCliPath: $('#cfg-whisperCliPath').value.trim(),
    whisperModelPath: $('#cfg-whisperModelPath').value.trim(),
    sampleRate: Number($('#cfg-sampleRate').value),
  }));
}

function wireHotkeys() {
  wireGenericForm('#hotkeys-form', () => ({
    hotkeyCombo: $('#cfg-hotkeyCombo').value.trim(),
    toggleHotkeyCombo: $('#cfg-toggleHotkeyCombo').value.trim(),
    clipboardRestoreDelayMs: Number($('#cfg-clipboardRestoreDelayMs').value),
  }));
}

function wirePaths() {
  wireGenericForm('#paths-form', () => ({
    logsDir: $('#cfg-logsDir').value.trim(),
    skillsDir: $('#cfg-skillsDir').value.trim(),
    controlPanelPort: Number($('#cfg-controlPanelPort').value),
  }));
}

function wireSaveAll() {
  $('#btn-save-all').addEventListener('click', async () => {
    try {
      setSaveStatus('Saving…');
      await api('PUT', '/api/system-prompt', { prompt: $('#system-prompt').value });
      await api('PUT', '/api/config', readConfigForm());
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

wireTabs();
wireSystemPrompt();
wireSkills();
wireProvider();
wireWhisper();
wireHotkeys();
wirePaths();
wireSaveAll();
wireOverlayControls();
refresh();
setInterval(() => {
  refresh().catch(() => {});
}, 4000);
