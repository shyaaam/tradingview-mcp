import { bindObserverSession, invalidateObserverSession } from '../connection.js';
import { resolveCloakManagerBaseUrl } from './cloak.js';

const SAVED_CHART_PATH = /^\/chart\/([A-Za-z0-9_-]+)\/?$/u;

export async function hydrateChartTarget(input = {}) {
  const profileId = requireText(input.profile_id, 'profile_id');
  const authorityId = requireIdentity(input.authority_id, 'authority_id');
  const authorityHash = requireHash(input.authority_hash, 'authority_hash');
  const savedChartId = requireText(input.saved_chart_id, 'saved_chart_id');
  const chartUrl = normalizeChartUrl(input.chart_url, input.allowed_origins, savedChartId);

  await invalidateObserverSession();
  const managerBaseUrl = await resolveCloakManagerBaseUrl();
  if (!managerBaseUrl) throw new Error('CloakBrowser Manager is required for chart target hydration.');
  const profile = await loadExactProfile(managerBaseUrl, profileId);
  const cdpUrl = await ensureProfileRunning(managerBaseUrl, profileId, profile);
  await waitForVersion(cdpUrl);

  const before = await listTargets(cdpUrl);
  const exactBefore = exactTargets(before, chartUrl, savedChartId);
  if (exactBefore.length > 1) throw new Error('Multiple exact authorized chart targets found for profile.');

  let target = exactBefore[0] || null;
  let navigationPerformed = false;
  if (!target) {
    const created = await createTarget(cdpUrl, chartUrl);
    navigationPerformed = true;
    target = await waitForExactTarget(cdpUrl, created?.id, chartUrl, savedChartId);
  }
  if (!target) throw new Error('Authorized chart target hydration did not produce an exact target.');

  const finalTargets = exactTargets(await listTargets(cdpUrl), chartUrl, savedChartId);
  if (finalTargets.length !== 1 || finalTargets[0].id !== target.id) {
    throw new Error('Authorized chart target hydration readback is ambiguous or changed.');
  }

  await bindObserverSession({
    managerBaseUrl,
    profileId,
    cdpUrl,
    chartTargetId: target.id,
    chartTargetUrl: target.url,
  });

  return {
    success: true,
    hydration_version: 'chart-target-hydration-v1',
    authority_id: authorityId,
    authority_hash: authorityHash,
    profile_id: profileId,
    target_id: target.id,
    target_url: target.url,
    saved_chart_id: savedChartId,
    navigation_performed: navigationPerformed,
    authenticated: true,
    state: navigationPerformed ? 'hydrated' : 'existing-identical',
  };
}

export function normalizeChartUrl(value, allowedOrigins, savedChartId) {
  const origins = Array.isArray(allowedOrigins) ? [...new Set(allowedOrigins.map(normalizeOrigin))] : [];
  if (origins.length === 0) throw new Error('allowed_origins must contain at least one HTTPS origin.');
  const url = new URL(requireText(value, 'chart_url'));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('chart_url must be HTTPS without credentials or fragment.');
  }
  if (!origins.includes(url.origin)) throw new Error('chart_url origin is not authorized.');
  const match = url.pathname.match(SAVED_CHART_PATH);
  if (!match || match[1] !== savedChartId) throw new Error('chart_url path does not match saved_chart_id.');
  url.pathname = `/chart/${savedChartId}/`;
  url.searchParams.sort();
  return url.toString();
}

async function loadExactProfile(managerBaseUrl, profileId) {
  const payload = await fetchJson(new URL('profiles', `${managerBaseUrl}/`).toString());
  const profiles = Array.isArray(payload) ? payload : payload?.profiles;
  const profile = Array.isArray(profiles)
    ? profiles.find((entry) => String(entry?.profile_id || entry?.id || entry?.profileId || '') === profileId)
    : null;
  if (!profile) throw new Error(`Configured CloakBrowser profile not found: ${profileId}`);
  return profile;
}

async function ensureProfileRunning(managerBaseUrl, profileId, profile) {
  const status = String(profile.status || profile.state || '').toLowerCase();
  const launch = ['running', 'active'].includes(status)
    ? {}
    : await fetchJson(new URL(`profiles/${encodeURIComponent(profileId)}/launch`, `${managerBaseUrl}/`).toString(), { method: 'POST' });
  const value = launch.cdp_url || launch.cdp_endpoint || launch.cdpUrl
    || profile.cdp_url || profile.cdp_endpoint || profile.cdpUrl
    || `${managerBaseUrl}/profiles/${encodeURIComponent(profileId)}/cdp`;
  return new URL(value, `${managerBaseUrl}/`).toString().replace(/\/$/, '');
}

async function createTarget(cdpUrl, chartUrl) {
  return fetchJson(new URL(`json/new?${encodeURIComponent(chartUrl)}`, `${cdpUrl}/`).toString(), { method: 'PUT' });
}

async function waitForVersion(cdpUrl, attempts = 20) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await fetchJson(new URL('json/version', `${cdpUrl}/`).toString()); }
    catch (error) { lastError = error; await delay(250); }
  }
  throw new Error(`Profile CDP did not become ready: ${lastError?.message || 'unknown error'}`);
}

async function waitForExactTarget(cdpUrl, targetId, chartUrl, savedChartId, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const targets = exactTargets(await listTargets(cdpUrl), chartUrl, savedChartId);
    const target = targetId ? targets.find((entry) => entry.id === targetId) : targets[0];
    if (target) return target;
    const all = await listTargets(cdpUrl);
    const created = targetId ? all.find((entry) => entry.id === targetId) : null;
    if (created && /(?:signin|login|accounts)/iu.test(created.url || '')) {
      throw new Error('Chart target hydration requires authenticated browser state.');
    }
    await delay(250);
  }
  return null;
}

async function listTargets(cdpUrl) {
  const payload = await fetchJson(new URL('json/list', `${cdpUrl}/`).toString());
  return Array.isArray(payload) ? payload.filter((target) => target?.type === 'page') : [];
}

function exactTargets(targets, chartUrl, savedChartId) {
  return targets.filter((target) => {
    try {
      const normalized = new URL(target.url).toString();
      return normalized === chartUrl && target.url.match(SAVED_CHART_PATH)?.[1] === savedChartId;
    } catch { return false; }
  });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

function normalizeOrigin(value) {
  const url = new URL(requireText(value, 'allowed origin'));
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('allowed origin must be an HTTPS origin only.');
  }
  return url.origin;
}

function requireText(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}
function requireHash(value, name) {
  const text = requireText(value, name);
  if (!/^[0-9a-f]{64}$/u.test(text)) throw new Error(`${name} must be lowercase SHA-256.`);
  return text;
}
function requireIdentity(value, name) {
  const text = requireText(value, name);
  if (!/^[a-z0-9-]+:[0-9a-f]{64}$/u.test(text)) throw new Error(`${name} is invalid.`);
  return text;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
