import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCONNECTED_SESSION_RECOVERY_EXPRESSION,
  recoverDisconnectedSession,
} from '../src/core/session-recovery.js';

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

test('recognizes the exact modal family and exact Connect action', () => {
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /another device/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /disconnection/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /session\\s\+.*disconnected/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /dialogCandidates/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /parent.contains\(element\)/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /\^connect\$/i);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /state: 'blocked'/);
});
