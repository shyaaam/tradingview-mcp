/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { createHash } from 'node:crypto';
import { focus as focusPane, indicatorSignatures } from './pane.js';
import { switchTab } from './tab.js';
import { verifyScopedMutationAuthority } from './indicators.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;
const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export function normalizePineScriptName(name) {
  if (typeof name !== 'string') throw new Error('Pine script name must be a string');
  const normalized = name.trim();
  if (!normalized) throw new Error('Pine script name must be non-empty');
  if (normalized.length > 200) throw new Error('Pine script name is too long');
  if (/[\r\n\u0000]/u.test(normalized)) throw new Error('Pine script name contains forbidden characters');
  return normalized;
}

export function pineSourceSha256(source) {
  if (typeof source !== 'string' || source.length === 0) throw new Error('Pine source must be non-empty');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function pineSourcesEquivalent(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return left.replace(/\r\n?/gu, '\n') === right.replace(/\r\n?/gu, '\n');
}

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  return { success: true, lines_set: source.split('\n').length };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const clicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  const templates = {
    indicator: '//@version=6\nindicator("My script")\nplot(close)',
    strategy: '//@version=6\nstrategy("My strategy", overlay=true)\n',
    library: '//@version=6\n// @description TODO: add library description here\nlibrary("MyLibrary")\n',
  };

  const template = templates[type] || templates.indicator;

  // Simply set the source to a new template — this is the most reliable approach
  const escaped = JSON.stringify(template);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco editor not found. Ensure Pine Editor is open.');

  return { success: true, type, action: 'new_script_created', template: typeMap[type] };
}

export async function openScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              var m = ${FIND_MONACO};
              if (m) {
                m.editor.setValue(source);
                return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length};
              }
              return {error: 'Monaco editor not found to inject source', name: match.scriptName || match.scriptTitle};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  return { success: true, name: result.name, script_id: result.id, lines: result.lines, source: 'internal_api', opened: true };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}

async function readSavedScripts() {
  return evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(response) { return response.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return { scripts: [], error: 'Unexpected response from pine-facade' };
        return { scripts: data };
      })
      .catch(function(error) { return { scripts: [], error: error.message }; })
  `);
}

async function readSavedScriptSource(script) {
  return evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/get/'
      + ${JSON.stringify(script.scriptIdPart)} + '/' + ${JSON.stringify(script.version || 1)},
      { credentials: 'include' })
      .then(function(response) { return response.json(); })
      .then(function(data) { return { source: data.source || '' }; })
      .catch(function(error) { return { source: '', error: error.message }; })
  `);
}

async function ensureSavedPineScriptNamed({ name, source }) {
  const normalizedName = normalizePineScriptName(name);
  const sourceHash = pineSourceSha256(source);
  const listed = await readSavedScripts();
  if (listed?.error) throw new Error(`PINE_NAMED_UPSERT_LIST_FAILED: ${listed.error}`);
  const matches = exactSavedScriptMatches(listed.scripts, normalizedName);
  if (matches.length > 1) {
    throw new Error(`PINE_NAMED_UPSERT_AMBIGUOUS: ${normalizedName}`);
  }

  let action;
  if (matches.length === 1) {
    const existing = matches[0];
    const loaded = await readSavedScriptSource(existing);
    if (loaded?.error) throw new Error(`PINE_NAMED_UPSERT_READ_FAILED: ${loaded.error}`);
    if (!pineSourcesEquivalent(loaded.source, source)) {
      await saveExistingPineScriptNamed({
        name: normalizedName,
        scriptIdPart: existing.scriptIdPart,
        source,
      });
      action = 'updated';
    } else {
      action = 'unchanged';
    }
  } else {
    await saveNewPineScriptNamed({ name: normalizedName, source });
    action = 'created';
  }

  const after = await readSavedScripts();
  if (after?.error) throw new Error(`PINE_NAMED_UPSERT_READBACK_FAILED: ${after.error}`);
  const exact = exactSavedScriptMatches(after.scripts, normalizedName);
  if (exact.length !== 1) {
    throw new Error(`PINE_NAMED_UPSERT_READBACK_FAILED: expected one exact saved script, found ${exact.length}`);
  }
  const saved = await readSavedScriptSource(exact[0]);
  if (!pineSourcesEquivalent(saved?.source, source)) {
    throw new Error(`PINE_NAMED_UPSERT_SOURCE_MISMATCH: ${normalizedName}`);
  }
  return { action, exact: exact[0], sourceHash, normalizedName };
}

function exactSavedScriptMatches(scripts, name) {
  const normalized = name.toLocaleLowerCase('en-US');
  const byId = new Map();
  for (const script of scripts || []) {
    if (!script || typeof script !== 'object') continue;
    const scriptName = String(script.scriptName || '').trim();
    const scriptTitle = String(script.scriptTitle || '').trim();
    if (scriptName.toLocaleLowerCase('en-US') !== normalized
      && scriptTitle.toLocaleLowerCase('en-US') !== normalized) continue;
    const id = String(script.scriptIdPart || `${scriptName}\u0000${scriptTitle}`);
    byId.set(id, script);
  }
  return [...byId.values()];
}

async function saveNewPineScriptNamed({ name, source }) {
  const result = await evaluateAsync(`
    (async function() {
      var api = window.TradingViewApi;
      if (!api || typeof api.pineLibApi !== 'function') {
        return { error: 'PINE_NAMED_CREATE_UNAVAILABLE: TradingViewApi.pineLibApi is unavailable' };
      }
      try {
        var pine = await api.pineLibApi();
        if (!pine || typeof pine.saveNew !== 'function') {
          return { error: 'PINE_NAMED_CREATE_UNAVAILABLE: TradingViewApi.pineLibApi.saveNew is unavailable' };
        }
        var saved = await pine.saveNew({
          scriptSource: ${JSON.stringify(source)},
          scriptName: ${JSON.stringify(name)},
        });
        if (typeof saved === 'string') return { error: 'PINE_NAMED_CREATE_FAILED: ' + saved };
        var compileErrors = saved && saved.compileErrors && saved.compileErrors.errors;
        if (saved && saved.success === false) {
          return { error: 'PINE_NAMED_CREATE_COMPILE_FAILED', compile_errors: compileErrors || [] };
        }
        if (Array.isArray(compileErrors) && compileErrors.length > 0) {
          return { error: 'PINE_NAMED_CREATE_COMPILE_FAILED', compile_errors: compileErrors };
        }
        return { success: true, saved: saved || null };
      } catch (error) {
        return { error: 'PINE_NAMED_CREATE_FAILED: ' + (error && error.message ? error.message : String(error)) };
      }
    })()
  `);
  if (result?.error) {
    const details = result.compile_errors ? `: ${JSON.stringify(result.compile_errors)}` : '';
    throw new Error(`${result.error}${details}`);
  }
  if (result?.success !== true) throw new Error('PINE_NAMED_CREATE_FAILED: saveNew returned no success result');
  return result.saved;
}

async function saveExistingPineScriptNamed({ name, scriptIdPart, source }) {
  const result = await evaluateAsync(`
    (async function() {
      var api = window.TradingViewApi;
      if (!api || typeof api.pineLibApi !== 'function') {
        return { error: 'PINE_NAMED_UPDATE_UNAVAILABLE: TradingViewApi.pineLibApi is unavailable' };
      }
      try {
        var pine = await api.pineLibApi();
        if (!pine || typeof pine.saveNext !== 'function') {
          return { error: 'PINE_NAMED_UPDATE_UNAVAILABLE: TradingViewApi.pineLibApi.saveNext is unavailable' };
        }
        var saved = await pine.saveNext({
          scriptIdPart: ${JSON.stringify(scriptIdPart)},
          scriptSource: ${JSON.stringify(source)},
          isLegacyScript: false,
          scriptName: ${JSON.stringify(name)},
        });
        if (typeof saved === 'string') return { error: 'PINE_NAMED_UPDATE_FAILED: ' + saved };
        var compileErrors = saved && saved.compileErrors && saved.compileErrors.errors;
        if (saved && saved.success === false) {
          return { error: 'PINE_NAMED_UPDATE_COMPILE_FAILED', compile_errors: compileErrors || [] };
        }
        if (Array.isArray(compileErrors) && compileErrors.length > 0) {
          return { error: 'PINE_NAMED_UPDATE_COMPILE_FAILED', compile_errors: compileErrors };
        }
        return { success: true, saved: saved || null };
      } catch (error) {
        return { error: 'PINE_NAMED_UPDATE_FAILED: ' + (error && error.message ? error.message : String(error)) };
      }
    })()
  `);
  if (result?.error) {
    const details = result.compile_errors ? `: ${JSON.stringify(result.compile_errors)}` : '';
    throw new Error(`${result.error}${details}`);
  }
  if (result?.success !== true) throw new Error('PINE_NAMED_UPDATE_FAILED: saveNext returned no success result');
  return result.saved;
}

async function addSavedPineScriptToChart(savedScriptId) {
  const result = await evaluateAsync(`
    (async function() {
      var chart = ${CHART_API};
      if (!chart || typeof chart.createStudy !== 'function') {
        return { error: 'PINE_NAMED_UPSERT_CHART_CREATE_UNAVAILABLE: Pine chart createStudy API is unavailable' };
      }
      try {
        await chart.createStudy({ type: 'pine', pineId: ${JSON.stringify(savedScriptId)}, version: 'last' });
        return { success: true };
      } catch (error) {
        return { error: 'PINE_NAMED_UPSERT_CHART_CREATE_FAILED: ' + (error && error.message ? error.message : String(error)) };
      }
    })()
  `);
  if (result?.error) throw new Error(result.error);
  if (result?.success !== true) throw new Error('PINE_NAMED_UPSERT_CHART_CREATE_FAILED: createStudy returned no success result');
  await new Promise(resolve => setTimeout(resolve, 500));
}

async function readChartStudiesByName(name) {
  return evaluate(`
    (function() {
      var chart = ${CHART_API};
      var chartModel = null;
      try {
        var widget = chart && chart._chartWidget ? chart._chartWidget : null;
        var model = widget && typeof widget.model === 'function' ? widget.model() : null;
        chartModel = model && typeof model.model === 'function' ? model.model() : null;
      } catch (e) {}
      var studies = chartModel && typeof chartModel.dataSources === 'function'
        ? chartModel.dataSources()
        : null;
      if (!Array.isArray(studies)) return { error: 'focused pane study readback unavailable' };
      var matches = [];
      for (var i = 0; i < studies.length; i++) {
        var item = studies[i] || {};
        var meta = typeof item.metaInfo === 'function' ? item.metaInfo() : null;
        var itemName = String(meta && (meta.description || meta.shortDescription || meta.id) || '').trim();
        if (itemName.toLocaleLowerCase() === ${JSON.stringify(name.toLocaleLowerCase('en-US'))}) {
          var entityId = '';
          try {
            if (typeof item.id === 'function') entityId = String(item.id() || '').trim();
            if (!entityId && item._id !== undefined) entityId = String(item._id || '').trim();
          } catch (e) {}
          matches.push({ id: entityId, name: itemName, indicator_id: String(meta && meta.id || '') });
        }
      }
      return matches;
    })()
  `);
}

async function readChartStudiesAfterNamedCreate(name) {
  let chartStudies = await readChartStudiesByName(name);
  for (let attempt = 0; attempt < 4 && Array.isArray(chartStudies) && chartStudies.length === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    chartStudies = await readChartStudiesByName(name);
  }
  return chartStudies;
}

export function chartStudyBindsSavedScript(study, savedScriptId) {
  const indicatorId = String(study?.indicator_id || '');
  const normalizedId = String(savedScriptId || '').replace(/^(?:USER|PRIV|PUB);/u, '');
  return [
    savedScriptId,
    normalizedId,
    `Script$USER;${normalizedId}@tv-scripting`,
    `Script$PUB;${normalizedId}@tv-scripting`,
    `Script$PRIV;${normalizedId}@tv-scripting`,
  ].includes(indicatorId);
}

export function chartStudyIsOwnedPineScript(study) {
  const indicatorId = String(study?.indicator_id || '');
  return /^(?:Script\$)?(?:USER|PRIV);/u.test(indicatorId);
}

export function chartStudyIsPublicPineScript(study) {
  const indicatorId = String(study?.indicator_id || '');
  return /^(?:Script\$)?PUB;/u.test(indicatorId);
}

async function removeChartStudy(entityId) {
  const result = await evaluateAsync(`
    (async function() {
      var chart = ${CHART_API};
      if (!chart || typeof chart.removeEntity !== 'function') {
        return { error: 'PINE_NAMED_UPSERT_CHART_REMOVE_UNAVAILABLE: chart removeEntity API is unavailable' };
      }
      try {
        chart.removeEntity(${JSON.stringify(entityId)});
        return { success: true };
      } catch (error) {
        return { error: 'PINE_NAMED_UPSERT_CHART_REMOVE_FAILED: ' + (error && error.message ? error.message : String(error)) };
      }
    })()
  `);
  if (result?.error) throw new Error(result.error);
  if (result?.success !== true) throw new Error('PINE_NAMED_UPSERT_CHART_REMOVE_FAILED: removeEntity returned no success result');
  await new Promise(resolve => setTimeout(resolve, 500));
}

export async function upsertNamed({ name, source, addToChart = false, paneIndex }) {
  const { action, exact, sourceHash, normalizedName } = await ensureSavedPineScriptNamed({ name, source });

  let chartStudyId = null;
  let chartIndicatorId = null;
  let sourceBound = false;
  if (addToChart) {
    if (paneIndex !== undefined) await focusPane({ index: paneIndex });
    let chartStudies = action === 'created'
      ? await readChartStudiesAfterNamedCreate(normalizedName)
      : await readChartStudiesByName(normalizedName);
    if (chartStudies?.error) {
      throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: ${chartStudies.error}`);
    }
    let boundStudies = chartStudies.filter((study) => chartStudyBindsSavedScript(study, exact[0].scriptIdPart));
    const conflictingSavedStudies = chartStudies.filter((study) => (
      chartStudyIsOwnedPineScript(study) && !chartStudyBindsSavedScript(study, exact[0].scriptIdPart)
    ));
    const publicDuplicates = chartStudies.filter((study) => chartStudyIsPublicPineScript(study));
    const otherConflicts = chartStudies.filter((study) => (
      !chartStudyBindsSavedScript(study, exact[0].scriptIdPart)
      && !chartStudyIsOwnedPineScript(study)
      && !chartStudyIsPublicPineScript(study)
    ));
    if (boundStudies.length > 1) {
      throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: multiple chart studies bound to saved script ${normalizedName}`);
    }
    if (conflictingSavedStudies.length > 0) {
      throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: existing chart study ${normalizedName} is bound to a different saved script`);
    }
    if (otherConflicts.length > 0) {
      throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: existing chart study ${normalizedName} is not repo-owned Pine`);
    }
    if (action === 'updated' && boundStudies.length === 1) {
      if (!boundStudies[0].id) {
        throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: updated chart study ${normalizedName} has no entity identity`);
      }
      await removeChartStudy(boundStudies[0].id);
      chartStudies = await readChartStudiesByName(normalizedName);
      if (chartStudies?.error) {
        throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: ${chartStudies.error}`);
      }
      boundStudies = chartStudies.filter((study) => chartStudyBindsSavedScript(study, exact[0].scriptIdPart));
    }
    for (const duplicate of publicDuplicates) {
      if (!duplicate.id) throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: public duplicate ${normalizedName} has no entity identity`);
      await removeChartStudy(duplicate.id);
    }
    if (publicDuplicates.length > 0) {
      chartStudies = await readChartStudiesByName(normalizedName);
      if (chartStudies?.error) {
        throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: ${chartStudies.error}`);
      }
    }
    if (boundStudies.length === 0) {
      await addSavedPineScriptToChart(exact[0].scriptIdPart);
      chartStudies = await readChartStudiesByName(normalizedName);
    }
    if (chartStudies?.error) {
      throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: ${chartStudies.error}`);
    }
    const finalBoundStudies = chartStudies.filter((study) => chartStudyBindsSavedScript(study, exact[0].scriptIdPart));
    if (finalBoundStudies.length !== 1 || chartStudies.length !== 1 || !finalBoundStudies[0].id) {
      throw new Error(`PINE_NAMED_UPSERT_CHART_READBACK_FAILED: expected one chart study ${normalizedName}`);
    }
    chartStudyId = finalBoundStudies[0].id;
    chartIndicatorId = finalBoundStudies[0].indicator_id;
    sourceBound = true;
  }

  return {
    success: true,
    action,
    name: normalizedName,
    saved_script_id: exact[0].scriptIdPart,
    chart_study_id: chartStudyId,
    chart_indicator_id: chartIndicatorId,
    source_sha256: sourceHash,
    added_to_chart: addToChart,
    pane_index: paneIndex ?? null,
    source_bound: sourceBound,
  };
}

export async function applyScopedSavedPine({
  profile_id,
  tab_index,
  pane_index,
  name,
  source,
  expected_chart_target_id,
  expected_chart_id,
  expected_layout_id,
  expected_pane_signature,
  _deps,
}) {
  const scope = await verifyScopedMutationAuthority({
    profile_id,
    tab_index,
    pane_index,
    indicator_name: name,
    expected_chart_target_id,
    expected_chart_id,
    expected_layout_id,
    expected_pane_signature,
  }, { action: 'apply_indicator', _deps });
  const focusResult = await (_deps?.switchTab || switchTab)({ index: scope.tab_index });
  const paneFocusResult = await (_deps?.focusPane || focusPane)({ index: scope.pane_index });
  const ensured = await ensureSavedPineScriptNamed({ name: scope.indicator_name, source });

  await verifyScopedMutationAuthority({
    ...scope,
    expected_pane_signature: scope.expected_pane_signature,
  }, { action: 'apply_indicator', _deps });

  let chartStudies = await readChartStudiesByName(ensured.normalizedName);
  if (chartStudies?.error) {
    throw new Error(`PINE_APPLY_SCOPED_CHART_READBACK_FAILED: ${chartStudies.error}`);
  }
  let boundStudies = chartStudies.filter((study) => chartStudyBindsSavedScript(study, ensured.exact.scriptIdPart));
  if (boundStudies.length > 1) {
    throw new Error(`PINE_APPLY_SCOPED_CHART_READBACK_FAILED: multiple exact saved-script bindings for ${ensured.normalizedName}`);
  }
  if (chartStudies.some((study) => !chartStudyBindsSavedScript(study, ensured.exact.scriptIdPart))) {
    throw new Error(`PINE_APPLY_SCOPED_CHART_READBACK_FAILED: existing chart study ${ensured.normalizedName} is not exact saved Pine`);
  }
  if (ensured.action === 'updated' && boundStudies.length === 1) {
    if (!boundStudies[0].id) {
      throw new Error(`PINE_APPLY_SCOPED_CHART_READBACK_FAILED: exact saved study ${ensured.normalizedName} has no entity identity`);
    }
    await removeChartStudy(boundStudies[0].id);
    chartStudies = await readChartStudiesByName(ensured.normalizedName);
    if (chartStudies?.error) {
      throw new Error(`PINE_APPLY_SCOPED_CHART_READBACK_FAILED: ${chartStudies.error}`);
    }
    boundStudies = chartStudies.filter((study) => chartStudyBindsSavedScript(study, ensured.exact.scriptIdPart));
  }
  const action = boundStudies.length === 1 ? 'unchanged' : 'created';
  if (boundStudies.length === 0) {
    await addSavedPineScriptToChart(ensured.exact.scriptIdPart);
    chartStudies = await readChartStudiesAfterNamedCreate(ensured.normalizedName);
    if (chartStudies?.error) {
      throw new Error(`PINE_APPLY_SCOPED_CHART_READBACK_FAILED: ${chartStudies.error}`);
    }
    boundStudies = chartStudies.filter((study) => chartStudyBindsSavedScript(study, ensured.exact.scriptIdPart));
  }
  if (boundStudies.length !== 1 || chartStudies.length !== 1 || !boundStudies[0].id) {
    throw new Error(`PINE_APPLY_SCOPED_CHART_READBACK_FAILED: expected one exact saved Pine study ${ensured.normalizedName}`);
  }
  const postInventory = await indicatorSignatures({ _deps });
  const postPane = postInventory.panes.find((pane) => pane.index === scope.pane_index);
  if (!postPane) throw new Error(`PINE_APPLY_SCOPED_POST_READBACK_FAILED: pane ${scope.pane_index} unavailable`);
  const postIndicator = postPane.indicators.find((indicator) => indicator.indicator_name.toLocaleLowerCase('en-US') === ensured.normalizedName.toLocaleLowerCase('en-US'));
  if (!postIndicator || postIndicator.entity_id !== boundStudies[0].id || postIndicator.indicator_id !== boundStudies[0].indicator_id) {
    throw new Error(`PINE_APPLY_SCOPED_POST_READBACK_FAILED: exact chart study identity mismatch for ${ensured.normalizedName}`);
  }
  return {
    success: true,
    scoped_pine_apply_version: 'pine-apply-scoped-v1',
    profile_id: scope.profile_id,
    tab_index: scope.tab_index,
    pane_index: scope.pane_index,
    chart_target_id: scope.expected_chart_target_id,
    chart_id: scope.expected_chart_id,
    layout_id: scope.expected_layout_id,
    name: ensured.normalizedName,
    action,
    saved_script_action: ensured.action,
    saved_script_id: ensured.exact.scriptIdPart,
    chart_study_id: boundStudies[0].id,
    chart_indicator_id: boundStudies[0].indicator_id,
    source_sha256: ensured.sourceHash,
    source_bound: true,
    pre_mutation_signature: scope.expected_pane_signature,
    post_mutation_signature: postPane.signature,
    post_mutation_indicator: postIndicator,
    post_mutation_indicator_count: postPane.indicators.length,
    focus: { tab: focusResult, pane: paneFocusResult },
    message: 'scoped saved Pine source applied and exact chart binding verified',
  };
}
