import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveManagerCdpUrl } from '../src/core/manager-cdp.js';

const managerBase = 'http://127.0.0.1:8080/api';
const profileId = 'profile-disposable';

test('normalizes absolute Manager CDP endpoint', () => {
  assert.equal(
    resolveManagerCdpUrl(managerBase, profileId, 'https://cdp.example.test/profile/cdp/'),
    'https://cdp.example.test/profile/cdp',
  );
});

test('resolves origin-relative Manager CDP endpoint against Manager base', () => {
  assert.equal(
    resolveManagerCdpUrl(managerBase, profileId, '/api/profiles/profile-disposable/cdp/'),
    'http://127.0.0.1:8080/api/profiles/profile-disposable/cdp',
  );
});

test('resolves path-relative Manager CDP endpoint against Manager base', () => {
  assert.equal(
    resolveManagerCdpUrl(managerBase, profileId, 'profiles/profile-disposable/cdp/'),
    'http://127.0.0.1:8080/api/profiles/profile-disposable/cdp',
  );
});

test('uses encoded fallback and stable trailing-slash normalization', () => {
  assert.equal(
    resolveManagerCdpUrl(managerBase, 'profile with space'),
    'http://127.0.0.1:8080/api/profiles/profile%20with%20space/cdp',
  );
  assert.equal(
    resolveManagerCdpUrl('http://127.0.0.1:8080/api///', profileId, '/api/profiles/profile-disposable/cdp///'),
    'http://127.0.0.1:8080/api/profiles/profile-disposable/cdp',
  );
});

test('rejects malformed and non-http(s) Manager CDP endpoints', () => {
  assert.throws(() => resolveManagerCdpUrl(managerBase, profileId, 'http://[bad'), /malformed/);
  assert.throws(() => resolveManagerCdpUrl(managerBase, profileId, 'javascript:alert(1)'), /HTTP or HTTPS/);
  assert.throws(() => resolveManagerCdpUrl(managerBase, profileId, 'file:///tmp/cdp'), /HTTP or HTTPS/);
});
