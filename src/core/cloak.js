const DEFAULT_CLOAK_PROFILE_ENV_KEYS = ['CLOAK_BROWSER_PROFILE_ID', 'CLOAK_PROFILE_ID'];
const DEFAULT_CLOAK_MANAGER_BASE_URLS = [
  'http://127.0.0.1:8080/api',
  'http://localhost:8080/api',
];

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function readManagerBaseUrl() {
  return cleanBaseUrl(process.env.CLOAK_BROWSER_BASE_URL || '');
}

function readProfileId() {
  for (const key of DEFAULT_CLOAK_PROFILE_ENV_KEYS) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return null;
}

function parseProfileList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.profiles)) return payload.profiles;
  return null;
}

function profileIdFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = entry.profile_id || entry.id || entry.profileId;
  return id ? String(id) : null;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`manager request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function probeManagerBaseUrl(baseUrl) {
  try {
    await fetchJson(new URL('profiles', `${baseUrl}/`).toString());
    return cleanBaseUrl(baseUrl);
  } catch {
    return null;
  }
}

export async function resolveCloakManagerBaseUrl() {
  const explicit = readManagerBaseUrl();
  if (explicit) return explicit;

  for (const candidate of DEFAULT_CLOAK_MANAGER_BASE_URLS) {
    const resolved = await probeManagerBaseUrl(candidate);
    if (resolved) return resolved;
  }
  return null;
}

export async function resolveCloakProfileId() {
  const explicitProfileId = readProfileId();
  if (explicitProfileId) return explicitProfileId;

  const baseUrl = await resolveCloakManagerBaseUrl();
  if (!baseUrl) return null;

  const payload = await fetchJson(new URL('profiles', `${baseUrl}/`).toString());
  const profiles = parseProfileList(payload);
  if (!profiles || profiles.length === 0) {
    throw new Error('No CloakBrowser profiles found. Set CLOAK_BROWSER_PROFILE_ID.');
  }
  if (profiles.length === 1) {
    const profileId = profileIdFromEntry(profiles[0]);
    if (!profileId) {
      throw new Error('CloakBrowser profile entry missing id. Set CLOAK_BROWSER_PROFILE_ID.');
    }
    return profileId;
  }

  const runningProfile = profiles.find((profile) => {
    const status = String(profile?.status || '').toLowerCase();
    return status === 'running' || status === 'active';
  });
  const runningProfileId = profileIdFromEntry(runningProfile);
  if (runningProfileId) return runningProfileId;

  throw new Error(
    'Multiple CloakBrowser profiles found. Set CLOAK_BROWSER_PROFILE_ID for exact selection.'
  );
}

export async function resolveCdpBaseUrl() {
  const explicitCdpBaseUrl = String(process.env.CDP_BASE_URL || '').trim();
  if (explicitCdpBaseUrl) return cleanBaseUrl(explicitCdpBaseUrl);

  const baseUrl = await resolveCloakManagerBaseUrl();
  if (!baseUrl) {
    const host = String(process.env.CDP_HOST || 'localhost').trim();
    const port = Number.parseInt(process.env.CDP_PORT || '9222', 10);
    return `http://${host}:${port}`;
  }

  const profileId = await resolveCloakProfileId();
  if (!profileId) {
    throw new Error('CLOAK_BROWSER_PROFILE_ID is required for CloakBrowser manager mode.');
  }
  return `${baseUrl}/profiles/${profileId}/cdp`;
}

export async function launchCloakProfile({ killExisting = true } = {}) {
  const baseUrl = await resolveCloakManagerBaseUrl();
  if (!baseUrl) {
    throw new Error('CloakBrowser Manager not found. Set CLOAK_BROWSER_BASE_URL or start manager.');
  }
  const profileId = await resolveCloakProfileId();
  if (!profileId) {
    throw new Error('CLOAK_BROWSER_PROFILE_ID is required for CloakBrowser manager launch.');
  }

  if (killExisting) {
    try {
      await fetchJson(new URL(`profiles/${profileId}/stop`, `${baseUrl}/`).toString(), {
        method: 'POST',
      });
    } catch {
      // ignore stop errors; launch below can revive profile
    }
  }

  const launchUrl = new URL(`profiles/${profileId}/launch`, `${baseUrl}/`).toString();
  const payload = await fetchJson(launchUrl, { method: 'POST' });
  const cdpUrl = payload.cdp_url || payload.cdp_endpoint || payload.cdpUrl || null;

  return {
    success: true,
    manager_base_url: baseUrl,
    profile_id: profileId,
    cdp_url: cdpUrl,
    status: payload.status || payload.state || 'running',
    raw: payload,
  };
}
