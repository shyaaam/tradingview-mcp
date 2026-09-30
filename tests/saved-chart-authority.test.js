import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { TextEncoder } from 'node:util';

import {
  ACTIVE_SAVED_LAYOUT_PROBE,
  ACCOUNT_LAYOUT_PROBE,
  ensureSavedChartAuthority,
  hydrateSavedChartLayout,
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

async function runProbe(charts, { activeLayoutId = '', activeLayoutName = '' } = {}) {
  const window = {
    TradingViewApi: {
      _user: { id: 'current-account' },
      _chartWidgetCollection: { metaInfo: { id: activeLayoutId, name: activeLayoutName } },
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
    loadedTargets: [],
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
  assert.equal(valid.active_saved_layout_id, null);
  assert.equal(valid.active_saved_layout_name, null);
});

test('saved-layout probe keeps active server ID distinct from non-unique route UID', async () => {
  const probe = await runProbe(
    [{ id: '206000778', name: MARKER }],
    { activeLayoutId: '206000778', activeLayoutName: MARKER },
  );
  assert.equal(probe.chart_uid, 'current-route-uid');
  assert.equal(probe.active_saved_layout_id, '206000778');
  assert.equal(probe.active_saved_layout_name, MARKER);
});

test('active saved-layout poll avoids saved-layout inventory callback', async () => {
  let inventoryReadCount = 0;
  const window = {
    TradingViewApi: {
      _user: { id: 'current-account' },
      _chartWidgetCollection: { metaInfo: { id: '206000778', name: MARKER } },
      getSavedCharts() { inventoryReadCount += 1; throw new Error('inventory must not be polled'); },
    },
    crypto: { subtle: { digest: async () => new Uint8Array(32).buffer } },
    location: { pathname: '/chart/current-route-uid/', href: 'https://www.tradingview.com/chart/current-route-uid/' },
  };

  const probe = await vm.runInNewContext(ACTIVE_SAVED_LAYOUT_PROBE, { window, TextEncoder });

  assert.equal(probe.authenticated, true);
  assert.equal(probe.active_saved_layout_id, '206000778');
  assert.equal(probe.active_saved_layout_name, MARKER);
  assert.equal(probe.chart_uid, 'current-route-uid');
  assert.equal(inventoryReadCount, 0);
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
    saved_layout_id: null,
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

test('create preflight bounds a stalled capability read and closes its exact temporary target', async () => {
  let closeCount = 0;
  const result = await preflightSavedChartAuthority(INPUT, {
    authorityReadTimeoutMs: 25,
    readProfileInventory: async () => inventory([{
      layoutId: 'existing-layout', name: 'Existing', symbol: '', resolution: '',
    }]),
    openTemporaryChartTarget: async () => {
      let closed = false;
      return {
        target: { id: 'temporary-capability-target', type: 'page', url: 'https://www.tradingview.com/chart/' },
        page: preflightProbePage([{ layoutId: 'existing-layout', name: 'Existing' }]),
        close: async () => {
          if (!closed) {
            closed = true;
            closeCount += 1;
          }
        },
      };
    },
    canCreateSavedLayout: async () => await new Promise(() => {}),
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.can_create, false);
  assert.equal(result.create_preflight_failure_code, 'SAVED_CHART_AUTHORITY_READ_TIMEOUT');
  assert.equal(closeCount, 1);
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

test('successful authority inventory with failed temporary-target cleanup returns durable fail-closed result', async (t) => {
  const readProfileInventory = async () => ({
    ...inventory([{ layoutId: 'exact-layout', name: MARKER }]),
    temporaryTargetCreated: true,
    close: async () => { throw new Error('temporary target close did not confirm'); },
  });

  await t.test('preflight', async () => {
    const result = await preflightSavedChartAuthority(INPUT, { readProfileInventory });

    assert.equal(result.authenticated, true);
    assert.equal(result.can_create, false);
    assert.equal(result.failure_code, 'PROFILE_INVENTORY_TEMPORARY_TARGET_CLOSE_UNCONFIRMED');
  });

  await t.test('ensure', async () => {
    let createCount = 0;
    const result = await ensureSavedChartAuthority({
      ...INPUT,
      expectedAccountSubjectSha256: ACCOUNT_HASH,
      createIfAbsent: true,
    }, {
      readProfileInventory,
      createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
    });

    assert.equal(result.action, 'unknown');
    assert.equal(result.failure_code, 'PROFILE_INVENTORY_TEMPORARY_TARGET_CLOSE_UNCONFIRMED');
    assert.equal(result.temporary_target_closed, false);
    assert.equal(result.mutations_performed, false);
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

test('read-only authority preflight aborts a stalled profile target inventory with a stable failure code', async () => {
  const cdpUrl = `http://127.0.0.1:9222/profiles/${INPUT.expectedProfileId}/cdp`;
  let targetInventoryAborted = false;
  const result = await preflightSavedChartAuthority({ ...INPUT, expectedProfileId: undefined }, {
    managerBaseUrl: 'http://manager.test/api',
    authorityReadTimeoutMs: 25,
    fetch: async (value, options) => {
      const url = new URL(String(value));
      if (url.pathname === '/api/profiles') {
        return { ok: true, json: async () => [{
          id: INPUT.expectedProfileId,
          name: INPUT.profileName,
          status: 'running',
          cdp_url: cdpUrl,
        }] };
      }
      assert.equal(url.pathname, `/profiles/${INPUT.expectedProfileId}/cdp/json/list`);
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          targetInventoryAborted = true;
          reject(new Error('request aborted'));
        }, { once: true });
      });
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.failure_code, 'SAVED_CHART_AUTHORITY_READ_TIMEOUT');
  assert.equal(targetInventoryAborted, true);
  assert.equal(result.can_create, false);
});

test('read-only authority preflight closes a stalled exact-page CDP read and returns bounded failure', async () => {
  const cdpUrl = `http://127.0.0.1:9222/profiles/${INPUT.expectedProfileId}/cdp`;
  let pageClosed = false;
  const target = {
    id: 'stalled-inventory-page',
    type: 'page',
    url: 'https://www.tradingview.com/chart/current-route/',
    webSocketDebuggerUrl: `${cdpUrl}/devtools/page/stalled-inventory-page`,
  };
  const page = {
    Runtime: {
      enable: async () => {},
      evaluate: async () => await new Promise(() => {}),
    },
    Page: { enable: async () => {} },
    close: async () => { pageClosed = true; },
  };
  const result = await preflightSavedChartAuthority({ ...INPUT, expectedProfileId: undefined }, {
    managerBaseUrl: 'http://manager.test/api',
    authorityReadTimeoutMs: 25,
    fetch: async (value) => {
      const url = new URL(String(value));
      const body = url.pathname === '/api/profiles'
        ? [{ id: INPUT.expectedProfileId, name: INPUT.profileName, status: 'running', cdp_url: cdpUrl }]
        : [target];
      return { ok: true, json: async () => body };
    },
    connectTarget: async () => page,
  });

  assert.equal(result.success, true);
  assert.equal(result.authenticated, false);
  assert.equal(result.failure_code, 'SAVED_CHART_AUTHORITY_READ_TIMEOUT');
  assert.equal(pageClosed, true);
  assert.equal(result.can_create, false);
});

test('cold-profile inventory bounds temporary-target creation and closes exact target after lost response', async () => {
  const profileId = INPUT.expectedProfileId;
  const cdpUrl = `http://127.0.0.1:9222/profiles/${profileId}/cdp`;
  const targetId = 'late-temporary-inventory-target';
  let targets = [];
  let closedTargetId = null;
  const browser = {
    Target: {
      createTarget: async () => {
        targets = [{ id: targetId, type: 'page', url: 'about:blank' }];
        return await new Promise(() => {});
      },
      closeTarget: async ({ targetId: id }) => {
        closedTargetId = id;
        targets = targets.filter((target) => target.id !== id);
        return { success: true };
      },
    },
    close: async () => {},
  };
  const result = await preflightSavedChartAuthority({ ...INPUT, expectedProfileId: undefined }, {
    managerBaseUrl: 'http://manager.test/api',
    authorityReadTimeoutMs: 25,
    fetch: async (value) => {
      const url = new URL(String(value));
      const body = url.pathname === '/api/profiles'
        ? [{ id: profileId, name: INPUT.profileName, status: 'running', cdp_url: cdpUrl }]
        : url.pathname === `/profiles/${profileId}/cdp/json/version`
          ? { webSocketDebuggerUrl: `ws://127.0.0.1:9222/profiles/${profileId}/cdp` }
          : targets;
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => browser,
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.failure_code, 'SAVED_CHART_AUTHORITY_READ_TIMEOUT');
  assert.equal(result.can_create, false);
  assert.equal(closedTargetId, targetId);
  assert.deepEqual(targets, []);
});

test('cold-profile inventory preserves unknown outcome when timed-out target creation has no exact readback', async () => {
  const profileId = INPUT.expectedProfileId;
  const cdpUrl = `http://127.0.0.1:9222/profiles/${profileId}/cdp`;
  const browser = {
    Target: { createTarget: async () => await new Promise(() => {}) },
    close: async () => {},
  };
  const result = await preflightSavedChartAuthority({ ...INPUT, expectedProfileId: undefined }, {
    managerBaseUrl: 'http://manager.test/api',
    authorityReadTimeoutMs: 25,
    fetch: async (value) => {
      const url = new URL(String(value));
      const body = url.pathname === '/api/profiles'
        ? [{ id: profileId, name: INPUT.profileName, status: 'running', cdp_url: cdpUrl }]
        : url.pathname === `/profiles/${profileId}/cdp/json/version`
          ? { webSocketDebuggerUrl: `ws://127.0.0.1:9222/profiles/${profileId}/cdp` }
          : [];
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => browser,
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.failure_code, 'TEMPORARY_INVENTORY_TARGET_CREATE_OUTCOME_UNKNOWN');
  assert.equal(result.can_create, false);
});

test('cold-profile inventory bounds temporary-target navigation and confirms exact cleanup', async () => {
  const profileId = INPUT.expectedProfileId;
  const cdpUrl = `http://127.0.0.1:9222/profiles/${profileId}/cdp`;
  const targetId = 'stalled-temporary-inventory-target';
  let targets = [];
  let closedTargetId = null;
  const page = {
    Runtime: {
      enable: async () => {},
      evaluate: async () => ({ result: { value: { url: 'about:blank' } } }),
    },
    Page: {
      enable: async () => {},
      navigate: async () => await new Promise(() => {}),
    },
    close: async () => {},
  };
  const browser = {
    Target: {
      createTarget: async () => {
        targets = [{
          id: targetId,
          type: 'page',
          url: 'about:blank',
          webSocketDebuggerUrl: `${cdpUrl}/devtools/page/${targetId}`,
        }];
        return { targetId };
      },
      closeTarget: async ({ targetId: id }) => {
        closedTargetId = id;
        targets = targets.filter((target) => target.id !== id);
        return { success: true };
      },
    },
    close: async () => {},
  };
  const result = await preflightSavedChartAuthority({ ...INPUT, expectedProfileId: undefined }, {
    managerBaseUrl: 'http://manager.test/api',
    authorityReadTimeoutMs: 25,
    fetch: async (value) => {
      const url = new URL(String(value));
      const body = url.pathname === '/api/profiles'
        ? [{ id: profileId, name: INPUT.profileName, status: 'running', cdp_url: cdpUrl }]
        : url.pathname === `/profiles/${profileId}/cdp/json/version`
          ? { webSocketDebuggerUrl: `ws://127.0.0.1:9222/profiles/${profileId}/cdp` }
          : targets;
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => browser,
    connectTarget: async () => page,
  });

  assert.equal(result.authenticated, false);
  assert.equal(result.failure_code, 'SAVED_CHART_AUTHORITY_READ_TIMEOUT');
  assert.equal(result.can_create, false);
  assert.equal(closedTargetId, targetId);
  assert.deepEqual(targets, []);
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
      evaluate: async ({ expression }) => ({ result: { value: expression === ACCOUNT_LAYOUT_PROBE
        ? {
          authenticated: true,
          account_subject_sha256: ACCOUNT_HASH,
          layouts: [{ layout_id: 'new-account-layout', name: 'Current account chart' }],
          chart_uid: null,
          saved_layout_uid: null,
          current_url: 'https://www.tradingview.com/chart/',
        } : { url: 'about:blank' } } }),
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
      evaluate: async ({ expression }) => ({ result: { value: expression === ACCOUNT_LAYOUT_PROBE
        ? {
          authenticated: true,
          account_subject_sha256: ACCOUNT_HASH,
          layouts: [{ layout_id: 'current-account-layout', name: MARKER }],
          chart_uid: null,
          saved_layout_uid: null,
          current_url: 'https://www.tradingview.com/chart/',
        } : { url: 'about:blank' } } }),
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
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'reused');
  assert.equal(result.saved_layout_id, 'internal-layout-id');
  assert.equal(result.saved_chart_id, null);
  assert.equal(result.canonical_chart_url, null);
  assert.equal(result.mutations_performed, false);
  assert.equal(result.create_if_absent, true);
  assert.equal(createCount, 0);
});

test('saved-layout discovery does not depend on route UID resolution or target close', async () => {
  let createCount = 0;
  const result = await ensureSavedChartAuthority({
    ...INPUT,
    expectedAccountSubjectSha256: ACCOUNT_HASH,
    createIfAbsent: true,
  }, {
    readProfileInventory: async () => inventory([
      { layoutId: 'existing-layout', name: MARKER, symbol: '', resolution: '' },
    ]),
    createSavedLayout: async () => { createCount += 1; throw new Error('must not create'); },
  });

  assert.equal(result.action, 'reused');
  assert.equal(result.saved_layout_id, 'existing-layout');
  assert.equal(result.failure_code, null);
  assert.equal(result.temporary_target_closed, true);
  assert.equal(result.mutations_performed, false);
  assert.equal(result.match_count, 1);
  assert.equal(createCount, 0);
});

test('saved-layout hydration loads exact server ID into a fresh target and verifies marker/account/readback', async () => {
  const profileId = INPUT.expectedProfileId;
  const cdpUrl = `http://127.0.0.1:9222/profiles/${profileId}/cdp`;
  const browserWebSocketUrl = `ws://127.0.0.1:9222/profiles/${profileId}/cdp`;
  const savedLayoutId = '206000778';
  let runtimeChartId = 'runtime-route-a';
  const targetId = 'fresh-layout-target';
  const targets = new Map();
  let loaded = false;
  let loadedRequestedId = null;
  let activeSavedLayoutId = savedLayoutId;
  let activeSavedLayoutName = MARKER;
  let targetCloseCount = 0;
  let targetCreateCount = 0;
  let activeProbeCount = 0;
  let fullLayoutProbeCount = 0;
  const page = {
    Runtime: {
      enable: async () => {},
      evaluate: async ({ expression }) => {
        if (expression.includes('loadChartFromServer')) {
          loadedRequestedId = savedLayoutId;
          loaded = true;
          targets.set(targetId, { ...targets.get(targetId), url: `https://www.tradingview.com/chart/${runtimeChartId}/` });
          return { result: { value: { ok: true } } };
        }
        if (expression === ACTIVE_SAVED_LAYOUT_PROBE) {
          activeProbeCount += 1;
          const active = loaded && activeProbeCount >= 3;
          return { result: { value: {
            authenticated: true,
            account_subject_sha256: ACCOUNT_HASH,
            chart_uid: active ? runtimeChartId : null,
            current_url: active
              ? `https://www.tradingview.com/chart/${runtimeChartId}/`
              : 'https://www.tradingview.com/chart/',
            active_saved_layout_id: active ? activeSavedLayoutId : null,
            active_saved_layout_name: active ? activeSavedLayoutName : null,
          } } };
        }
        if (expression === ACCOUNT_LAYOUT_PROBE) fullLayoutProbeCount += 1;
        return { result: { value: {
          authenticated: true,
          account_subject_sha256: ACCOUNT_HASH,
          layouts: [{ layout_id: savedLayoutId, name: MARKER, symbol: '', resolution: '' }],
          chart_uid: loaded ? runtimeChartId : null,
          current_url: loaded
            ? `https://www.tradingview.com/chart/${runtimeChartId}/`
            : 'https://www.tradingview.com/chart/',
          active_saved_layout_id: loaded ? activeSavedLayoutId : null,
          active_saved_layout_name: loaded ? activeSavedLayoutName : null,
        } } };
      },
    },
    Page: {
      enable: async () => {},
      navigate: async ({ url }) => {
        targets.set(targetId, { ...targets.get(targetId), url });
        return {};
      },
    },
    close: async () => {},
  };
  const browser = {
    Target: {
      createTarget: async ({ url }) => {
        targetCreateCount += 1;
        targets.set(targetId, {
          id: targetId, type: 'page', url,
          webSocketDebuggerUrl: `${browserWebSocketUrl}/devtools/page/${targetId}`,
        });
        return { targetId };
      },
      closeTarget: async ({ targetId: closedId }) => {
        targetCloseCount += 1;
        targets.delete(closedId);
        return { success: true };
      },
    },
    close: async () => {},
  };
  const result = await hydrateSavedChartLayout({
    profileName: INPUT.profileName,
    captureSlotId: INPUT.captureSlotId,
    reconciliationKey: INPUT.reconciliationKey,
    savedLayoutId,
  }, {
    readProfileInventory: async () => ({
      ...inventory([{ layoutId: savedLayoutId, name: MARKER, symbol: '', resolution: '' }]),
      profile: { profileName: INPUT.profileName, profileId, cdpUrl },
      loadedTargets: [{
        targetId: 'misleading-existing-target',
        targetUrl: `https://www.tradingview.com/chart/${runtimeChartId}/`,
        chartId: runtimeChartId,
        savedLayoutUid: runtimeChartId,
      }],
      close: async () => {},
    }),
    fetch: async (value) => {
      const url = new URL(String(value));
      const body = url.pathname.endsWith('/json/version')
        ? { webSocketDebuggerUrl: browserWebSocketUrl }
        : [...targets.values()];
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => browser,
    connectTarget: async () => page,
    sleep: async () => {},
  });

  assert.equal(result.state, 'hydrated');
  assert.equal(result.saved_layout_id, savedLayoutId);
  assert.equal(result.layout_marker, MARKER);
  assert.equal(result.account_subject_sha256, ACCOUNT_HASH);
  assert.equal(result.target_id, targetId);
  assert.equal(result.runtime_chart_id, runtimeChartId);
  assert.equal(result.target_url, `https://www.tradingview.com/chart/${runtimeChartId}/`);
  assert.equal(result.mutations_performed, true);
  assert.equal(loadedRequestedId, savedLayoutId);
  assert.equal(targetCreateCount, 1);
  assert.equal(targetCloseCount, 0);
  assert.equal(activeProbeCount, 3);
  assert.equal(fullLayoutProbeCount, 2);
  assert.equal(targets.has(targetId), true);

  runtimeChartId = `private-route-${'r'.repeat(146)}`;
  activeSavedLayoutId = `PRIVATE_LAYOUT_ID_${'x'.repeat(180)}`;
  activeSavedLayoutName = `PRIVATE_ACCOUNT_LAYOUT_NAME_${'y'.repeat(180)}`;
  await assert.rejects(hydrateSavedChartLayout({
    profileName: INPUT.profileName,
    captureSlotId: INPUT.captureSlotId,
    reconciliationKey: INPUT.reconciliationKey,
    savedLayoutId,
  }, {
    readProfileInventory: async () => ({
      ...inventory([{ layoutId: savedLayoutId, name: MARKER, symbol: '', resolution: '' }]),
      profile: { profileName: INPUT.profileName, profileId, cdpUrl },
      close: async () => {},
    }),
    fetch: async (value) => {
      const url = new URL(String(value));
      const body = url.pathname.endsWith('/json/version')
        ? { webSocketDebuggerUrl: browserWebSocketUrl }
        : [...targets.values()];
      return { ok: true, json: async () => body };
    },
    connectBrowser: async () => browser,
    connectTarget: async () => page,
    sleep: async () => {},
  }), (error) => {
    assert.match(error.message, /SAVED_LAYOUT_LOAD_NOT_CONFIRMED:SAVED_LAYOUT_ACTIVE_ID_MISMATCH/u);
    assert.match(error.message, /authenticated=true/u);
    assert.match(error.message, /account_match=true/u);
    assert.match(error.message, /active_id_match=false/u);
    assert.match(error.message, /active_name_match=false/u);
    assert.match(error.message, /route_readback_match=true/u);
    assert.ok(error.message.length <= 512);
    assert.ok(!error.message.includes(activeSavedLayoutId));
    assert.ok(!error.message.includes(activeSavedLayoutName));
    assert.ok(!error.message.includes(runtimeChartId));
    assert.doesNotMatch(error.message, /https?:\/\//u);
    return true;
  });
  assert.equal(targetCloseCount, 1);
  assert.equal(targets.has(targetId), false);
});

test('saved-layout hydration refuses marker-to-ID mismatch before opening a target', async () => {
  let targetCreateCount = 0;
  let closed = false;
  await assert.rejects(hydrateSavedChartLayout({
    profileName: INPUT.profileName,
    captureSlotId: INPUT.captureSlotId,
    reconciliationKey: INPUT.reconciliationKey,
    savedLayoutId: 'wrong-layout-id',
  }, {
    readProfileInventory: async () => ({
      ...inventory([{ layoutId: 'actual-layout-id', name: MARKER }]),
      close: async () => { closed = true; },
    }),
    connectBrowser: async () => { targetCreateCount += 1; throw new Error('must not open target'); },
  }), /SAVED_LAYOUT_MARKER_ID_MISMATCH/u);
  assert.equal(closed, true);
  assert.equal(targetCreateCount, 0);
});

test('slot B create accepts exact new layout ID even when route UID matches Slot A', async () => {
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
    let createClickCount = 0;
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
          const id = 'slot-b-create-target';
          createdTargets.set(id, {
            id, type: 'page', url,
            webSocketDebuggerUrl: `${browserWebSocketUrl}/devtools/page/${id}`,
          });
          return { targetId: id };
        },
        closeTarget: async ({ targetId }) => {
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
      dispatchMouseEvent: async (event) => {
        if (event.type === 'mouseReleased' && event.x === 40 && event.y === 40) {
          createClickCount += 1;
          chartUid = 'slot-a-route-uid';
          pageUrl = `https://www.tradingview.com/chart/${chartUid}/`;
          layouts.push({ layoutId: 'slot-b-layout', name: slotBMarker, symbol: '', resolution: '' });
        }
      },
      insertText: async (text) => { inputValue = text; },
      sleep: async () => {},
    });
    assert.equal(result.action, 'created', result.failure_code ?? undefined);
    assert.equal(result.saved_layout_id, 'slot-b-layout');
    assert.equal(result.saved_chart_id, null);
    assert.equal(result.mutations_performed, true);
    assert.equal(result.temporary_target_closed, true);
    assert.equal(createClickCount, 1);
    assert.deepEqual(layouts.map(({ layoutId, name }) => ({ layoutId, name })), [
      { layoutId: 'slot-a-layout', name: slotAMarker },
      { layoutId: 'slot-b-layout', name: slotBMarker },
    ]);
});

test('one-shot create reports exact saved chart UID and preserves unknown outcome for discovery-only retry', async () => {
  let createCount = 0;
  const createDependencies = {
    readProfileInventory: async () => inventory([]),
    createSavedLayout: async (_profileName, _profileId, _slot, marker, _prior, _deps, onAttempt) => {
      assert.equal(marker, MARKER);
      createCount += 1;
      onAttempt();
      return { savedLayoutId: 'fresh-layout-id', temporaryTargetClosed: true };
    },
  };
  const request = { ...INPUT, expectedAccountSubjectSha256: ACCOUNT_HASH, createIfAbsent: true };
  const created = await ensureSavedChartAuthority(request, createDependencies);
  assert.equal(created.action, 'created');
  assert.equal(created.saved_layout_id, 'fresh-layout-id');
  assert.equal(created.saved_chart_id, null);
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
  assert.equal(result.failure_code, 'TEMPORARY_INVENTORY_TARGET_CLOSE_UNCONFIRMED');
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
