import { resolveCloakManagerBaseUrl } from './cloak.js';
import { bindObserverSession, invalidateObserverSession } from '../connection.js';

const CHART_URL = /tradingview\.com\/chart/i;

export async function prepare(input = {}) {
  const { profile_id, restart = false } = input;
  const profileId = String(profile_id || '').trim();
  if (!profileId) throw new Error('profile_id is required; observer preparation never auto-selects a profile.');

  // Drop prior profile/client binding before preparing a new exact profile.
  await invalidateObserverSession();

  const managerBaseUrl = await resolveCloakManagerBaseUrl();
  if (!managerBaseUrl) throw new Error('CloakBrowser Manager is required for observer preparation.');

  const profiles = await fetchJson(new URL('profiles', `${managerBaseUrl}/`).toString());
  const profileList = Array.isArray(profiles) ? profiles : profiles?.profiles;
  const profile = Array.isArray(profileList)
    ? profileList.find((entry) => profileIdFromEntry(entry) === profileId)
    : null;
  if (!profile) throw new Error(`Configured CloakBrowser profile not found: ${profileId}`);

  const profileStatus = String(profile.status || profile.state || '').toLowerCase();
  if (restart && ['running', 'active'].includes(profileStatus)) {
    await fetchJson(new URL(`profiles/${encodeURIComponent(profileId)}/stop`, `${managerBaseUrl}/`).toString(), {
      method: 'POST',
    });
  }

  const launchPayload = restart || !['running', 'active'].includes(profileStatus)
    ? await fetchJson(
      new URL(`profiles/${encodeURIComponent(profileId)}/launch`, `${managerBaseUrl}/`).toString(),
      { method: 'POST' },
    )
    : {};
  const cdpUrlValue = launchPayload.cdp_url || launchPayload.cdp_endpoint || launchPayload.cdpUrl
    || profile.cdp_url || profile.cdp_endpoint || profile.cdpUrl
    || `${managerBaseUrl}/profiles/${encodeURIComponent(profileId)}/cdp`;
  const cdpUrl = new URL(cdpUrlValue, `${managerBaseUrl}/`).toString().replace(/\/$/, '');
  const version = await waitForVersion(cdpUrl);
  const chartTarget = await waitForChartTarget(cdpUrl);
  if (!chartTarget) throw new Error(`No TradingView chart target found for profile ${profileId}`);

  await bindObserverSession({
    managerBaseUrl,
    profileId,
    cdpUrl,
    chartTargetId: chartTarget.id,
    chartTargetUrl: chartTarget.url,
    reviewAuthority: input.review_authority,
  });

  return {
    success: true,
    manager_base_url: managerBaseUrl,
    profile_id: profileId,
    restart_requested: restart,
    status: launchPayload.status || launchPayload.state || profile.status || 'running',
    cdp_ready: true,
    cdp_url: cdpUrl,
    browser: version.Browser || null,
    user_agent: version['User-Agent'] || null,
    chart_target_id: chartTarget.id || null,
    chart_target_url: chartTarget.url || null,
  };
}

export async function attachExistingReadOnly(input = {}) {
  const profileId = String(input.profile_id || '').trim();
  const chartTargetId = String(input.chart_target_id || '').trim();
  if (!profileId) throw new Error('profile_id is required for read-only observer attachment.');
  if (!chartTargetId) throw new Error('chart_target_id is required for read-only observer attachment.');

  await invalidateObserverSession();
  const managerBaseUrl = await resolveCloakManagerBaseUrl();
  if (!managerBaseUrl) throw new Error('CloakBrowser Manager is required for read-only observer attachment.');
  const profiles = await fetchJson(new URL('profiles', `${managerBaseUrl}/`).toString());
  const profileList = Array.isArray(profiles) ? profiles : profiles?.profiles;
  const profile = Array.isArray(profileList)
    ? profileList.find((entry) => profileIdFromEntry(entry) === profileId)
    : null;
  if (!profile) throw new Error(`Configured CloakBrowser profile not found: ${profileId}`);
  const profileStatus = String(profile.status || profile.state || '').toLowerCase();
  if (!['running', 'active'].includes(profileStatus)) {
    throw new Error(`CloakBrowser profile is not active: ${profileId}`);
  }
  const cdpUrlValue = profile.cdp_url || profile.cdp_endpoint || profile.cdpUrl
    || `${managerBaseUrl}/profiles/${encodeURIComponent(profileId)}/cdp`;
  const cdpUrl = new URL(cdpUrlValue, `${managerBaseUrl}/`).toString().replace(/\/$/, '');
  const version = await waitForVersion(cdpUrl);
  const chartTarget = await waitForExactChartTarget(cdpUrl, chartTargetId);
  if (!chartTarget) throw new Error(`Requested TradingView chart target not found: ${chartTargetId}`);
  await bindObserverSession({
    managerBaseUrl,
    profileId,
    cdpUrl,
    chartTargetId: chartTarget.id,
    chartTargetUrl: chartTarget.url,
  });
  return {
    success: true,
    manager_base_url: managerBaseUrl,
    profile_id: profileId,
    status: profile.status || profile.state || 'running',
    cdp_ready: true,
    cdp_url: cdpUrl,
    browser: version.Browser || null,
    user_agent: version['User-Agent'] || null,
    chart_target_id: chartTarget.id,
    chart_target_url: chartTarget.url,
    mutations_performed: false,
  };
}

async function waitForVersion(cdpUrl, attempts = 15, delayMs = 250) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchJson(new URL('json/version', `${cdpUrl}/`).toString());
    } catch (error) {
      lastError = error;
      await delay(delayMs);
    }
  }
  throw new Error(`CloakBrowser CDP did not become ready: ${lastError?.message || 'unknown error'}`);
}

async function waitForChartTarget(cdpUrl, attempts = 15, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const targets = await fetchJson(new URL('json/list', `${cdpUrl}/`).toString());
    const chartTarget = Array.isArray(targets)
      ? targets.find((target) => target?.type === 'page' && CHART_URL.test(target.url || ''))
      : null;
    if (chartTarget) return chartTarget;
    await delay(delayMs);
  }
  return null;
}

async function waitForExactChartTarget(cdpUrl, chartTargetId, attempts = 15, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const targets = await fetchJson(new URL('json/list', `${cdpUrl}/`).toString());
    const chartTarget = Array.isArray(targets)
      ? targets.find((target) => target?.id === chartTargetId
        && target?.type === 'page'
        && CHART_URL.test(target.url || ''))
      : null;
    if (chartTarget) return chartTarget;
    await delay(delayMs);
  }
  return null;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

function profileIdFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = entry.profile_id || entry.id || entry.profileId;
  return id ? String(id) : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
