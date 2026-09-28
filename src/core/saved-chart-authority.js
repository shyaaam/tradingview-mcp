import { createHash } from 'node:crypto';
import CDP from 'chrome-remote-interface';

import {
  assertExactProfileBrowserWebSocket,
  resolveExactRunningProfile,
} from './chart-target-open.js';

const GENERIC_CHART_URL = 'https://www.tradingview.com/chart/';
const TARGET_POLL_ATTEMPTS = 30;
const TARGET_POLL_MS = 250;
const PAGE_POLL_ATTEMPTS = 40;
const PAGE_POLL_MS = 500;
const CHART_UID = /^[A-Za-z0-9_-]{1,160}$/u;
const HASH = /^[0-9a-f]{64}$/u;

export const ACCOUNT_LAYOUT_PROBE = `
  (async function() {
    function read(value) {
      try {
        if (typeof value === 'function') value = value();
        if (value && typeof value.value === 'function') value = value.value();
        return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      } catch { return ''; }
    }
    var api = window.TradingViewApi;
    var collection = api && api._chartWidgetCollection;
    var subjects = [];
    var candidates = [
      api && api._user && (api._user.id || api._user.user_id || api._user.username),
      window.TradingView && window.TradingView.user && (window.TradingView.user.id || window.TradingView.user.user_id || window.TradingView.user.username),
      collection && collection.metaInfo && collection.metaInfo.username,
    ];
    for (var i = 0; i < candidates.length; i++) {
      var value = read(candidates[i]);
      if (value && subjects.indexOf(value) === -1) subjects.push(value);
    }
    if (subjects.length !== 1 || !window.crypto || !window.crypto.subtle) {
      return { authenticated: false, account_subject_sha256: null, layouts: null, chart_uid: null };
    }
    var digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(subjects[0]));
    var accountHash = Array.prototype.map.call(new Uint8Array(digest), function(byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
    if (!api || typeof api.getSavedCharts !== 'function') {
      return { authenticated: true, account_subject_sha256: accountHash, layouts: null, chart_uid: null };
    }
    var layouts = await new Promise(function(resolve) {
      var settled = false;
      var timer = setTimeout(function() {
        if (!settled) { settled = true; resolve(null); }
      }, 5000);
      try {
        api.getSavedCharts(function(charts) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!Array.isArray(charts)) { resolve(null); return; }
          var normalized = charts.map(function(chart) {
            var id = chart && (chart.id || chart.chartId || chart.chart_id);
            var name = chart && (chart.name || chart.title);
            if (id === null || id === undefined || !String(id).trim() || typeof name !== 'string') return null;
            return { layout_id: String(id), name: name, symbol: String(chart.symbol || ''), resolution: String(chart.resolution || '') };
          });
          if (normalized.some(function(chart) { return chart === null; })) { resolve(null); return; }
          resolve(normalized);
        });
      } catch { clearTimeout(timer); resolve(null); }
    });
    var match = String(window.location && window.location.pathname || '').match(/^\\/chart\\/([A-Za-z0-9_-]{1,160})\\/?$/u);
    return {
      authenticated: true,
      account_subject_sha256: accountHash,
      layouts: layouts,
      chart_uid: match ? match[1] : null,
    };
  })()
`;

export function savedChartLayoutMarker(captureSlotId, reconciliationKey) {
  validateEnsureInput({ profileName: 'profile', captureSlotId, reconciliationKey });
  const slot = captureSlotId === 'v5-capture-slot-a' ? 'A' : 'B';
  const digest = createHash('sha256')
    .update(`tv-observer-v5:saved-chart:${captureSlotId}:${reconciliationKey}`, 'utf8')
    .digest('base64url').slice(0, 32);
  return `V5OBS-${slot}-${digest}`;
}

/** Read-only current-account and exact deterministic-layout preflight. */
export async function preflightSavedChartAuthority(input = {}, dependencies = {}) {
  const normalized = validateEnsureInput(input);
  const marker = savedChartLayoutMarker(normalized.captureSlotId, normalized.reconciliationKey);
  let inventory;
  try {
    inventory = await (dependencies.readProfileInventory || readProfileInventory)(normalized.profileName, dependencies);
    if (normalized.expectedProfileId !== null && inventory.profile.profileId !== normalized.expectedProfileId) {
      throw new Error('PROFILE_UUID_CHANGED_BEFORE_PREFLIGHT');
    }
  } catch (error) {
    return preflightResult(normalized, marker, {
      authenticated: false,
      accountSubjectSha256: null,
      layouts: [],
      chartTargetCount: null,
      createAvailable: false,
      createFailureCode: null,
      createInputCount: null,
      createInputMaxLength: null,
      failureCode: safeFailureCode(error),
    });
  }

  let createProbe = { available: false, failureCode: null, inputCount: null, inputMaxLength: null };
  try {
    if (inventory.authenticated && inventory.layouts !== null
      && exactMarkerMatches(inventory.layouts, marker).length === 0) {
      try {
        createProbe = await (dependencies.canCreateSavedLayout || canCreateSavedLayout)(inventory.page, marker, dependencies);
      } catch (error) {
        createProbe = { available: false, failureCode: safeFailureCode(error), inputCount: null, inputMaxLength: null };
      }
    }
  } finally {
    await closeProfileInventory(inventory);
  }
  return preflightResult(normalized, marker, {
    authenticated: inventory.authenticated,
    accountSubjectSha256: inventory.accountSubjectSha256,
    layouts: inventory.layouts ?? [],
    chartTargetCount: inventory.targets.length,
    createAvailable: createProbe.available,
    createFailureCode: createProbe.failureCode,
    createInputCount: createProbe.inputCount,
    createInputMaxLength: createProbe.inputMaxLength,
    failureCode: inventory.authenticated && inventory.layouts !== null ? null : 'PROFILE_NOT_AUTHENTICATED',
  });
}

/** Create once after durable claim, or discover exact marker after any ambiguous prior outcome. */
export async function ensureSavedChartAuthority(input = {}, dependencies = {}) {
  const normalized = validateEnsureInput(input);
  const marker = savedChartLayoutMarker(normalized.captureSlotId, normalized.reconciliationKey);
  let inventory;
  try {
    inventory = await (dependencies.readProfileInventory || readProfileInventory)(normalized.profileName, dependencies);
    if (normalized.expectedProfileId !== null && inventory.profile.profileId !== normalized.expectedProfileId) {
      throw new Error('PROFILE_UUID_CHANGED_BEFORE_ENSURE');
    }
  } catch (error) {
    return ensureResult(normalized, marker, {
      action: 'unknown', matchCount: 0, savedChartId: null, accountSubjectSha256: null,
      mutationsPerformed: false, temporaryTargetClosed: true, failureCode: safeFailureCode(error),
    });
  }
  await closeProfileInventory(inventory);
  if (!inventory.authenticated || inventory.layouts === null) {
    return ensureResult(normalized, marker, {
      action: 'unknown', matchCount: 0, savedChartId: null,
      accountSubjectSha256: inventory.accountSubjectSha256,
      mutationsPerformed: false, temporaryTargetClosed: true, failureCode: 'PROFILE_NOT_AUTHENTICATED',
    });
  }
  if (inventory.accountSubjectSha256 !== normalized.expectedAccountSubjectSha256) {
    return ensureResult(normalized, marker, {
      action: 'unknown', matchCount: 0, savedChartId: null,
      accountSubjectSha256: inventory.accountSubjectSha256,
      mutationsPerformed: false, temporaryTargetClosed: true, failureCode: 'ACCOUNT_IDENTITY_CHANGED',
    });
  }

  const matches = exactMarkerMatches(inventory.layouts, marker);
  if (matches.length > 1) {
    return ensureResult(normalized, marker, {
      action: 'multiple', matchCount: matches.length, savedChartId: null,
      accountSubjectSha256: inventory.accountSubjectSha256,
      mutationsPerformed: false, temporaryTargetClosed: true, failureCode: null,
    });
  }
  if (matches.length === 1) {
    let chartId;
    let closed = true;
    try {
      const resolved = await (dependencies.resolveSavedLayoutRoute || resolveSavedLayoutRoute)(
        normalized.profileName, normalized.expectedProfileId, matches[0], inventory.accountSubjectSha256, dependencies);
      chartId = resolved.chartId;
      closed = resolved.temporaryTargetClosed;
    } catch (error) {
      return ensureResult(normalized, marker, {
        action: 'unknown', matchCount: 1, savedChartId: null,
        accountSubjectSha256: inventory.accountSubjectSha256,
        mutationsPerformed: false, temporaryTargetClosed: true, failureCode: safeFailureCode(error),
      });
    }
    return ensureResult(normalized, marker, {
      action: 'reused', matchCount: 1, savedChartId: chartId,
      accountSubjectSha256: inventory.accountSubjectSha256,
      mutationsPerformed: false, temporaryTargetClosed: closed, failureCode: null,
    });
  }
  if (!normalized.createIfAbsent) {
    return ensureResult(normalized, marker, {
      action: 'not_found', matchCount: 0, savedChartId: null,
      accountSubjectSha256: inventory.accountSubjectSha256,
      mutationsPerformed: false, temporaryTargetClosed: true, failureCode: null,
    });
  }

  let createAttempted = false;
  let temporaryTargetClosed = true;
  try {
    const created = await (dependencies.createSavedLayout || createSavedLayout)(normalized.profileName, normalized.expectedProfileId,
      normalized.captureSlotId, marker, inventory, dependencies, () => { createAttempted = true; });
    temporaryTargetClosed = created.temporaryTargetClosed;
    return ensureResult(normalized, marker, {
      action: 'created', matchCount: 1, savedChartId: created.chartId,
      accountSubjectSha256: inventory.accountSubjectSha256,
      mutationsPerformed: true, temporaryTargetClosed, failureCode: null,
    });
  } catch (error) {
    return ensureResult(normalized, marker, {
      action: 'unknown', matchCount: 0, savedChartId: null,
      accountSubjectSha256: inventory.accountSubjectSha256,
      mutationsPerformed: createAttempted, temporaryTargetClosed,
      failureCode: safeFailureCode(error),
    });
  }
}

function preflightResult(input, marker, state) {
  const matches = exactMarkerMatches(state.layouts, marker);
  const action = matches.length > 1 ? 'multiple' : matches.length === 1 ? 'found' : 'not_found';
  return {
    success: true,
    preflight_version: 'saved-chart-authority-preflight-v1',
    profile_name: input.profileName,
    capture_slot_id: input.captureSlotId,
    reconciliation_key: input.reconciliationKey,
    layout_marker: marker,
    authenticated: state.authenticated,
    account_subject_sha256: state.accountSubjectSha256,
    action,
    match_count: matches.length,
    can_create: action === 'not_found' && state.authenticated && state.createAvailable,
    create_preflight_failure_code: state.createFailureCode,
    create_marker_length: marker.length,
    create_input_count: state.createInputCount,
    create_input_max_length: state.createInputMaxLength,
    layout_count: state.authenticated && state.layouts !== null ? state.layouts.length : null,
    layout_inventory_sha256: state.authenticated && state.layouts !== null
      ? createHash('sha256').update(stableJson(state.layouts), 'utf8').digest('hex')
      : null,
    chart_target_count: Number.isSafeInteger(state.chartTargetCount) ? state.chartTargetCount : null,
    failure_code: state.failureCode,
  };
}

function ensureResult(input, marker, state) {
  const savedChartId = state.savedChartId;
  return {
    success: true,
    authority_ensure_version: 'saved-chart-authority-ensure-v1',
    profile_name: input.profileName,
    capture_slot_id: input.captureSlotId,
    reconciliation_key: input.reconciliationKey,
    create_if_absent: input.createIfAbsent,
    action: state.action,
    layout_marker: marker,
    match_count: state.matchCount,
    saved_chart_id: savedChartId,
    canonical_chart_url: savedChartId === null ? null : `https://www.tradingview.com/chart/${savedChartId}/`,
    account_subject_sha256: state.accountSubjectSha256,
    mutations_performed: state.mutationsPerformed,
    temporary_target_closed: state.temporaryTargetClosed,
    failure_code: state.failureCode,
  };
}

async function readProfileInventory(profileName, dependencies) {
  const profile = await resolveExactRunningProfile(profileName, dependencies);
  const targets = await listTargets(profile.cdpUrl, dependencies);
  let chartTargets = targets.filter(isTradingViewChartTarget);
  let temporaryTarget = null;
  if (chartTargets.length === 0) {
    temporaryTarget = await (dependencies.createInventoryTarget || openTemporaryChartTarget)(profile, dependencies, targets);
    chartTargets = [temporaryTarget.target];
  }

  let canonicalLayouts = null;
  let accountSubjectSha256 = null;
  let firstPage = null;
  for (const target of chartTargets) {
    const page = temporaryTarget?.target.id === target.id
      ? temporaryTarget.page
      : await connectTarget(target, dependencies);
    try {
      await enablePage(page);
      const probe = await evaluate(page, ACCOUNT_LAYOUT_PROBE);
      if (probe?.authenticated !== true || !HASH.test(String(probe.account_subject_sha256 || ''))
        || !Array.isArray(probe.layouts)) {
        throw new Error('PROFILE_NOT_AUTHENTICATED_OR_LAYOUT_API_UNAVAILABLE');
      }
      const layouts = normalizeLayouts(probe.layouts);
      if (accountSubjectSha256 !== null && accountSubjectSha256 !== probe.account_subject_sha256) {
        throw new Error('PROFILE_TABS_HAVE_DIFFERENT_ACCOUNT_IDENTITIES');
      }
      if (canonicalLayouts !== null && stableJson(canonicalLayouts) !== stableJson(layouts)) {
        throw new Error('PROFILE_TABS_HAVE_DIFFERENT_SAVED_LAYOUT_INVENTORIES');
      }
      accountSubjectSha256 = probe.account_subject_sha256;
      canonicalLayouts = layouts;
      firstPage ??= page;
      if (page !== firstPage) await closePage(page);
    } catch (error) {
      if (temporaryTarget !== null) await temporaryTarget.close();
      else await closePage(page);
      if (firstPage !== null) await closePage(firstPage);
      throw error;
    }
  }
  if (firstPage === null || canonicalLayouts === null || accountSubjectSha256 === null) {
    if (temporaryTarget !== null) await temporaryTarget.close();
    throw new Error('PROFILE_NOT_AUTHENTICATED_OR_LAYOUT_API_UNAVAILABLE');
  }
  return {
    profile,
    targets: chartTargets,
    page: firstPage,
    layouts: canonicalLayouts,
    accountSubjectSha256,
    authenticated: true,
    close: async () => {
      if (temporaryTarget !== null) await temporaryTarget.close();
      else await closePage(firstPage);
    },
  };
}

async function openTemporaryChartTarget(profile, dependencies, existingTargets) {
  if (existingTargets.some(isTradingViewLoginTarget)) {
    throw new Error('TRADINGVIEW_LOGIN_TARGET_PRESENT');
  }
  if (existingTargets.some((target) => target?.type === 'page' && String(target.url || '').trim() === 'about:blank')) {
    throw new Error('AMBIGUOUS_BLANK_TARGET_PRESENT');
  }
  const version = await fetchJson(new URL('json/version', `${profile.cdpUrl}/`).toString(), dependencies);
  assertExactProfileBrowserWebSocket(version?.webSocketDebuggerUrl, profile.cdpUrl, profile.profileId);
  const browser = await (dependencies.connectBrowser || ((url) => CDP({ target: url, local: true })))(
    version.webSocketDebuggerUrl,
  );
  let targetId = null;
  let page = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (page) await closePage(page);
    let result = null;
    if (targetId !== null) {
      try { result = await browser.Target.closeTarget({ targetId }); } catch { result = null; }
    }
    try { await browser.close?.(); } catch { /* exact target close result is authoritative */ }
    if (result?.success !== true) throw new Error('TEMPORARY_INVENTORY_TARGET_CLOSE_UNCONFIRMED');
  };
  try {
    const created = await browser.Target.createTarget({ url: 'about:blank' });
    const createdTargetId = requireText(created?.targetId, 'temporary inventory target id');
    if (existingTargets.some((target) => target?.id === createdTargetId)) {
      throw new Error('TEMPORARY_INVENTORY_TARGET_ID_ALREADY_EXISTS');
    }
    targetId = createdTargetId;
    const target = await waitForTarget(profile.cdpUrl, targetId, dependencies);
    if (!target || target.type !== 'page' || target.url !== 'about:blank'
      || typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl) {
      throw new Error('TEMPORARY_INVENTORY_TARGET_NOT_EXACT');
    }
    page = await (dependencies.connectTarget || ((url) => CDP({ target: url, local: true })))(
      target.webSocketDebuggerUrl,
    );
    await enablePage(page);
    const before = await evaluate(page, '({ url: location.href })');
    if (before?.url !== 'about:blank') throw new Error('TEMPORARY_INVENTORY_TARGET_LEFT_BLANK');
    const navigation = await page.Page.navigate({ url: GENERIC_CHART_URL });
    if (navigation?.errorText) throw new Error('TEMPORARY_INVENTORY_NAVIGATION_FAILED');
    await waitForAccountProbe(page, dependencies);
    const navigatedTarget = await waitForTarget(profile.cdpUrl, targetId, dependencies);
    if (!isTradingViewChartTarget(navigatedTarget)) {
      throw new Error('TEMPORARY_INVENTORY_TARGET_ROUTE_NOT_EXACT');
    }
    return { target: navigatedTarget, page, close };
  } catch (error) {
    try { await close(); } catch { /* preserve the original fail-closed reason */ }
    throw error;
  }
}

async function closeProfileInventory(inventory) {
  if (typeof inventory.close === 'function') await inventory.close();
  else await closePage(inventory.page);
}

function normalizeLayouts(layouts) {
  const normalized = layouts.map((layout, index) => {
    if (!layout || typeof layout !== 'object' || typeof layout.layout_id !== 'string'
      || !layout.layout_id.trim() || typeof layout.name !== 'string') {
      throw new Error(`SAVED_LAYOUT_INVENTORY_MALFORMED_${index}`);
    }
    return Object.freeze({
      layoutId: layout.layout_id,
      name: layout.name,
      symbol: typeof layout.symbol === 'string' ? layout.symbol : '',
      resolution: typeof layout.resolution === 'string' ? layout.resolution : '',
    });
  }).sort((left, right) => left.layoutId.localeCompare(right.layoutId));
  if (new Set(normalized.map(({ layoutId }) => layoutId)).size !== normalized.length) {
    throw new Error('SAVED_LAYOUT_INVENTORY_DUPLICATE_IDS');
  }
  return Object.freeze(normalized);
}

function exactMarkerMatches(layouts, marker) {
  return layouts.filter((layout) => layout.name === marker);
}

async function canCreateSavedLayout(page, marker, dependencies) {
  try {
    await clickUniqueVisible(page, '[data-name="save-load-menu"]', dependencies, 'SAVE_LAYOUT_MENU_NOT_UNIQUE');
    await sleep(dependencies, 250);
    await clickUniqueVisible(page, '[role="row"][aria-label="Create new layout"]', dependencies, 'CREATE_LAYOUT_ACTION_NOT_UNIQUE');
    return await inspectCreateLayoutForm(page, marker, dependencies);
  } catch (error) {
    return { available: false, failureCode: safeFailureCode(error), inputCount: null, inputMaxLength: null };
  } finally {
    await pressEscape(page, dependencies);
  }
}

async function inspectCreateLayoutForm(page, marker, dependencies) {
  if (!await waitForVisibleDialog(page, dependencies)) {
    return { available: false, failureCode: 'CREATE_LAYOUT_DIALOG_NOT_VISIBLE', inputCount: 0, inputMaxLength: null };
  }
  const state = await evaluate(page, `
    (function() {
      var dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter(function(node) { var r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (dialogs.length !== 1) return { inputCount: 0, inputMaxLength: null, inputCoords: null, createButtonCount: 0, createCoords: null };
      var dialog = dialogs[0];
      var inputs = Array.from(dialog.querySelectorAll('input[type="text"]'))
        .filter(function(node) { var r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      var input = inputs.length === 1 ? inputs[0] : null;
      var inputRect = input ? input.getBoundingClientRect() : null;
      var buttons = Array.from(dialog.querySelectorAll('button'))
        .filter(function(node) { var r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && node.textContent.trim() === 'Create'; });
      var button = buttons.length === 1 ? buttons[0] : null;
      var buttonRect = button ? button.getBoundingClientRect() : null;
      return {
        inputCount: inputs.length,
        inputMaxLength: input ? input.maxLength : null,
        inputCoords: inputRect ? { x: inputRect.x + inputRect.width / 2, y: inputRect.y + inputRect.height / 2 } : null,
        createButtonCount: buttons.length,
        createButtonEnabled: button ? !button.disabled : false,
        createCoords: buttonRect ? { x: buttonRect.x + buttonRect.width / 2, y: buttonRect.y + buttonRect.height / 2 } : null,
      };
    })()
  `);
  const inputCount = Number.isSafeInteger(state?.inputCount) ? state.inputCount : 0;
  const inputMaxLength = Number.isSafeInteger(state?.inputMaxLength) ? state.inputMaxLength : null;
  if (inputCount !== 1 || !state?.inputCoords) {
    return { available: false, failureCode: 'CREATE_LAYOUT_INPUT_COUNT_NOT_ONE', inputCount, inputMaxLength };
  }
  if (inputMaxLength === null || inputMaxLength < -1) {
    return { available: false, failureCode: 'CREATE_LAYOUT_INPUT_MAX_LENGTH_INVALID', inputCount, inputMaxLength: null };
  }
  if (inputMaxLength !== null && inputMaxLength >= 0 && marker.length > inputMaxLength) {
    return { available: false, failureCode: 'CREATE_LAYOUT_MARKER_EXCEEDS_INPUT_LIMIT', inputCount, inputMaxLength };
  }
  if (state.createButtonCount !== 1 || !state.createCoords) {
    return { available: false, failureCode: 'CREATE_LAYOUT_BUTTON_NOT_READY', inputCount, inputMaxLength };
  }
  return {
    available: true,
    failureCode: null,
    inputCount,
    inputMaxLength,
    createButtonEnabled: state.createButtonEnabled === true,
    inputCoords: state.inputCoords,
    createCoords: state.createCoords,
  };
}

async function createSavedLayout(profileName, expectedProfileId, captureSlotId, marker, priorInventory, dependencies, onCreateAttempt) {
  const profile = await resolveExactRunningProfile(profileName, dependencies);
  if (expectedProfileId !== null && profile.profileId !== expectedProfileId) {
    throw new Error('PROFILE_UUID_CHANGED_BEFORE_LAYOUT_CREATE');
  }
  const version = await fetchJson(new URL('json/version', `${profile.cdpUrl}/`).toString(), dependencies);
  assertExactProfileBrowserWebSocket(version?.webSocketDebuggerUrl, profile.cdpUrl, profile.profileId);
  const browser = await (dependencies.connectBrowser || ((url) => CDP({ target: url, local: true })))(version.webSocketDebuggerUrl);
  let targetId;
  let page;
  let saved = false;
  let chartId = null;
  let closeBrowser;
  try {
    const created = await browser.Target.createTarget({ url: 'about:blank' });
    targetId = requireText(created?.targetId, 'created target id');
    const target = await waitForTarget(profile.cdpUrl, targetId, dependencies);
    if (!target || target.type !== 'page' || target.url !== 'about:blank'
      || typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl) {
      throw new Error('NEW_LAYOUT_TARGET_NOT_EXACT');
    }
    page = await (dependencies.connectTarget || ((url) => CDP({ target: url, local: true })))(target.webSocketDebuggerUrl);
    await enablePage(page);
    const current = await evaluate(page, `({ url: location.href })`);
    if (current?.url !== 'about:blank') throw new Error('NEW_LAYOUT_TARGET_LEFT_BLANK_BEFORE_NAVIGATION');
    const navigation = await page.Page.navigate({ url: GENERIC_CHART_URL });
    if (navigation?.errorText) throw new Error('GENERIC_CHART_NAVIGATION_FAILED');
    const probe = await waitForAccountProbe(page, dependencies);
    if (probe.account_subject_sha256 !== priorInventory.accountSubjectSha256) {
      throw new Error('ACCOUNT_IDENTITY_CHANGED_BEFORE_LAYOUT_CREATE');
    }
    if (probe.layouts.some((layout) => layout.name === marker)) throw new Error('LAYOUT_MARKER_APPEARED_BEFORE_CREATE');
    let sourceChartId = probe.chart_uid;
    if (probe.chart_uid !== null && !CHART_UID.test(probe.chart_uid)) throw new Error('SOURCE_CHART_ROUTE_ID_INVALID');
    const createdFromSlotA = captureSlotId === 'v5-capture-slot-b'
      ? probe.layouts.filter((layout) => /^V5OBS-A-[A-Za-z0-9_-]{32}$/u.test(layout.name))
      : [];
    if (createdFromSlotA.length > 1) throw new Error('MULTIPLE_SLOT_A_SOURCE_CHARTS');
    if (createdFromSlotA.length === 1) {
      await loadSavedLayout(page, createdFromSlotA[0].layoutId, dependencies);
      const sourceProbe = await waitForPageProbe(page, dependencies);
      if (sourceProbe.account_subject_sha256 !== priorInventory.accountSubjectSha256
        || sourceProbe.layouts.filter((layout) => layout.name === createdFromSlotA[0].name).length !== 1
        || sourceProbe.chart_uid === null) throw new Error('SLOT_A_SOURCE_CHART_NOT_VERIFIED');
      sourceChartId = sourceProbe.chart_uid;
    }

    const before = await waitForAccountProbe(page, dependencies);
    if (stableJson(before.layouts) !== stableJson(priorInventory.layouts)
      && stableJson(before.layouts) !== stableJson(probe.layouts)) {
      throw new Error('SAVED_LAYOUT_INVENTORY_CHANGED_BEFORE_CREATE');
    }
    if (before.layouts.some((layout) => layout.name === marker)) throw new Error('LAYOUT_MARKER_ALREADY_EXISTS');

    await clickUniqueVisible(page, '[data-name="save-load-menu"]', dependencies, 'SAVE_LAYOUT_MENU_NOT_UNIQUE');
    await clickUniqueVisible(page, '[role="row"][aria-label="Create new layout"]', dependencies, 'CREATE_LAYOUT_ACTION_NOT_UNIQUE');
    const createForm = await inspectCreateLayoutForm(page, marker, dependencies);
    if (!createForm.available) throw new Error(createForm.failureCode);
    const inputCoords = createForm.inputCoords;
    await clickAt(page, inputCoords, dependencies);
    await (dependencies.insertText || ((text) => page.Input.insertText({ text })))(marker);
    const value = await evaluate(page, `
      (function() {
        var dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
          .filter(function(node) { var r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (dialogs.length !== 1) return null;
        var inputs = Array.from(dialogs[0].querySelectorAll('input[type="text"]'))
          .filter(function(node) { var r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        return inputs.length === 1 ? inputs[0].value : null;
      })()
    `);
    if (value !== marker) throw new Error('CREATE_LAYOUT_MARKER_INPUT_MISMATCH');
    const filledForm = await inspectCreateLayoutForm(page, marker, dependencies);
    if (!filledForm.available || !filledForm.createButtonEnabled) throw new Error('CREATE_LAYOUT_BUTTON_NOT_READY');
    const createCoords = filledForm.createCoords;
    onCreateAttempt();
    await clickAt(page, createCoords, dependencies);
    const createdProbe = await waitForMarkerPageProbe(page, marker, priorInventory.accountSubjectSha256, dependencies);
    chartId = createdProbe.chart_uid;
    if (chartId === null || (sourceChartId !== null && chartId === sourceChartId) || !CHART_UID.test(chartId)) {
      throw new Error('NEW_SAVED_CHART_ROUTE_ID_NOT_PROVEN');
    }
    if (createdProbe.layouts.filter((layout) => layout.name === marker).length !== 1) {
      throw new Error('CREATED_LAYOUT_MARKER_NOT_UNIQUE');
    }
    const priorEntries = createdProbe.layouts.filter((layout) => layout.name !== marker)
      .map(({ layoutId, name }) => ({ layoutId, name })).sort(layoutOrder);
    const expectedEntries = priorInventory.layouts.map(({ layoutId, name }) => ({ layoutId, name })).sort(layoutOrder);
    if (stableJson(priorEntries) !== stableJson(expectedEntries)) {
      throw new Error('EXISTING_SAVED_LAYOUT_INVENTORY_CHANGED');
    }
    saved = true;
  } finally {
    if (page) await closePage(page);
    if (targetId) {
      try {
        closeBrowser = await browser.Target.closeTarget({ targetId });
      } catch {
        closeBrowser = null;
      }
    }
    try { await browser.close?.(); } catch { /* preserve saved-layout result */ }
  }
  if (!saved || chartId === null) throw new Error('SAVED_LAYOUT_CREATE_NOT_CONFIRMED');
  return { chartId, temporaryTargetClosed: closeBrowser?.success === true };
}

async function resolveSavedLayoutRoute(profileName, expectedProfileId, layout, expectedAccountHash, dependencies) {
  const profile = await resolveExactRunningProfile(profileName, dependencies);
  if (expectedProfileId !== null && profile.profileId !== expectedProfileId) {
    throw new Error('PROFILE_UUID_CHANGED_BEFORE_LAYOUT_DISCOVERY');
  }
  const version = await fetchJson(new URL('json/version', `${profile.cdpUrl}/`).toString(), dependencies);
  assertExactProfileBrowserWebSocket(version?.webSocketDebuggerUrl, profile.cdpUrl, profile.profileId);
  const browser = await (dependencies.connectBrowser || ((url) => CDP({ target: url, local: true })))(version.webSocketDebuggerUrl);
  let targetId;
  let page;
  let closeResult = null;
  let chartId = null;
  try {
    const created = await browser.Target.createTarget({ url: 'about:blank' });
    targetId = requireText(created?.targetId, 'created target id');
    const target = await waitForTarget(profile.cdpUrl, targetId, dependencies);
    if (!target || target.type !== 'page' || target.url !== 'about:blank'
      || typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl) {
      throw new Error('DISCOVERY_TARGET_NOT_EXACT');
    }
    page = await (dependencies.connectTarget || ((url) => CDP({ target: url, local: true })))(target.webSocketDebuggerUrl);
    await enablePage(page);
    const nav = await page.Page.navigate({ url: GENERIC_CHART_URL });
    if (nav?.errorText) throw new Error('DISCOVERY_GENERIC_NAVIGATION_FAILED');
    await waitForAccountProbe(page, dependencies);
    await loadSavedLayout(page, layout.layoutId, dependencies);
    const probe = await waitForMarkerPageProbe(page, layout.name, expectedAccountHash, dependencies);
    if (probe.layouts.filter((entry) => entry.layoutId === layout.layoutId && entry.name === layout.name).length !== 1
      || probe.chart_uid === null || !CHART_UID.test(probe.chart_uid)) {
      throw new Error('DISCOVERED_LAYOUT_ROUTE_ID_NOT_PROVEN');
    }
    chartId = probe.chart_uid;
  } finally {
    if (page) await closePage(page);
    if (targetId) {
      try { closeResult = await browser.Target.closeTarget({ targetId }); } catch { closeResult = null; }
    }
    try { await browser.close?.(); } catch { /* preserve discovered result */ }
  }
  if (chartId === null) throw new Error('DISCOVERED_LAYOUT_ROUTE_ID_NOT_PROVEN');
  return { chartId, temporaryTargetClosed: closeResult?.success === true };
}

async function loadSavedLayout(page, layoutId, dependencies) {
  const expression = `(function() {
    var api = window.TradingViewApi;
    if (!api || typeof api.loadChartFromServer !== 'function') return { ok: false };
    try { api.loadChartFromServer(${JSON.stringify(layoutId)}); return { ok: true }; }
    catch { return { ok: false }; }
  })()`;
  const result = await evaluate(page, expression);
  if (result?.ok !== true) throw new Error('SAVED_LAYOUT_LOAD_API_UNAVAILABLE');
  await sleep(dependencies, 1000);
}

async function waitForVisibleDialog(page, dependencies) {
  for (let attempt = 0; attempt < TARGET_POLL_ATTEMPTS; attempt += 1) {
    const visible = await evaluate(page, `Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter(function(node) { var r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length`);
    if (visible === 1) return true;
    await sleep(dependencies, TARGET_POLL_MS);
  }
  return false;
}

async function clickUniqueVisible(page, selector, dependencies, errorCode) {
  const coords = await evaluate(page, `
    (function() {
      var nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .filter(function(node) { var r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (nodes.length !== 1 || nodes[0].disabled) return null;
      var r = nodes[0].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `);
  if (!coords) throw new Error(errorCode);
  await clickAt(page, coords, dependencies);
}

async function clickAt(page, coords, dependencies) {
  const dispatch = dependencies.dispatchMouseEvent || ((event) => page.Input.dispatchMouseEvent(event));
  await dispatch({ type: 'mouseMoved', x: coords.x, y: coords.y });
  await dispatch({ type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await dispatch({ type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
}

async function pressEscape(page, dependencies) {
  const dispatch = dependencies.dispatchKeyEvent || ((event) => page.Input.dispatchKeyEvent(event));
  await dispatch({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dispatch({ type: 'keyUp', key: 'Escape', code: 'Escape' });
}

async function waitForPageProbe(page, dependencies) {
  for (let attempt = 0; attempt < PAGE_POLL_ATTEMPTS; attempt += 1) {
    try {
      const probe = await evaluate(page, ACCOUNT_LAYOUT_PROBE);
      if (probe?.authenticated === true && HASH.test(String(probe.account_subject_sha256 || ''))
        && Array.isArray(probe.layouts) && typeof probe.chart_uid === 'string' && CHART_UID.test(probe.chart_uid)) {
        return { ...probe, layouts: normalizeLayouts(probe.layouts) };
      }
    } catch { /* bounded page readiness poll */ }
    await sleep(dependencies, PAGE_POLL_MS);
  }
  throw new Error('TRADINGVIEW_ACCOUNT_OR_LAYOUT_READINESS_TIMEOUT');
}

async function waitForAccountProbe(page, dependencies) {
  for (let attempt = 0; attempt < PAGE_POLL_ATTEMPTS; attempt += 1) {
    try {
      const probe = await evaluate(page, ACCOUNT_LAYOUT_PROBE);
      if (probe?.authenticated === true && HASH.test(String(probe.account_subject_sha256 || ''))
        && Array.isArray(probe.layouts)) {
        return { ...probe, layouts: normalizeLayouts(probe.layouts) };
      }
    } catch { /* bounded page readiness poll */ }
    await sleep(dependencies, PAGE_POLL_MS);
  }
  throw new Error('TRADINGVIEW_ACCOUNT_OR_LAYOUT_READINESS_TIMEOUT');
}

async function waitForMarkerPageProbe(page, marker, expectedAccountHash, dependencies) {
  for (let attempt = 0; attempt < PAGE_POLL_ATTEMPTS; attempt += 1) {
    try {
      const probe = await evaluate(page, ACCOUNT_LAYOUT_PROBE);
      if (probe?.authenticated === true && probe.account_subject_sha256 !== expectedAccountHash) {
        throw new Error('ACCOUNT_IDENTITY_CHANGED_DURING_SAVED_CHART_OPERATION');
      }
      if (probe?.authenticated === true && Array.isArray(probe.layouts)
        && probe.layouts.filter((layout) => layout.name === marker).length === 1
        && typeof probe.chart_uid === 'string' && CHART_UID.test(probe.chart_uid)) {
        return { ...probe, layouts: normalizeLayouts(probe.layouts) };
      }
    } catch (error) {
      if (error.message === 'ACCOUNT_IDENTITY_CHANGED_DURING_SAVED_CHART_OPERATION') throw error;
    }
    await sleep(dependencies, PAGE_POLL_MS);
  }
  throw new Error('SAVED_CHART_CREATE_OR_DISCOVERY_NOT_CONFIRMED');
}

async function listTargets(cdpUrl, dependencies) {
  const targets = await fetchJson(new URL('json/list', `${cdpUrl}/`).toString(), dependencies);
  if (!Array.isArray(targets)) throw new Error('PROFILE_TARGET_INVENTORY_MALFORMED');
  return targets;
}

async function waitForTarget(cdpUrl, targetId, dependencies) {
  for (let attempt = 0; attempt < TARGET_POLL_ATTEMPTS; attempt += 1) {
    const target = (await listTargets(cdpUrl, dependencies)).find((entry) => entry?.id === targetId);
    if (target) return target;
    await sleep(dependencies, TARGET_POLL_MS);
  }
  return null;
}

async function fetchJson(url, dependencies) {
  const response = await (dependencies.fetch || fetch)(url);
  if (!response.ok) throw new Error(`CLOAK_REQUEST_${response.status}`);
  return await response.json();
}

async function connectTarget(target, dependencies) {
  if (typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl) {
    throw new Error('EXACT_CHART_TARGET_WEBSOCKET_UNAVAILABLE');
  }
  return await (dependencies.connectTarget || ((url) => CDP({ target: url, local: true })))(target.webSocketDebuggerUrl);
}

async function enablePage(page) {
  await page.Runtime.enable();
  await page.Page.enable();
}

async function evaluate(page, expression) {
  const response = await page.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error('TRADINGVIEW_PAGE_EVALUATION_FAILED');
  return response.result?.value;
}

async function closePage(page) {
  try { await page.close?.(); } catch { /* preserve authoritative operation result */ }
}

async function sleep(dependencies, milliseconds) {
  await (dependencies.sleep || ((duration) => new Promise((resolve) => setTimeout(resolve, duration))))(milliseconds);
}

function isTradingViewChartTarget(target) {
  if (target?.type !== 'page') return false;
  try {
    const url = new URL(String(target.url || ''));
    return url.origin === 'https://www.tradingview.com'
      && (url.pathname === '/chart/' || /^\/chart\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname));
  } catch {
    return false;
  }
}

function isTradingViewLoginTarget(target) {
  if (target?.type !== 'page') return false;
  try {
    const url = new URL(String(target.url || ''));
    return url.origin === 'https://www.tradingview.com'
      && /^\/(?:accounts\/(?:signin|login)|signin|login)(?:\/|$)/iu.test(url.pathname);
  } catch {
    return false;
  }
}

function layoutOrder(left, right) {
  return left.layoutId.localeCompare(right.layoutId) || left.name.localeCompare(right.name);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 160) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function validateEnsureInput(input) {
  const profileName = requireText(input.profileName ?? input.profile_name, 'profile_name');
  const captureSlotId = input.captureSlotId ?? input.capture_slot_id;
  const reconciliationKey = input.reconciliationKey ?? input.reconciliation_key;
  const expectedAccountSubjectSha256 = input.expectedAccountSubjectSha256 ?? input.expected_account_subject_sha256;
  const createIfAbsent = input.createIfAbsent ?? input.create_if_absent ?? false;
  if (!['v5-capture-slot-a', 'v5-capture-slot-b'].includes(captureSlotId) || !HASH.test(String(reconciliationKey || ''))) {
    throw new Error('Saved-chart authority request is invalid');
  }
  if (expectedAccountSubjectSha256 !== undefined
    && !HASH.test(String(expectedAccountSubjectSha256))) throw new Error('Expected account identity hash is invalid');
  if (typeof createIfAbsent !== 'boolean') throw new Error('Create-if-absent authority is invalid');
  const expectedProfileId = input.expectedProfileId ?? input.expected_profile_id;
  if (expectedProfileId !== undefined && (typeof expectedProfileId !== 'string'
    || expectedProfileId.trim() !== expectedProfileId || expectedProfileId.length < 1 || expectedProfileId.length > 160)) {
    throw new Error('Expected ephemeral profile identity is invalid');
  }
  return Object.freeze({
    profileName,
    expectedProfileId: expectedProfileId ?? null,
    expectedAccountSubjectSha256: expectedAccountSubjectSha256 ?? null,
    createIfAbsent,
    captureSlotId,
    reconciliationKey,
  });
}

function safeFailureCode(error) {
  const message = error instanceof Error ? error.message : '';
  const code = message.replace(/[^A-Z0-9_]/gu, '_').replace(/_+/gu, '_').slice(0, 64).toUpperCase();
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'PROVIDER_OPERATION_FAILED';
}
