export function resolveManagerCdpUrl(managerBaseUrl, profileId, endpoint) {
  const base = normalizeBaseUrl(managerBaseUrl);
  const fallback = `${base}/profiles/${encodeURIComponent(requireText(profileId, 'profile_id'))}/cdp`;
  const value = endpoint === undefined || endpoint === null || String(endpoint).trim() === ''
    ? fallback
    : String(endpoint).trim();
  let resolved;
  try {
    resolved = new URL(value, `${base}/`);
  } catch {
    throw new Error('Manager CDP endpoint is malformed.');
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error('Manager CDP endpoint must use HTTP or HTTPS.');
  }
  resolved.pathname = resolved.pathname.replace(/\/+$/u, '') || '/';
  return resolved.toString().replace(/\/+$/u, '');
}

function normalizeBaseUrl(value) {
  const text = requireText(value, 'manager base URL');
  let base;
  try { base = new URL(text); } catch { throw new Error('Manager base URL is malformed.'); }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('Manager base URL must use HTTP or HTTPS.');
  }
  return base.toString().replace(/\/+$/u, '');
}

function requireText(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}
