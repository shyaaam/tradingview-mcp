let session = null;

export function getObserverSession() {
  return session;
}

export function requireObserverSession() {
  if (!session) {
    throw new Error('Observer session is not prepared. Call tv_observer_prepare with exact profile_id first.');
  }
  return session;
}

export function setObserverSession(nextSession) {
  const required = ['managerBaseUrl', 'profileId', 'cdpUrl', 'chartTargetId', 'chartTargetUrl'];
  if (!nextSession || required.some((key) => typeof nextSession[key] !== 'string' || !nextSession[key].trim())) {
    throw new Error('Observer session requires managerBaseUrl, profileId, cdpUrl, chartTargetId, and chartTargetUrl.');
  }

  session = Object.freeze({
    managerBaseUrl: nextSession.managerBaseUrl.trim().replace(/\/+$/, ''),
    profileId: nextSession.profileId.trim(),
    cdpUrl: nextSession.cdpUrl.trim().replace(/\/+$/, ''),
    chartTargetId: nextSession.chartTargetId.trim(),
    chartTargetUrl: nextSession.chartTargetUrl.trim(),
  });
  return session;
}

export function clearObserverSession() {
  session = null;
}
