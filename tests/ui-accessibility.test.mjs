import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { parseCombo } from '../dist/main/hotkey.js';

// Static checks on the compiled UI assets (no browser needed): colour contrast of
// the design tokens in both themes, minimum text size, visible keyboard focus,
// reduced motion, the save model, and the pure logic behind the provider's
// Local / Cloud badge and the hotkey recorder.

const panelDir = new URL('../dist/main/control-panel/ui/', import.meta.url);
const panelCss = readFileSync(new URL('style.css', panelDir), 'utf8');
const panelHtml = readFileSync(new URL('index.html', panelDir), 'utf8');
const panelJs = readFileSync(new URL('app.js', panelDir), 'utf8');
const overlayHtml = readFileSync(new URL('../dist/renderer/index.html', import.meta.url), 'utf8');
const overlayJs = readFileSync(new URL('../dist/renderer/index.js', import.meta.url), 'utf8');
const logoJs = readFileSync(new URL('../dist/renderer/logo.js', import.meta.url), 'utf8');
const overlayCss = /<style>([\s\S]*?)<\/style>/.exec(overlayHtml)?.[1] ?? '';

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Plain `selector { declarations }` rules in source order, including those inside @media. */
function rules(css) {
  const out = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selector.startsWith('@')) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

function declarations(block) {
  const raw = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) raw[m[1]] = m[2].trim();
  return raw;
}

/**
 * Custom properties of the first `:root` block (the light theme), with `var(--x)` aliases
 * resolved. `dark` layers the `prefers-color-scheme: dark` overrides on top.
 */
function tokens(css, { dark = false } = {}) {
  const clean = stripComments(css);
  const raw = declarations(/:root\s*\{([^}]*)\}/.exec(clean)?.[1] ?? '');
  if (dark) {
    const block = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(
      clean,
    );
    assert.ok(block, 'has a prefers-color-scheme: dark block');
    Object.assign(raw, declarations(block[1]));
  }
  const resolve = (name, depth = 0) => {
    const value = raw[name];
    const alias = value && /^var\((--[\w-]+)\)$/.exec(value);
    return alias && depth < 8 ? resolve(alias[1], depth + 1) : value;
  };
  return (name) => {
    const value = resolve(name);
    assert.ok(value, `token ${name} is defined`);
    return value;
  };
}

function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `${hex} is a 6-digit hex colour`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function assertContrast(t, fg, bgs, min) {
  for (const bg of bgs) {
    const ratio = contrast(t(fg), t(bg));
    assert.ok(
      ratio >= min,
      `${fg} (${t(fg)}) on ${bg} (${t(bg)}) is ${ratio.toFixed(2)}:1, needs ${min}:1`,
    );
  }
}

describe('control panel design tokens', () => {
  const surfaces = ['--bg', '--surface-1', '--surface-2'];

  for (const [theme, opts] of [
    ['light', {}],
    ['dark', { dark: true }],
  ]) {
    describe(theme, () => {
      const t = tokens(panelCss, opts);

      it('body and muted text reach 4.5:1 on every surface', () => {
        assertContrast(t, '--text', surfaces, 4.5);
        assertContrast(t, '--text-dim', surfaces, 4.5);
        assertContrast(t, '--text-faint', surfaces, 4.5);
      });

      it('links and status colours reach 4.5:1 as text', () => {
        for (const c of ['--link', '--good', '--bad', '--caution'])
          assertContrast(t, c, surfaces, 4.5);
      });

      it('highlighter fills keep readable ink in every state and stand out from the page', () => {
        for (const fill of ['--hl', '--hl-hover', '--hl-pressed'])
          assertContrast(t, '--on-hl', [fill], 4.5);
        // A fill is outlined in --text: either the fill or that outline must separate it
        // from each surface (the yellow does it on dark, the ink outline on light).
        for (const surface of surfaces) {
          const edge = Math.max(contrast(t('--hl'), t(surface)), contrast(t('--text'), t(surface)));
          assert.ok(
            edge >= 3,
            `a highlighter fill on ${surface} has no 3:1 edge (${edge.toFixed(2)})`,
          );
        }
      });

      it('field borders and the focus ring reach 3:1 against what they sit on', () => {
        assertContrast(t, '--control-border', surfaces, 3);
        assertContrast(t, '--focus', surfaces, 3);
      });
    });
  }
});

describe('overlay design tokens', () => {
  const t = tokens(overlayCss);

  it('toast text reaches 4.5:1 and its accents 3:1 on the toast surface', () => {
    assertContrast(t, '--toast-text', ['--toast-bg'], 4.5);
    assertContrast(t, '--toast-muted', ['--toast-bg'], 4.5);
    assertContrast(t, '--notice', ['--toast-bg'], 4.5);
    assertContrast(t, '--error', ['--toast-bg'], 4.5);
    assertContrast(t, '--focus', ['--toast-bg'], 3);
    assertContrast(t, '--control-border', ['--toast-bg'], 3);
    for (const fill of ['--hl', '--hl-hover', '--hl-pressed'])
      assertContrast(t, '--on-hl', [fill], 4.5);
  });
});

describe('palette', () => {
  /** Purple and violet were rejected for the UI chrome; keep them out of every literal colour. */
  const isPurple = ([r, g, b]) => {
    const [R, G, B] = [r, g, b].map((c) => c / 255);
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    if (max === min) return false;
    const sat = (max - min) / (1 - Math.abs(max + min - 1));
    const d = max - min;
    const hue =
      60 * (max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4);
    return sat > 0.2 && hue >= 255 && hue <= 330;
  };

  const purpleLiterals = (name, text) => {
    const found = [];
    for (const m of text.matchAll(/#([0-9a-f]{6})\b/gi))
      if (isPurple(rgb(`#${m[1]}`))) found.push(`${name}: #${m[1]}`);
    for (const m of text.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g))
      if (isPurple([m[1], m[2], m[3]].map(Number)))
        found.push(`${name}: rgb(${m[1]},${m[2]},${m[3]})`);
    return found;
  };

  const repoFile = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

  it('uses no purple or violet hue in the control panel, overlay or in-app logo', () => {
    const offenders = [
      ...purpleLiterals('control panel css', stripComments(panelCss)),
      ...purpleLiterals('control panel html', panelHtml),
      ...purpleLiterals('overlay', overlayHtml),
      ...purpleLiterals('logo', logoJs),
    ];
    assert.deepEqual(offenders, []);
  });

  it('uses no purple or violet hue in the README assets, tray icon or terminal banner', () => {
    const offenders = [];
    for (const rel of [
      'logo.svg',
      'docs/banner-light.svg',
      'docs/banner-dark.svg',
      'docs/architecture-light.svg',
      'docs/architecture-dark.svg',
    ])
      offenders.push(...purpleLiterals(rel, repoFile(rel)));

    const tray = repoFile('dist/main/tray.js');
    for (const m of tray.matchAll(/makeTrayIcon\((\d+),\s*(\d+),\s*(\d+)/g))
      if (isPurple([m[1], m[2], m[3]].map(Number)))
        offenders.push(`tray: rgb(${m[1]},${m[2]},${m[3]})`);

    // picocolors names with a violet cast; the terminal banner draws in yellow.
    if (/pc\.(magenta|bgMagenta|blue|bgBlue)\b/.test(repoFile('dist/main/cli/banner.js')))
      offenders.push('terminal banner uses a magenta or blue colour');
    assert.deepEqual(offenders, []);
  });

  it('ships every README asset in the package', () => {
    const files = JSON.parse(repoFile('package.json')).files;
    for (const rel of [
      'logo.svg',
      'docs/banner-light.svg',
      'docs/banner-dark.svg',
      'docs/architecture-light.svg',
      'docs/architecture-dark.svg',
    ])
      assert.ok(files.includes(rel), `package.json files lists ${rel}`);
    const readme = repoFile('README.md');
    for (const m of readme.matchAll(/(?:src|srcset)="(docs\/[^"]+\.svg)"/g))
      assert.ok(files.includes(m[1]), `README asset ${m[1]} is packaged`);
  });
});

const stylesheets = [
  ['control panel', panelCss],
  ['overlay', overlayCss],
];

/** Anything the user clicks, types into or toggles. */
const ACTIONABLE =
  /(^|[\s,>.#:-])(button|input|select|textarea|summary|tab|btn|preset|link-btn|import-tab|nav-item)\b/;

describe('text size', () => {
  for (const [name, css] of stylesheets) {
    it(`${name}: no text under 11px, and no actionable text under 12px`, () => {
      const tooSmall = [];
      for (const { selector, body } of rules(css)) {
        const px = /font-size\s*:\s*([\d.]+)px/.exec(body);
        if (!px) continue;
        const size = Number(px[1]);
        const actionable = selector.split(',').some((s) => ACTIONABLE.test(s.trim()));
        if (size < 11 || (actionable && size < 12)) tooSmall.push(`${selector} { ${size}px }`);
      }
      assert.deepEqual(tooSmall, []);
    });
  }
});

describe('text size set by the browser', () => {
  it('control panel: <small> hints declare a size, since the default is smaller than its parent', () => {
    const declared = rules(panelCss).filter((r) => /(^|[\s,>])small\b/.test(r.selector));
    assert.ok(declared.length > 0, 'a rule sizes <small>');
    for (const { selector, body } of declared) {
      const px = /font-size\s*:\s*([\d.]+)px/.exec(body);
      assert.ok(px && Number(px[1]) >= 11, `${selector} needs a font-size of at least 11px`);
    }
  });
});

describe('keyboard focus', () => {
  for (const [name, css, tags] of [
    ['control panel', panelCss, ['button', 'input', 'select', 'textarea', 'summary', 'a']],
    ['overlay', overlayCss, ['button']],
  ]) {
    it(`${name}: every interactive element type has a visible :focus-visible style`, () => {
      const focusRules = rules(css).filter((r) => r.selector.includes(':focus-visible'));
      for (const tag of tags) {
        const covered = focusRules.some(
          (r) =>
            /(outline\s*:\s*(?!none|0)|box-shadow\s*:)/.test(r.body) &&
            r.selector
              .split(',')
              .map((s) => s.trim())
              .some(
                (s) =>
                  s === ':focus-visible' || new RegExp(`(^|[\\s>])${tag}:focus-visible`).test(s),
              ),
        );
        assert.ok(covered, `no :focus-visible ring for <${tag}>`);
      }
    });
  }

  it('control panel: skill list rows are focusable and operable from the keyboard', () => {
    assert.match(panelJs, /li\.tabIndex = 0/);
    assert.match(panelJs, /e\.key !== 'Enter' && e\.key !== ' '/);
  });
});

describe('reduced motion', () => {
  for (const [name, css] of stylesheets) {
    it(`${name}: animations and transitions are switched off for prefers-reduced-motion`, () => {
      const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\}\s*)\}/.exec(
        stripComments(css),
      );
      assert.ok(block, 'has a prefers-reduced-motion block');
      assert.match(block[1], /animation(-duration)?\s*:/);
      assert.match(block[1], /transition(-duration)?\s*:/);
    });
  }
});

describe('control panel layout', () => {
  it('groups its sections in a labelled navigation landmark', () => {
    assert.match(panelHtml, /<nav[^>]*aria-label="[^"]+"/);
    const labels = [...panelHtml.matchAll(/class="nav-group-label"[^>]*>([^<]+)</g)].map((m) =>
      m[1].trim(),
    );
    assert.deepEqual(labels, ['Prompt', 'Models', 'Capture', 'System', 'Help']);
  });

  it('keeps one navigation button per pane', () => {
    const tabs = [...panelHtml.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]).sort();
    const panes = [...panelHtml.matchAll(/data-pane="([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(tabs, panes);
    assert.equal(tabs.length, 8);
  });

  it('wraps the navigation and stacks the layout on narrow windows instead of scrolling sideways', () => {
    const all = rules(panelCss);
    const nav = all.filter((r) => r.selector === '.nav');
    assert.ok(
      nav.some((r) => /flex-wrap\s*:\s*wrap/.test(r.body)),
      '.nav wraps when narrow',
    );
    assert.doesNotMatch(nav.map((r) => r.body).join(';'), /overflow-x\s*:\s*(auto|scroll)/);
    const app = all.filter((r) => r.selector === '.app').map((r) => r.body);
    assert.ok(
      app.some((b) => /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/.test(b)),
      '.app becomes one column when narrow',
    );
    const row = all.filter((r) => r.selector === '.row').map((r) => r.body);
    assert.ok(
      row.some((b) => /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/.test(b)),
      'settings rows stack when narrow',
    );
  });

  it('lays settings out as label-and-help beside the control', () => {
    assert.match(panelHtml, /class="row-label"/);
    assert.match(panelHtml, /class="row-control field"/);
    assert.ok((panelHtml.match(/class="row(?: row-wide)?"/g) ?? []).length >= 25);
  });
});

describe('control panel save model', () => {
  it('has one save bar instead of a Save button per tab', () => {
    assert.match(panelHtml, /id="savebar"[^>]*\shidden/);
    assert.match(panelHtml, /id="btn-save"/);
    assert.match(panelHtml, /id="btn-discard"/);
    assert.doesNotMatch(
      panelHtml,
      /id="btn-save-(prompt|provider|whisper|hotkeys|voice|paths|all)"/,
      'the per-section Save buttons are gone',
    );
  });

  it('saves every section that can be edited, and keeps validation feedback', () => {
    for (const key of ['provider', 'whisper', 'hotkeys', 'voice', 'paths', 'system-prompt'])
      assert.match(panelJs, new RegExp(`['"]?${key}['"]?\\s*:\\s*\\{`), `SECTIONS.${key}`);
    assert.match(panelJs, /showFieldErrors\(err\.rejected\)/);
    // A refused save must leave the section dirty: nothing is cleared before the PUT resolves.
    const save = /async function saveChanges\(\)[\s\S]*?\n\}\n/.exec(panelJs)?.[0] ?? '';
    assert.ok(save.indexOf("api('PUT', '/api/config'") < save.indexOf('dirtyForms.delete(key)'));
  });

  it('warns before leaving with unsaved edits and saves on Ctrl+S', () => {
    assert.match(panelJs, /beforeunload/);
    assert.match(panelJs, /e\.key\.toLowerCase\(\) === 's'/);
  });
});

describe('control panel controls', () => {
  it('uses a switch for every on/off setting', () => {
    const checkboxes = [...panelHtml.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map(
      (m) => m[0],
    );
    assert.ok(checkboxes.length >= 5);
    for (const c of checkboxes) {
      assert.match(c, /class="switch-input"/, c);
      // A native checkbox keeps its checked state for assistive tech, so it needs a name.
      assert.match(c, /aria-labelledby="[^"]+"|id="skill-enabled"/, c);
    }
  });

  it('gives every slider a range and a unit where it has one', () => {
    const sliders = [...panelHtml.matchAll(/<input[^>]*data-slider[^>]*>/g)].map((m) => m[0]);
    assert.equal(sliders.length, 6);
    for (const s of sliders) assert.match(s, /min="-?[\d.]+"[^>]*max="-?[\d.]+"/, s);
  });
});

/** Runs a slice of app.js in an empty context (plus `URL`) and returns that context. */
function run(fromMarker, toMarker) {
  const start = panelJs.indexOf(fromMarker);
  const end = panelJs.indexOf(toMarker);
  assert.ok(start !== -1 && end > start, `app.js has ${fromMarker} before ${toMarker}`);
  const ctx = vm.createContext({ URL });
  vm.runInContext(panelJs.slice(start, end), ctx);
  return ctx;
}

describe('provider Local / Cloud badge', () => {
  const ctx = run('function isDomainUrl', 'function updateBaseUrlHint');
  assert.equal(typeof ctx.providerLocality, 'function', 'app.js defines providerLocality');
  const locality = ctx.providerLocality;

  it('calls loopback endpoints local', () => {
    for (const url of ['http://localhost:11434', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080'])
      assert.equal(locality(url), 'local', url);
  });

  it('calls named hosts cloud, matching the external-domain warning', () => {
    for (const url of [
      'https://api.openai.com/v1',
      'https://api.anthropic.com',
      'https://openrouter.ai/api/v1',
    ])
      assert.equal(locality(url), 'cloud', url);
  });

  it('does not claim a private-network address is local or cloud', () => {
    for (const url of ['http://192.168.1.20:11434', 'http://10.0.0.5:8080/v1'])
      assert.equal(locality(url), 'network', url);
  });

  it('shows nothing for an empty or unparsable URL', () => {
    for (const url of ['', '   ', 'not a url', undefined]) assert.equal(locality(url), 'unknown');
  });

  it('puts the badge next to the provider heading', () => {
    assert.match(panelHtml, /id="provider-locality"/);
  });
});

describe('hotkey recorder', () => {
  const ctx = run('const CAPTURABLE_CODES', 'function wireHotkeyCapture');
  const press = (code, mods = {}) =>
    ctx.describeKeyCapture({
      code,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ...mods,
    });

  it('waits while only modifiers are held', () => {
    assert.deepEqual({ ...press('ControlLeft', { ctrlKey: true }) }, { done: false });
    assert.deepEqual({ ...press('ShiftRight', { shiftKey: true }) }, { done: false });
  });

  it('writes combos in the syntax the hotkey parser reads', () => {
    const cases = [
      [['Space', { ctrlKey: true, shiftKey: true }], 'Ctrl+Shift+Space'],
      [['KeyK', { altKey: true }], 'Alt+K'],
      [['Digit5', { metaKey: true }], 'Meta+5'],
      [['Backquote', { altKey: true }], 'Alt+Backquote'],
      [['Numpad1', { ctrlKey: true }], 'Ctrl+Numpad1'],
      [['F9', {}], 'F9'],
      [['KeyH', { ctrlKey: true, shiftKey: true }], 'Ctrl+Shift+H'],
    ];
    for (const [[code, mods], combo] of cases) {
      const r = press(code, mods);
      assert.equal(r.done, true, code);
      assert.equal(r.combo, combo);
    }
  });

  it('refuses a bare letter, which would fire while typing, and says how to fix it', () => {
    const r = press('KeyA');
    assert.equal(r.done, false);
    assert.match(r.error, /Ctrl, Alt, Shift or Meta/);
  });

  it('refuses keys the hotkey library has no name for', () => {
    const r = press('ContextMenu', { ctrlKey: true });
    assert.equal(r.done, false);
    assert.match(r.error, /cannot be used/);
  });

  it('only produces names the hotkey parser accepts', () => {
    const lib = readFileSync(
      new URL('../node_modules/uiohook-napi/dist/index.js', import.meta.url),
      'utf8',
    );
    const names = [...lib.matchAll(/^\s*(\w+):\s*0x/gm)].map((m) => m[1]);
    assert.ok(names.length > 100, 'read the key names from the installed library');
    const keys = Object.fromEntries(names.map((n, i) => [n, i + 1]));
    const codes = [
      ...vm.runInContext('Array.from(CAPTURABLE_CODES)', ctx),
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
      ...'0123456789'.split('').map((c) => `Digit${c}`),
    ];
    for (const code of codes) {
      const r = press(code, { ctrlKey: true });
      assert.equal(r.done, true, code);
      assert.ok(parseCombo(r.combo, keys), `${r.combo} is not parsed by parseCombo`);
    }
  });
});

describe('overlay toast', () => {
  it('has an icon that is hidden from assistive tech', () => {
    assert.match(overlayHtml, /id="toast-icon"[^>]*aria-hidden="true"/);
  });

  it('announces errors assertively and notices politely', () => {
    assert.match(
      overlayJs,
      /setAttribute\('role',\s*payload\.notice === true \? 'status' : 'alert'\)/,
    );
  });

  it('marks at most one action as the primary one, and never on a notice', () => {
    assert.match(overlayHtml, /\.error-actions button\.primary/);
    assert.match(overlayJs, /retryBtn\.classList\.toggle\('primary'/);
    assert.doesNotMatch(overlayJs, /insertRawBtn\.classList\.toggle\('primary'/);
  });

  it('can be dismissed from the keyboard', () => {
    assert.match(overlayJs, /key === 'Escape'/);
  });

  it('keeps every action a labelled <button>', () => {
    const toast = /<div id="error-toast"[\s\S]*?<\/div>\s*<\/div>/.exec(overlayHtml)?.[0] ?? '';
    const buttons = [...toast.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
    assert.equal(buttons.length, 4);
    for (const b of buttons) {
      const text = b
        .replace(/<[^>]+>/g, '')
        .replace(/&#x2715;/, '')
        .trim();
      assert.ok(text || /aria-label="[^"]+"/.test(b), `unlabelled button: ${b}`);
    }
  });
});
