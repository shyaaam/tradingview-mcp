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
  const client = new FakeClient([{ state: 'not-present' }]);

  assert.deepEqual(await recoverDisconnectedSession(client, { pollDelayMs: 0 }), {
    state: 'not-present',
  });
  assert.equal(client.calls, 1);
});

test('clicks Connect once and waits for the modal to disappear', async () => {
  const client = new FakeClient([
    { state: 'clicked' },
    { state: 'not-present' },
  ]);

  assert.deepEqual(await recoverDisconnectedSession(client, {
    pollCount: 1,
    pollDelayMs: 0,
  }), { state: 'reclaimed' });
  assert.equal(client.calls, 2);
});

test('fails closed when the Connect action is ambiguous', async () => {
  const client = new FakeClient([
    { state: 'blocked', reason: 'connect-button-not-unique' },
  ]);

  await assert.rejects(
    recoverDisconnectedSession(client, { pollDelayMs: 0 }),
    /Disconnected-session recovery blocked: connect-button-not-unique/,
  );
  assert.equal(client.calls, 1);
});

test('fails closed when the modal does not clear after the bounded poll', async () => {
  const client = new FakeClient([
    { state: 'clicked' },
    { state: 'clicked' },
  ]);

  await assert.rejects(
    recoverDisconnectedSession(client, { pollCount: 1, pollDelayMs: 0 }),
    /Disconnected-session recovery timed out/,
  );
  assert.equal(client.calls, 2);
});

test('recognizes the exact modal family and exact Connect action', () => {
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /another device/);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /\^connect\$/i);
  assert.match(DISCONNECTED_SESSION_RECOVERY_EXPRESSION, /state: 'blocked'/);
});
