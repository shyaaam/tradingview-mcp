import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  DISCONNECTED_SESSION_RECOVERY_EXPRESSION,
  recoverDisconnectedSession,
} from '../src/core/session-recovery.js';

class FakeElement {
  constructor(tagName, ownText = '', className = '') {
    this.tagName = tagName.toUpperCase();
    this.ownText = ownText;
    this.className = className;
    this.children = [];
    this.parentElement = null;
    this.clicks = 0;
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  get innerText() {
    return [this.ownText, ...this.children.map((child) => child.innerText)]
      .filter(Boolean)
      .join(' ');
  }

  get textContent() {
    return this.innerText;
  }

  getBoundingClientRect() {
    return { width: 100, height: 30 };
  }

  matches(selector) {
    if (selector !== 'button, [role="button"], a') return false;
    return this.tagName === 'BUTTON' || this.tagName === 'A';
  }

  contains(other) {
    let current = other;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  click() {
    this.clicks += 1;
  }
}

function evaluateRecoveryExpression(configure) {
  const documentElement = new FakeElement('html');
  const body = documentElement.append(new FakeElement('body'));
  const all = [];
  const append = (parent, tagName, text = '', className = '') => {
    const element = parent.append(new FakeElement(tagName, text, className));
    all.push(element);
    return element;
  };
  const fixture = configure({ body, append });
  const document = {
    body,
    documentElement,
    querySelectorAll(selector) {
      assert.equal(selector, 'body *');
      return all;
    },
  };
  const window = {
    getComputedStyle() {
      return { display: 'block', visibility: 'visible', opacity: '1' };
    },
  };
  const result = vm.runInNewContext(
    DISCONNECTED_SESSION_RECOVERY_EXPRESSION,
    { document, window },
  );
  return { result, fixture };
}

class FakeClient {
  constructor(states) {
    this.states = [...states];
    this.calls = 0;
    this.Runtime = {
      evaluate: async () => {
        this.calls += 1;
        return { result: { value: this.states.shift() } };
      },
    };
  }
}

test('does nothing when the disconnected-session modal is absent', async () => {
  const client = new FakeClient([{
    state: 'not-present',
    disconnect_popup_count: 0,
    exact_connect_count: 0,
  }]);

  assert.deepEqual(await recoverDisconnectedSession(client, { pollDelayMs: 0 }), {
    state: 'not-present',
    session_state: 'connected',
    disconnect_popup_count: 0,
    exact_connect_count: 0,
    reclaim_attempted: false,
    reclaim_succeeded: false,
    reclaim_click_count: 0,
  });
  assert.equal(client.calls, 1);
});

test('clicks Connect once and waits for the modal to disappear', async () => {
  const client = new FakeClient([
    {
      state: 'clicked',
      disconnect_popup_count: 1,
      exact_connect_count: 1,
    },
    {
      state: 'not-present',
      disconnect_popup_count: 0,
      exact_connect_count: 0,
    },
  ]);

  assert.deepEqual(await recoverDisconnectedSession(client, {
    pollCount: 1,
    pollDelayMs: 0,
  }), {
    state: 'reclaimed',
    session_state: 'reclaimed',
    disconnect_popup_count: 1,
    exact_connect_count: 1,
    reclaim_attempted: true,
    reclaim_succeeded: true,
    reclaim_click_count: 1,
  });
  assert.equal(client.calls, 2);
});

test('fails closed when the Connect action is ambiguous', async () => {
  const client = new FakeClient([
    {
      state: 'blocked',
      reason: 'connect-button-not-unique',
      disconnect_popup_count: 1,
      exact_connect_count: 2,
    },
  ]);

  await assert.rejects(
    recoverDisconnectedSession(client, { pollDelayMs: 0 }),
    /Disconnected-session recovery blocked: connect-button-not-unique/,
  );
  assert.equal(client.calls, 1);
});

test('fails closed when the modal does not clear after the bounded poll', async () => {
  const client = new FakeClient([
    {
      state: 'clicked',
      disconnect_popup_count: 1,
      exact_connect_count: 1,
    },
    {
      state: 'clicked',
      disconnect_popup_count: 1,
      exact_connect_count: 1,
    },
  ]);

  await assert.rejects(
    recoverDisconnectedSession(client, { pollCount: 1, pollDelayMs: 0 }),
    /Disconnected-session recovery timed out/,
  );
  assert.equal(client.calls, 2);
});

test('rejects inconsistent no-popup evidence', async () => {
  const client = new FakeClient([{
    state: 'not-present',
    disconnect_popup_count: 1,
    exact_connect_count: 0,
  }]);

  await assert.rejects(
    recoverDisconnectedSession(client, { pollDelayMs: 0 }),
    /inconsistent no-popup evidence/,
  );
});

test('detects and clicks a random-class TradingView disconnect popup', () => {
  const { result, fixture } = evaluateRecoveryExpression(({ body, append }) => {
    const wrapper = append(body, 'div', '', 'wrapper-TjF5uzX4');
    const main = append(wrapper, 'div', '', 'main-SiBYNi_V');
    append(main, 'div', 'Session disconnected', 'title-random');
    append(main, 'div', 'Continue using TradingView on this device.', 'body-random');
    const connect = append(main, 'button', 'Connect', 'button-random');
    return { connect };
  });

  assert.deepEqual({ ...result }, {
    state: 'clicked',
    disconnect_popup_count: 1,
    exact_connect_count: 1,
  });
  assert.equal(fixture.connect.clicks, 1);
});

test('fails closed when disconnect text is visible without a bounded Connect container', () => {
  const { result } = evaluateRecoveryExpression(({ body, append }) => {
    const wrapper = append(body, 'div', '', 'wrapper-TjF5uzX4');
    append(wrapper, 'div', 'Session disconnected', 'main-SiBYNi_V');
    return {};
  });

  assert.deepEqual({ ...result }, {
    state: 'blocked',
    reason: 'disconnect-popup-container-not-found',
    disconnect_popup_count: 1,
    exact_connect_count: 0,
  });
});

test('recognizes the exact modal family and exact Connect action', () => {
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /another device/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /disconnection/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /session\\s\+.*disconnected/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /querySelectorAll\('body \*'\)/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /deepestTextAnchors/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /nearestContainerWithConnect/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /disconnect-popup-container-not-found/);
  assert.doesNotMatch(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /\[class\*=\\?['"]modal/);
  assert.doesNotMatch(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /\[class\*=\\?['"]dialog/);
  assert.doesNotMatch(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /\[class\*=\\?['"]popup/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /\^connect\$/i);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /state: 'blocked'/);
});
