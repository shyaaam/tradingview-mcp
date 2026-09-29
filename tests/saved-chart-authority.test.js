import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { TextEncoder } from 'node:util';

import {
  ACCOUNT_LAYOUT_PROBE,
  ensureSavedChartAuthority,
  preflightSavedChartAuthority,
  savedChartLayoutMarker,
} from '../src/core/saved-chart-authority.js';

const INPUT = Object.freeze({
  profileName: 'tv-observer-1',
  expectedProfileId: 'ephemeral-manager-id',
  captureSlotId: 'v5-capture-slot-a',
  reconciliationKey: 'a'.repeat(64),
});
const ACCOUNT_HASH = 'b'.repeat(64);
const MARKER = savedChartLayoutMarker(INPUT.captureSlotId, INPUT.reconciliationKey);

async function runProbe(charts) {
  const window = {
    TradingViewApi: {
      _user: { id: 'current-account' },
      getSavedCharts(callback) { callback(charts); },
    },
    crypto: { subtle: { digest: async () => new Uint8Array(32).buffer } },
    location: { pathname: '/chart/current-route-uid/' },
  };
  return await vm.runInNewContext(ACCOUNT_LAYOUT_PROBE, {
    window,
    TextEncoder,
    setTimeout,
    clearTimeout,
  });
}

function inventory(layouts = []) {
  return {
    profile: { profileName: INPUT.profileName, profileId: INPUT.expectedProfileId },
    targets: [{ id: 'transient-target', url: 'https://www.tradingview.com/chart/' }],
    page: { close: async () => {} },
    layouts,
    accountSubjectSha256: ACCOUNT_HASH,
    authenticated: true,
  };
}

function preflightProbePage(layouts = []) {
  const normalizedLayouts = layouts.map(({ layoutId, name, symbol = '', resolution = '' }) => ({
    layout_id: layoutId,
    name,
    symbol,
    resolution,
  }));
  return {
    Runtime: {
      evaluate: async () => ({ result: { value: {
        authenticated: true,
        account_subject_sha256: ACCOUNT_HASH,
        layouts: normalizedLayouts,
        chart_uid: null,
      } } }),
    },
    close: async () => {},
  };
}

function openPreflightProbeTarget(layouts = [], close = async () => {}) {
  const page = preflightProbePage(layouts);
  return async () => ({
    target: { id: 'fresh-generic-target', type: 'page', url: 'https://www.tradingview.com/chart/' },
    page,
    close,
  });
}

function createLayoutFormDom({ extraTextInput = false, fullPageContainer = false, htmlForm = false,
  createButton = true, textInput = true, inputType = 'text' } = {}) {
  const makeNode = (tagName, rect, properties = {}) => ({
    tagName: tagName.toUpperCase(),
    children: [],
    parentElement: null,
    getBoundingClientRect: () => rect,
    contains(candidate) {
      return this === candidate || this.children.some((child) => child.contains(candidate));
    },
    querySelectorAll(selector) {
      const descendants = this.children.flatMap((child) => [child, ...collect(child)]);
      return descendants.filter((node) => matchesSelector(node, selector));
    },
    ...properties,
  });
  const collect = (node) => node.children.flatMap((child) => [child, ...collect(child)]);
  const matchesSelector = (node, selector) => {
    if (selector === '[role="dialog"]') return node.role === 'dialog';
    if (selector === '[role="row"][aria-label="Create new layout"]') {
      return node.role === 'row' && node.ariaLabel === 'Create new layout';
    }
    if (selector === 'input') return node.tagName === 'INPUT';
    if (selector === 'button') return node.tagName === 'BUTTON';
    if (selector === 'form') return node.tagName === 'FORM';
    return false;
  };
  const html = makeNode('html', { x: 0, y: 0, width: 1200, height: 800 });
  const body = makeNode('body', { x: 0, y: 0, width: 1200, height: 800 });
  const rootRect = fullPageContainer
    ? { x: 0, y: 0, width: 1200, height: 800 }
    : { x: 300, y: 180, width: 600, height: 300 };
  const root = makeNode(htmlForm ? 'form' : 'div', rootRect);
  const input = makeNode('input', { x: 400, y: 250, width: 220, height: 32 }, {
    type: inputType, value: '', maxLength: 80,
  });
  const button = makeNode('button', { x: 650, y: 250, width: 90, height: 32 }, {
    textContent: 'Create', disabled: false,
  });
  if (textInput) {
    root.children.push(input);
    input.parentElement = root;
  }
  if (createButton) {
    root.children.push(button);
    button.parentElement = root;
  }
  if (extraTextInput) {
    const extra = makeNode('input', { x: 20, y: 20, width: 100, height: 24 }, { type: 'text', value: '', maxLength: 80 });
    body.children.push(extra);
    extra.parentElement = body;
  }
  body.children.push(root);
  root.parentElement = body;
  html.children.push(body);
  body.parentElement = html;
  return {
    document: {
      body,
      documentElement: html,
      querySelectorAll: (selector) => collect(html).filter((node) => matchesSelector(node, selector)),
    },
    window: { innerWidth: 1200, innerHeight: 800 },
  };
}

async function runReadOnlyCreateFormPreflight(inputMaxLength, rootKind = 'dialog') {
  let inventoryCloseCount = 0;
  let temporaryTargetCloseCount = 0;
  let pressedClicks = 0;
  const formState = {
    rootKind,
    inputCount: 1,
    inputValue: '',
    inputCoords: { x: 20, y: 20 },
    createButtonCount: 1,
    createCoords: { x: 30, y: 30 },
  };
  if (inputMaxLength !== undefined) formState.inputMaxLength = inputMaxLength;
  const page = {
    Runtime: {
      evaluate: async ({ expression }) => {
        if (expression === ACCOUNT_LAYOUT_PROBE) {
          return { result: { value: {
            authenticated: true,
            account_subject_sha256: ACCOUNT_HASH,
            layouts: [],
            chart_uid: null,
          } } };
        }
        if (expression.includes('V5_CREATE_LAYOUT_FORM_PROBE')) return { result: { value: formState } };
        if (expression.includes('save-load-menu') || expression.includes('Create new layout')) {
          return { result: { value: { x: 10, y: 10 } } };
        }
        if (expression.includes("querySelectorAll('[role=\"dialog\"]')")) {
          return { result: { value: expression.includes('input[type=\"text\"]')
            ? formState
            : 1 } };
        }
        return { result: { value: null } };
      },
    },
    close: async () => { inventoryCloseCount += 1; },
  };
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => ({ ...inventory([]), page }),
    openTemporaryChartTarget: async () => ({
      target: { id: 'fresh-generic-target', type: 'page', url: 'https://www.tradingview.com/chart/' },
      page,
      close: async () => { temporaryTargetCloseCount += 1; },
    }),
    dispatchMouseEvent: async (event) => { if (event.type === 'mousePressed') pressedClicks += 1; },
    dispatchKeyEvent: async () => {},
    sleep: async () => {},
  });
  return { result, inventoryCloseCount, temporaryTargetCloseCount, pressedClicks };
}

async function runMissingDialogDiagnostic(state) {
  let menuClicks = 0;
  let escapeCount = 0;
  let temporaryTargetCloseCount = 0;
  const page = {
    Runtime: {
      evaluate: async ({ expression }) => {
        if (expression === ACCOUNT_LAYOUT_PROBE) {
          return { result: { value: {
            authenticated: true,
            account_subject_sha256: ACCOUNT_HASH,
            layouts: [],
            chart_uid: null,
          } } };
        }
        if (expression.includes('createActionCount')) return { result: { value: state } };
        if (expression.includes('querySelectorAll(\'[role="dialog"]\')')) return { result: { value: 0 } };
        if (expression.includes('save-load-menu') || expression.includes('Create new layout')) {
          return { result: { value: { x: 10, y: 10 } } };
        }
        return { result: { value: null } };
      },
    },
  };
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => inventory([]),
    openTemporaryChartTarget: async () => ({
      target: { id: 'fresh-generic-target', type: 'page', url: 'https://www.tradingview.com/chart/' },
      page,
      close: async () => { temporaryTargetCloseCount += 1; },
    }),
    dispatchMouseEvent: async (event) => { if (event.type === 'mousePressed') menuClicks += 1; },
    dispatchKeyEvent: async (event) => { if (event.type === 'keyDown') escapeCount += 1; },
    sleep: async () => {},
  });
  return { result, menuClicks, escapeCount, temporaryTargetCloseCount };
}

test('layout marker is deterministic, account-independent, and slot-specific', () => {
  assert.match(MARKER, /^V5OBS-A-[A-Za-z0-9_-]{32}$/u);
  assert.equal(savedChartLayoutMarker(INPUT.captureSlotId, INPUT.reconciliationKey), MARKER);
  assert.notEqual(savedChartLayoutMarker('v5-capture-slot-b', INPUT.reconciliationKey), MARKER);
  assert.notEqual(savedChartLayoutMarker(INPUT.captureSlotId, 'c'.repeat(64)), MARKER);
});

test('saved-layout probe fails closed instead of silently dropping malformed entries', async () => {
  const malformed = await runProbe([
    { id: 'good-layout-id', name: 'Good chart' },
    { id: '', name: 'Malformed chart' },
  ]);
  assert.equal(malformed.authenticated, true);
  assert.equal(malformed.layouts, null);

  const valid = await runProbe([{ id: 'good-layout-id', name: 'Good chart' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(valid.layouts)), [
    { layout_id: 'good-layout-id', name: 'Good chart', symbol: '', resolution: '' },
  ]);
});

test('read-only preflight reports current-account marker state and create availability', async () => {
  let menuProbeCount = 0;
  const layouts = [
    { layoutId: 'user-layout-id', name: 'User chart', symbol: 'BATS:META', resolution: '60' },
  ];
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => inventory(layouts),
    openTemporaryChartTarget: openPreflightProbeTarget(layouts),
    canCreateSavedLayout: async () => {
      menuProbeCount += 1;
      return { available: true, failureCode: null, inputCount: 1, inputMaxLength: -1 };
    },
  });

  assert.deepEqual(result, {
    success: true,
    preflight_version: 'saved-chart-authority-preflight-v1',
    profile_name: INPUT.profileName,
    capture_slot_id: INPUT.captureSlotId,
    reconciliation_key: INPUT.reconciliationKey,
    layout_marker: MARKER,
    authenticated: true,
    account_subject_sha256: ACCOUNT_HASH,
    action: 'not_found',
    match_count: 0,
    layout_count: 1,
    layout_inventory_sha256: createHash('sha256').update(JSON.stringify([
      { layoutId: 'user-layout-id', name: 'User chart', symbol: 'BATS:META', resolution: '60' },
    ])).digest('hex'),
    chart_target_count: 1,
    can_create: true,
    create_preflight_failure_code: null,
    create_marker_length: MARKER.length,
    create_input_count: 1,
    create_input_max_length: -1,
    failure_code: null,
  });
  assert.equal(menuProbeCount, 1);
});

test('create preflight uses a fresh generic chart target and closes it without touching existing chart', async () => {
  const existingPage = { close: async () => {} };
  const freshPage = preflightProbePage([]);
  let closeCount = 0;
  let createFormProbeCount = 0;
  const currentInventory = inventory([]);
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => ({ ...currentInventory, page: existingPage }),
    openTemporaryChartTarget: async (profile, _dependencies, targets) => {
      assert.equal(profile.profileId, INPUT.expectedProfileId);
      assert.deepEqual(targets, currentInventory.targets);
      return {
        target: { id: 'fresh-generic-target', type: 'page', url: 'https://www.tradingview.com/chart/' },
        page: freshPage,
        close: async () => { closeCount += 1; },
      };
    },
    canCreateSavedLayout: async (page) => {
      assert.equal(page, freshPage);
      createFormProbeCount += 1;
      return { available: true, failureCode: null, inputCount: 1, inputMaxLength: -1 };
    },
  });

  assert.equal(result.can_create, true);
  assert.equal(result.create_preflight_failure_code, null);
  assert.equal(createFormProbeCount, 1);
  assert.equal(closeCount, 1);
});

test('create preflight rejects fresh target when current-account layout inventory differs', async () => {
  const freshPage = preflightProbePage([
    { layoutId: 'unexpected-layout', name: 'Unexpected' },
  ]);
  let closeCount = 0;
  let createFormProbeCount = 0;
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => inventory([]),
    openTemporaryChartTarget: async () => ({
      target: { id: 'fresh-generic-target', type: 'page', url: 'https://www.tradingview.com/chart/' },
      page: freshPage,
      close: async () => { closeCount += 1; },
    }),
    canCreateSavedLayout: async () => {
      createFormProbeCount += 1;
      return { available: true, failureCode: null, inputCount: 1, inputMaxLength: -1 };
    },
  });

  assert.equal(result.can_create, false);
  assert.equal(result.create_preflight_failure_code, 'CREATE_PREFLIGHT_LAYOUT_INVENTORY_CHANGED');
  assert.equal(createFormProbeCount, 0);
  assert.equal(closeCount, 1);
});

test('missing create dialog reports bounded menu and modal structure diagnostics', async (t) => {
  const cases = [
    [{ dialogCount: 0, modalCount: 0, createActionCount: 1, textInputCount: 0, createButtonCount: 0 },
      'CREATE_LAYOUT_ACTION_STILL_VISIBLE'],
    [{ dialogCount: 0, modalCount: 1, createActionCount: 0, textInputCount: 1, createButtonCount: 1 },
      'CREATE_LAYOUT_DIALOG_ROLE_CHANGED'],
    [{ dialogCount: 0, modalCount: 0, createActionCount: 0, textInputCount: 1, createButtonCount: 0 },
      'CREATE_LAYOUT_FORM_OUTSIDE_DIALOG'],
  ];
  for (const [state, expectedFailureCode] of cases) {
    await t.test(expectedFailureCode, async () => {
      const { result, menuClicks, escapeCount, temporaryTargetCloseCount } = await runMissingDialogDiagnostic(state);
      assert.equal(result.can_create, false);
      assert.equal(result.create_preflight_failure_code, expectedFailureCode);
      assert.equal(menuClicks, 2);
      assert.equal(escapeCount, 1);
      assert.equal(temporaryTargetCloseCount, 1);
    });
  }
});

test('create preflight fails closed when disposable chart target cannot be closed', async () => {
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => inventory([]),
    openTemporaryChartTarget: openPreflightProbeTarget([], async () => {
      throw new Error('temporary target close failed');
    }),
    canCreateSavedLayout: async () => ({
      available: true,
      failureCode: null,
      inputCount: 1,
      inputMaxLength: -1,
    }),
  });

  assert.equal(result.can_create, false);
  assert.equal(result.create_preflight_failure_code, 'CREATE_PREFLIGHT_TARGET_CLOSE_UNCONFIRMED');
});

test('read-only preflight diagnoses a marker length limit before any saved-chart create click', async () => {
  const { result, inventoryCloseCount, temporaryTargetCloseCount, pressedClicks } = await runReadOnlyCreateFormPreflight(32);

  assert.equal(result.can_create, false);
  assert.equal(result.create_preflight_failure_code, 'CREATE_LAYOUT_MARKER_EXCEEDS_INPUT_LIMIT');
  assert.equal(result.create_marker_length, MARKER.length);
  assert.equal(result.create_input_count, 1);
  assert.equal(result.create_input_max_length, 32);
  assert.equal(pressedClicks, 2, 'preflight may open menu and dialog, but must not click Create');
  assert.equal(inventoryCloseCount, 1);
  assert.equal(temporaryTargetCloseCount, 1);
});

test('read-only preflight fails closed on missing input maxLength before chart-create claim', async () => {
  const { result, inventoryCloseCount, temporaryTargetCloseCount, pressedClicks } = await runReadOnlyCreateFormPreflight(undefined);

  assert.equal(result.can_create, false);
  assert.equal(result.create_preflight_failure_code, 'CREATE_LAYOUT_INPUT_MAX_LENGTH_INVALID');
  assert.equal(result.create_input_count, 1);
  assert.equal(result.create_input_max_length, null);
  assert.equal(pressedClicks, 2, 'preflight must stop before clicking Create');
  assert.equal(inventoryCloseCount, 1);
  assert.equal(temporaryTargetCloseCount, 1);
});

test('read-only preflight accepts one unique create form outside role=dialog without clicking Create', async () => {
  const { result, inventoryCloseCount, temporaryTargetCloseCount, pressedClicks } =
    await runReadOnlyCreateFormPreflight(-1, 'shared-container');

  assert.equal(result.can_create, true);
  assert.equal(result.create_preflight_failure_code, null);
  assert.equal(result.create_input_count, 1);
  assert.equal(result.create_input_max_length, -1);
  assert.equal(pressedClicks, 2, 'preflight may open the menu and form but must not click Create');
  assert.equal(inventoryCloseCount, 1);
  assert.equal(temporaryTargetCloseCount, 1);
});

test('form probe accepts only unique fields inside one bounded non-dialog container', async (t) => {
  const assertPreflight = async (dom, expectedCanCreate, expectedFailureCode = null) => {
    const result = await preflightSavedChartAuthority(INPUT, {
      readProfileInventory: async () => inventory([]),
      openTemporaryChartTarget: async () => ({
        target: { id: 'fresh-generic-target', type: 'page', url: 'https://www.tradingview.com/chart/' },
        page: {
          Runtime: {
            evaluate: async ({ expression }) => {
              if (expression === ACCOUNT_LAYOUT_PROBE) return { result: { value: {
                authenticated: true, account_subject_sha256: ACCOUNT_HASH, layouts: [], chart_uid: null,
              } } };
              if (expression.includes('V5_CREATE_LAYOUT_FORM_PROBE')) {
                return { result: { value: vm.runInNewContext(expression, dom) } };
              }
              if (expression.includes('createActionCount')) return { result: { value: {
                dialogCount: 0, modalCount: 0, createActionCount: 0, textInputCount: 1, createButtonCount: 1,
              } } };
              if (expression.includes('save-load-menu') || expression.includes('Create new layout')) {
                return { result: { value: { x: 10, y: 10 } } };
              }
              return { result: { value: null } };
            },
          },
        },
        close: async () => {},
      }),
      dispatchMouseEvent: async () => {},
      dispatchKeyEvent: async () => {},
      sleep: async () => {},
    });

    assert.equal(result.can_create, expectedCanCreate);
    assert.equal(result.create_preflight_failure_code, expectedFailureCode);
    if (!expectedCanCreate) return;
    assert.equal(result.create_input_count, 1);
    assert.equal(result.create_input_max_length, 80);
  };

  await t.test('unique input and Create button share bounded container', async () => {
    await assertPreflight(createLayoutFormDom(), true);
  });

  await t.test('one bounded HTML form with exact fields is accepted', async () => {
    await assertPreflight(createLayoutFormDom({ htmlForm: true }), true);
  });

  await t.test('ambiguous global field or full-page root remains fail-closed', async (t) => {
    const cases = [
      { name: 'multiple visible text fields', dom: createLayoutFormDom({ extraTextInput: true }),
        code: 'CREATE_LAYOUT_NON_DIALOG_TEXT_INPUT_AMBIGUOUS' },
      { name: 'missing visible text field', dom: createLayoutFormDom({ textInput: false }),
        code: 'CREATE_LAYOUT_NON_DIALOG_TEXT_INPUT_MISSING' },
      { name: 'non-text input stays unrecognized', dom: createLayoutFormDom({ inputType: 'search' }),
        code: 'CREATE_LAYOUT_NON_DIALOG_TEXT_INPUT_MISSING' },
      { name: 'missing exact Create button', dom: createLayoutFormDom({ createButton: false }),
        code: 'CREATE_LAYOUT_NON_DIALOG_BUTTON_COUNT_NOT_ONE' },
      { name: 'full-page common root', dom: createLayoutFormDom({ fullPageContainer: true }),
        code: 'CREATE_LAYOUT_SHARED_ROOT_TOO_LARGE' },
      { name: 'full-page HTML form', dom: createLayoutFormDom({ fullPageContainer: true, htmlForm: true }),
        code: 'CREATE_LAYOUT_FORM_ROOT_TOO_LARGE' },
    ];
    for (const { name, dom, code } of cases) {
      await t.test(name, async () => {
        await assertPreflight(dom, false, code);
      });
    }
  });
});

test('preflight refuses stale profile UUID before reporting create capability', async () => {
  let inventoryCloseCount = 0;
  const result = await preflightSavedChartAuthority(INPUT, {
    readProfileInventory: async () => ({
      ...inventory([]),
      profile: { ...inventory([]).profile, profileId: 'replacement-id' },
      temporaryTargetCreated: true,
      close: async () => { inventoryCloseCount += 1; },
    }),
    canCreateSavedLayout: async () => assert.fail('must not inspect create UI after UUID mismatch'),
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.can_create, false);
  assert.equal(result.failure_code, 'PROFILE_UUID_CHANGED_BEFORE_PREFLIGHT');
  assert.equal(inventoryCloseCount, 1);
});

test('ensure closes stale-profile inventory before returning without creating', async () => {
  let inventoryCloseCount = 0;
  let createCount = 0;
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    readProfileInventory: async () => ({
      ...inventory([]),
      profile: { ...inventory([]).profile, profileId: 'replacement-id' },
      temporaryTargetCreated: true,
      close: async () => { inventoryCloseCount += 1; },
    }),
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'unknown');
  assert.equal(result.failure_code, 'PROFILE_UUID_CHANGED_BEFORE_ENSURE');
  assert.equal(result.mutations_performed, false);
  assert.equal(result.temporary_target_closed, true);
  assert.equal(inventoryCloseCount, 1);
  assert.equal(createCount, 0);
});

test('profile UUID mismatch reports failed temporary-target cleanup in both endpoints', async (t) => {
  await t.test('preflight', async () => {
    let closeCount = 0;
    const result = await preflightSavedChartAuthority(INPUT, {
      readProfileInventory: async () => ({
        ...inventory([]),
        profile: { ...inventory([]).profile, profileId: 'replacement-id' },
        temporaryTargetCreated: true,
        close: async () => { closeCount += 1; throw new Error('close unconfirmed'); },
      }),
      canCreateSavedLayout: async () => assert.fail('must not inspect create UI after UUID mismatch'),
    });

    assert.equal(result.can_create, false);
    assert.equal(result.failure_code, 'PROFILE_INVENTORY_TEMPORARY_TARGET_CLOSE_UNCONFIRMED');
    assert.equal(closeCount, 1);
  });

  await t.test('ensure', async () => {
    let closeCount = 0;
    let createCount = 0;
    const result = await ensureSavedChartAuthority({
      ...INPUT,
      expectedAccountSubjectSha256: ACCOUNT_HASH,
      createIfAbsent: true,
    }, {
      readProfileInventory: async () => ({
        ...inventory([]),
        profile: { ...inventory([]).profile, profileId: 'replacement-id' },
        temporaryTargetCreated: true,
        close: async () => { closeCount += 1; throw new Error('close unconfirmed'); },
      }),
      createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
    });

    assert.equal(result.action, 'unknown');
    assert.equal(result.failure_code, 'PROFILE_INVENTORY_TEMPORARY_TARGET_CLOSE_UNCONFIRMED');
    assert.equal(result.mutations_performed, false);
    assert.equal(result.temporary_target_closed, false);
    assert.equal(closeCount, 1);
    assert.equal(createCount, 0);
  });
});

test('default profile inventory marks verified current-account tabs authenticated', async () => {
  const target = {
    id: 'ephemeral-chart-target',
    type: 'page',
    url: 'https://www.tradingview.com/chart/current-route-uid/',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/ephemeral-chart-target',
  };
  const page = {
    Runtime: {
      enable: async () => {},
      evaluate: async () => ({ result: { value: {
        authenticated: true,
        account_subject_sha256: ACCOUNT_HASH,
        layouts: [{ layout_id: 'current-account-layout', name: 'Current chart' }],
        chart_uid: 'current-route-uid',
      } } }),
    },
    Page: { enable: async () => {} },
    close: async () => {},
  };
  const result = await preflightSavedChartAuthority({
    ...INPUT,
    expectedProfileId: undefined,
  }, {
    managerBaseUrl: 'http://manager.test/api',
    fetch: async (url) => ({
      ok: true,
      json: async () => String(url).endsWith('/profiles')
        ? [{ id: INPUT.expectedProfileId, name: INPUT.profileName, status: 'running' }]
        : [target],
    }),
    connectTarget: async () => page,
    openTemporaryChartTarget: openPreflightProbeTarget([
      { layoutId: 'current-account-layout', name: 'Current chart' },
    ]),
    canCreateSavedLayout: async () => ({
      available: false,
      failureCode: 'CREATE_LAYOUT_MENU_NOT_AVAILABLE',
      inputCount: null,
      inputMaxLength: null,
    }),
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.account_subject_sha256, ACCOUNT_HASH);
  assert.equal(result.layout_count, 1);
  assert.equal(result.chart_target_count, 1);
  assert.equal(result.failure_code, null);
});

test('cold profile preflight opens one exact-profile chart tab, reads current account, and closes it', async () => {
  const cdpUrl = 'http://127.0.0.1:9222/profiles/ephemeral-manager-id/cdp';
  let targets = [];
  let createCount = 0;
  let navigateCount = 0;
  let closeCount = 0;
  const page = {
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }) => ({ result: { value: expression.includes('location.href')
        ? { url: 'about:blank' }
        : {
          authenticated: true,
          account_subject_sha256: ACCOUNT_HASH,
          layouts: [{ layout_id: 'new-account-layout', name: 'Current account chart' }],
          chart_uid: null,
        } } }),
    },
    Page: {
      enable: async () => {},
      navigate: async ({ url }) => {
        navigateCount += 1;
        targets = targets.map((target) => ({ ...target, url }));
        return {};
      },
    },
    close: async () => { closeCount += 1; },
  };
  const browser = {
    Target: {
      createTarget: async ({ url }) => {
        assert.equal(url, 'about:blank');
        createCount += 1;
        const id = 'temporary-current-profile-target';
        targets = [{
          id,
          type: 'page',
          url,
          webSocketDebuggerUrl: `${cdpUrl}/devtools/page/${id}`,
        }];
        return { targetId: id };
      },
      closeTarget: async ({ targetId }) => {
        targets = targets.filter((target) => target.id !== targetId);
        return { success: true };
      },
    },
    close: async () => {},
  };
  const result = await preflightSavedChartAuthority({ ...INPUT, expectedProfileId: undefined }, {
    managerBaseUrl: 'http://manager.test/api',
    fetch: async (value) => {
      const url = String(value);
      const body = url.endsWith('/profiles')
        ? [{ id: INPUT.expectedProfileId, name: INPUT.profileName, status: 'running', cdp_url: cdpUrl }]
        : url.endsWith('/json/version')
          ? { webSocketDebuggerUrl: `ws://127.0.0.1:9222/profiles/${INPUT.expectedProfileId}/cdp` }
          : targets;
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => browser,
    connectTarget: async () => page,
    openTemporaryChartTarget: openPreflightProbeTarget([
      { layoutId: 'new-account-layout', name: 'Current account chart' },
    ]),
    canCreateSavedLayout: async () => ({ available: true, failureCode: null, inputCount: 1, inputMaxLength: -1 }),
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.chart_target_count, 1);
  assert.equal(result.can_create, true);
  assert.equal(createCount, 1);
  assert.equal(navigateCount, 1);
  assert.equal(closeCount, 1);
  assert.deepEqual(targets, []);
});

test('cold profile discovers saved layouts with a blank tab while preserving that tab', async () => {
  const cdpUrl = 'http://127.0.0.1:9222/profiles/ephemeral-manager-id/cdp';
  const blankTarget = { id: 'existing-blank', type: 'page', url: 'about:blank' };
  const temporaryTargetId = 'temporary-inventory-target';
  let targets = [blankTarget];
  let createCount = 0;
  let navigateCount = 0;
  let targetCloseCount = 0;
  let pageCloseCount = 0;
  const page = {
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }) => ({ result: { value: expression.includes('location.href')
        ? { url: 'about:blank' }
        : {
          authenticated: true,
          account_subject_sha256: ACCOUNT_HASH,
          layouts: [{ layout_id: 'current-account-layout', name: MARKER }],
          chart_uid: null,
        } } }),
    },
    Page: {
      enable: async () => {},
      navigate: async ({ url }) => {
        navigateCount += 1;
        targets = targets.map((target) => target.id === temporaryTargetId ? { ...target, url } : target);
        return {};
      },
    },
    close: async () => { pageCloseCount += 1; },
  };
  const browser = {
    Target: {
      createTarget: async ({ url }) => {
        assert.equal(url, 'about:blank');
        createCount += 1;
        targets = [...targets, {
          id: temporaryTargetId,
          type: 'page',
          url,
          webSocketDebuggerUrl: `${cdpUrl}/devtools/page/${temporaryTargetId}`,
        }];
        return { targetId: temporaryTargetId };
      },
      closeTarget: async ({ targetId }) => {
        assert.equal(targetId, temporaryTargetId);
        targetCloseCount += 1;
        targets = targets.filter((target) => target.id !== targetId);
        return { success: true };
      },
    },
    close: async () => {},
  };
  const result = await preflightSavedChartAuthority({ ...INPUT, expectedProfileId: undefined }, {
    managerBaseUrl: 'http://manager.test/api',
    fetch: async (value) => {
      const url = String(value);
      const body = url.endsWith('/profiles')
        ? [{ id: INPUT.expectedProfileId, name: INPUT.profileName, status: 'running', cdp_url: cdpUrl }]
        : url.endsWith('/json/version')
          ? { webSocketDebuggerUrl: `ws://127.0.0.1:9222/profiles/${INPUT.expectedProfileId}/cdp` }
          : targets;
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => browser,
    connectTarget: async () => page,
    sleep: async () => {},
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.layout_count, 1);
  assert.equal(result.chart_target_count, 1);
  assert.equal(result.failure_code, null);
  assert.equal(result.can_create, false);
  assert.equal(createCount, 1);
  assert.equal(navigateCount, 1);
  assert.equal(targetCloseCount, 1);
  assert.equal(pageCloseCount, 1);
  assert.deepEqual(targets, [blankTarget]);
});

test('existing exact marker is mapped to verified route UID without any new saved-layout mutation', async () => {
  let createCount = 0;
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    readProfileInventory: async () => inventory([{ layoutId: 'internal-layout-id', name: MARKER }]),
    resolveSavedLayoutRoute: async (_profileName, _profileId, layout) => {
      assert.equal(layout.layoutId, 'internal-layout-id');
      return { chartId: 'saved-route-uid', temporaryTargetClosed: true };
    },
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'reused');
  assert.equal(result.saved_chart_id, 'saved-route-uid');
  assert.equal(result.canonical_chart_url, 'https://www.tradingview.com/chart/saved-route-uid/');
  assert.equal(result.mutations_performed, false);
  assert.equal(result.create_if_absent, true);
  assert.equal(createCount, 0);
});

test('exact-marker route discovery preserves failed temporary-target close evidence', async () => {
  const resolverError = new Error('DISCOVERED_LAYOUT_ROUTE_ID_NOT_PROVEN');
  resolverError.temporaryTargetClosed = false;
  let createCount = 0;
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    readProfileInventory: async () => inventory([
      { layoutId: 'existing-layout', name: MARKER, symbol: '', resolution: '' },
    ]),
    resolveSavedLayoutRoute: async () => { throw resolverError; },
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'unknown');
  assert.equal(result.failure_code, 'DISCOVERED_LAYOUT_ROUTE_ID_NOT_PROVEN');
  assert.equal(result.temporary_target_closed, false);
  assert.equal(result.mutations_performed, false);
  assert.equal(result.match_count, 1);
  assert.equal(createCount, 0);
});

test('slot B create resolves Slot A independently and rejects unsafe discovery states', async (t) => {
  const runCreate = async ({ createdChartUid, sourceTargetClosed = true, useDefaultResolver = false,
    sourceTargetCloseSucceeds = true, resolverLoadFails = false }) => {
    const cdpUrl = 'http://127.0.0.1:9222/profiles/ephemeral-manager-id/cdp';
    const browserWebSocketUrl = 'ws://127.0.0.1:9222/profiles/ephemeral-manager-id/cdp';
    const slotAMarker = savedChartLayoutMarker('v5-capture-slot-a', 'a'.repeat(64));
    const slotBInput = {
      ...INPUT,
      captureSlotId: 'v5-capture-slot-b',
      reconciliationKey: 'c'.repeat(64),
      expectedAccountSubjectSha256: ACCOUNT_HASH,
      createIfAbsent: true,
    };
    const slotBMarker = savedChartLayoutMarker(slotBInput.captureSlotId, slotBInput.reconciliationKey);
    const layouts = [{ layoutId: 'slot-a-layout', name: slotAMarker, symbol: '', resolution: '' }];
    let pageUrl = 'about:blank';
    let chartUid = null;
    let loadedSlotA = false;
    let sourceResolutionCount = 0;
    let createClickCount = 0;
    let targetCreateCount = 0;
    const createdTargets = new Map();
    let inputValue = '';
    const accountProbe = () => ({
      authenticated: true,
      account_subject_sha256: ACCOUNT_HASH,
      layouts: layouts.map(({ layoutId, name, symbol, resolution }) => ({
        layout_id: layoutId, name, symbol, resolution,
      })),
      chart_uid: chartUid,
    });
    const page = {
      Runtime: {
        enable: async () => {},
        evaluate: async ({ expression }) => {
          if (expression === ACCOUNT_LAYOUT_PROBE) return { result: { value: accountProbe() } };
          if (expression.includes('location.href')) return { result: { value: { url: pageUrl } } };
          if (expression.includes('loadChartFromServer')) {
            if (resolverLoadFails) return { result: { value: { ok: false } } };
            loadedSlotA = true;
            chartUid = 'slot-a-route-uid';
            return { result: { value: { ok: true } } };
          }
          if (expression.includes('V5_CREATE_LAYOUT_FORM_PROBE')) {
            return { result: { value: {
              rootKind: 'dialog', failureCode: null, inputCount: 1, inputMaxLength: 80,
              inputValue, inputCoords: { x: 30, y: 30 }, createButtonCount: 1,
              createButtonEnabled: true, createCoords: { x: 40, y: 40 },
            } } };
          }
          if (expression.includes('save-load-menu')) return { result: { value: { x: 10, y: 10 } } };
          if (expression.includes('Create new layout')) return { result: { value: { x: 20, y: 20 } } };
          return { result: { value: null } };
        },
      },
      Page: {
        enable: async () => {},
        navigate: async ({ url }) => { pageUrl = url; chartUid = null; return {}; },
      },
      close: async () => {},
    };
    const browser = {
      Target: {
        createTarget: async ({ url }) => {
          targetCreateCount += 1;
          const id = targetCreateCount === 1 ? 'slot-b-create-target' : 'slot-a-discovery-target';
          createdTargets.set(id, {
            id, type: 'page', url,
            webSocketDebuggerUrl: `${browserWebSocketUrl}/devtools/page/${id}`,
          });
          return { targetId: id };
        },
        closeTarget: async ({ targetId }) => {
          if (targetId === 'slot-a-discovery-target' && !sourceTargetCloseSucceeds) {
            return { success: false };
          }
          createdTargets.delete(targetId);
          return { success: true };
        },
      },
      close: async () => {},
    };
    const result = await ensureSavedChartAuthority(slotBInput, {
      managerBaseUrl: 'http://manager.test/api',
      fetch: async (value) => {
        const url = new URL(String(value));
        let body;
        if (url.pathname === '/api/profiles') {
          body = [{ name: INPUT.profileName, id: INPUT.expectedProfileId, status: 'running', cdp_url: cdpUrl }];
        } else if (url.pathname.endsWith('/json/version')) {
          body = { webSocketDebuggerUrl: browserWebSocketUrl };
        } else if (url.pathname.endsWith('/json/list')) {
          body = [...createdTargets.values()];
        } else {
          throw new Error(`unexpected URL ${url}`);
        }
        return { ok: true, json: async () => body };
      },
      connectBrowser: async () => browser,
      connectTarget: async () => page,
      readProfileInventory: async () => inventory(layouts.map((layout) => ({ ...layout }))),
      ...(useDefaultResolver ? {} : {
        resolveSavedLayoutRoute: async (profileName, profileId, layout, accountHash) => {
          sourceResolutionCount += 1;
          assert.equal(profileName, INPUT.profileName);
          assert.equal(profileId, INPUT.expectedProfileId);
          assert.equal(layout.layoutId, 'slot-a-layout');
          assert.equal(layout.name, slotAMarker);
          assert.equal(accountHash, ACCOUNT_HASH);
          return { chartId: 'slot-a-route-uid', temporaryTargetClosed: sourceTargetClosed };
        },
      }),
      dispatchMouseEvent: async (event) => {
        if (event.type === 'mouseReleased' && event.x === 40 && event.y === 40) {
          createClickCount += 1;
          chartUid = createdChartUid;
          pageUrl = `https://www.tradingview.com/chart/${chartUid}/`;
          layouts.push({ layoutId: 'slot-b-layout', name: slotBMarker, symbol: '', resolution: '' });
        }
      },
      insertText: async (text) => { inputValue = text; },
      sleep: async () => {},
    });
    return { result, loadedSlotA, sourceResolutionCount, createClickCount, targetCreateCount, layouts,
      slotAMarker, slotBMarker };
  };

  await t.test('distinct route is accepted without loading Slot A into Slot B target', async () => {
    const proof = await runCreate({ createdChartUid: 'fresh-slot-b-route-uid' });
    assert.equal(proof.result.action, 'created', proof.result.failure_code ?? undefined);
    assert.equal(proof.result.saved_chart_id, 'fresh-slot-b-route-uid');
    assert.equal(proof.result.mutations_performed, true);
    assert.equal(proof.loadedSlotA, false);
    assert.equal(proof.sourceResolutionCount, 1);
    assert.equal(proof.createClickCount, 1);
    assert.deepEqual(proof.layouts.map(({ layoutId, name }) => ({ layoutId, name })), [
      { layoutId: 'slot-a-layout', name: proof.slotAMarker },
      { layoutId: 'slot-b-layout', name: proof.slotBMarker },
    ]);
  });

  await t.test('same route fails closed after exactly one create attempt', async () => {
    const proof = await runCreate({ createdChartUid: 'slot-a-route-uid' });
    assert.equal(proof.result.action, 'unknown');
    assert.equal(proof.result.failure_code, 'NEW_SAVED_CHART_ROUTE_ID_NOT_PROVEN');
    assert.equal(proof.result.mutations_performed, true);
    assert.equal(proof.loadedSlotA, false);
    assert.equal(proof.sourceResolutionCount, 1);
    assert.equal(proof.createClickCount, 1);
  });

  await t.test('unconfirmed Slot A discovery close is reported and prevents create', async () => {
    const proof = await runCreate({ createdChartUid: 'unused-route', sourceTargetClosed: false });
    assert.equal(proof.result.action, 'unknown');
    assert.equal(proof.result.failure_code, 'SLOT_A_SOURCE_TARGET_CLOSE_UNCONFIRMED');
    assert.equal(proof.result.temporary_target_closed, false);
    assert.equal(proof.result.mutations_performed, false);
    assert.equal(proof.loadedSlotA, false);
    assert.equal(proof.sourceResolutionCount, 1);
    assert.equal(proof.createClickCount, 0);
    assert.equal(proof.layouts.length, 1);
  });

  await t.test('resolver error plus failed target close reports false and prevents create', async () => {
    const proof = await runCreate({
      createdChartUid: 'unused-route', useDefaultResolver: true,
      sourceTargetCloseSucceeds: false, resolverLoadFails: true,
    });
    assert.equal(proof.result.action, 'unknown');
    assert.equal(proof.result.failure_code, 'SAVED_LAYOUT_LOAD_API_UNAVAILABLE');
    assert.equal(proof.result.temporary_target_closed, false);
    assert.equal(proof.result.mutations_performed, false);
    assert.equal(proof.loadedSlotA, false);
    assert.equal(proof.createClickCount, 0);
    assert.equal(proof.targetCreateCount, 2);
    assert.equal(proof.layouts.length, 1);
  });
});

test('one-shot create reports exact saved chart UID and preserves unknown outcome for discovery-only retry', async () => {
  let createCount = 0;
  const createDependencies = {
    readProfileInventory: async () => inventory([]),
    createSavedLayout: async (_profileName, _profileId, _slot, marker, _prior, _deps, onAttempt) => {
      assert.equal(marker, MARKER);
      createCount += 1;
      onAttempt();
      return { chartId: 'fresh-chart-uid', temporaryTargetClosed: true };
    },
  };
  const request = { ...INPUT, expectedAccountSubjectSha256: ACCOUNT_HASH, createIfAbsent: true };
  const created = await ensureSavedChartAuthority(request, createDependencies);
  assert.equal(created.action, 'created');
  assert.equal(created.saved_chart_id, 'fresh-chart-uid');
  assert.equal(created.mutations_performed, true);
  assert.equal(created.create_if_absent, true);
  assert.equal(createCount, 1);

  const ambiguous = await ensureSavedChartAuthority(request, {
    readProfileInventory: async () => inventory([]),
    createSavedLayout: async (_profileName, _profileId, _slot, _marker, _prior, _deps, onAttempt) => {
      createCount += 1;
      onAttempt();
      throw new Error('SAVED_CHART_CREATE_OR_DISCOVERY_NOT_CONFIRMED');
    },
  });
  assert.equal(ambiguous.action, 'unknown');
  assert.equal(ambiguous.mutations_performed, true);
  assert.equal(ambiguous.create_if_absent, true);
  assert.equal(createCount, 2);
});

test('read-inventory WebSocket failure returns safe actionable code before any saved-chart mutation', async () => {
  let createCount = 0;
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    readProfileInventory: async () => { throw new Error('WebSocket is not open'); },
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'unknown');
  assert.equal(result.failure_code, 'CDP_WEBSOCKET_NOT_OPEN');
  assert.equal(result.account_subject_sha256, null);
  assert.equal(result.mutations_performed, false);
  assert.equal(result.temporary_target_closed, true);
  assert.equal(createCount, 0);
});

test('inventory WebSocket failure with unconfirmed temporary-target close cannot claim cleanup', async () => {
  const profileId = INPUT.expectedProfileId;
  const cdpUrl = `http://127.0.0.1:1234/api/profiles/${profileId}/cdp`;
  const browserWebSocketUrl = `ws://127.0.0.1:1234/api/profiles/${profileId}/cdp`;
  const targetWebSocketUrl = `${browserWebSocketUrl}/devtools/page/inventory`;
  let targetCreated = false;
  let createCount = 0;
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    managerBaseUrl: 'http://127.0.0.1:8080',
    fetch: async (input) => {
      const url = new URL(String(input));
      let body;
      if (url.pathname === '/profiles') {
        body = [{ name: INPUT.profileName, id: profileId, status: 'running', cdp_url: cdpUrl }];
      } else if (url.pathname.endsWith('/json/version')) {
        body = { webSocketDebuggerUrl: browserWebSocketUrl };
      } else if (url.pathname.endsWith('/json/list')) {
        body = targetCreated
          ? [{ id: 'inventory', type: 'page', url: 'about:blank', webSocketDebuggerUrl: targetWebSocketUrl }]
          : [];
      } else {
        throw new Error(`unexpected URL ${url}`);
      }
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => ({
      Target: {
        createTarget: async () => { targetCreated = true; return { targetId: 'inventory' }; },
        closeTarget: async () => ({ success: false }),
      },
      close: async () => {},
    }),
    connectTarget: async () => { throw new Error('WebSocket is not open'); },
    sleep: async () => {},
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'unknown');
  assert.equal(result.failure_code, 'CDP_WEBSOCKET_NOT_OPEN');
  assert.equal(result.mutations_performed, false);
  assert.equal(result.temporary_target_closed, false);
  assert.equal(createCount, 0);
});

test('unrecognized lower-case provider errors never collapse into misleading partial codes', async () => {
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    readProfileInventory: async () => { throw new Error('unexpected provider details'); },
  });

  assert.equal(result.action, 'unknown');
  assert.equal(result.failure_code, 'PROVIDER_OPERATION_FAILED');
  assert.equal(result.mutations_performed, false);
});

test('discovery-only result echoes false create authority and never creates a chart', async () => {
  let createCount = 0;
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: false,
  }, {
    readProfileInventory: async () => inventory([]),
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'not_found');
  assert.equal(result.create_if_absent, false);
  assert.equal(result.mutations_performed, false);
  assert.equal(createCount, 0);
});

test('account switch and duplicate marker fail closed without create retry', async () => {
  const switched = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, { readProfileInventory: async () => ({ ...inventory([]), accountSubjectSha256: 'c'.repeat(64) }) });
  assert.equal(switched.action, 'unknown');
  assert.equal(switched.failure_code, 'ACCOUNT_IDENTITY_CHANGED');

  let creates = 0;
  const multiple = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    readProfileInventory: async () => inventory([
      { layoutId: 'one', name: MARKER },
      { layoutId: 'two', name: MARKER },
    ]),
    createSavedLayout: async () => { creates += 1; throw new Error('must not create'); },
  });
  assert.equal(multiple.action, 'multiple');
  assert.equal(multiple.mutations_performed, false);
  assert.equal(creates, 0);
});
