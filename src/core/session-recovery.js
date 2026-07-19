const DEFAULT_POLL_COUNT = 10;
const DEFAULT_POLL_DELAY_MS = 250;

export const DISCONNECTED_SESSION_RECOVERY_EXPRESSION = `
(() => {
  const isVisible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  };
  const textOf = (element) => (element.innerText || element.textContent || '')
    .replace(/\\s+/g, ' ')
    .trim();
  const isDisconnectedSession = (element) => {
    const text = textOf(element);
    return /session\\s+(?:has\\s+)?(?:been\\s+)?disconnected/i.test(text)
      || /disconnected.{0,160}another device/i.test(text)
      || /another device.{0,160}session/i.test(text)
      || /(?:disconnected|disconnection).{0,160}\\bdevice\\b/i.test(text)
      || /\\bdevice\\b.{0,160}(?:disconnected|disconnection)/i.test(text);
  };

  const allVisibleElements = Array.from(document.querySelectorAll('body *'))
    .filter(isVisible);
  const exactConnectControls = allVisibleElements
    .filter((element) => element.matches('button, [role="button"], a'))
    .filter((element) => /^connect$/i.test(textOf(element)));
  const disconnectedTextElements = allVisibleElements
    .filter(isDisconnectedSession);
  const deepestTextAnchors = disconnectedTextElements.filter((element) => (
    !disconnectedTextElements.some(
      (descendant) => descendant !== element && element.contains(descendant),
    )
  ));
  const nearestContainerWithConnect = (anchor) => {
    let current = anchor;
    while (current && current !== document.body && current !== document.documentElement) {
      if (isVisible(current)) {
        const matchingControls = exactConnectControls.filter((control) => current.contains(control));
        if (matchingControls.length > 0) return current;
      }
      current = current.parentElement;
    }
    return null;
  };
  const containerCandidates = deepestTextAnchors
    .map(nearestContainerWithConnect)
    .filter(Boolean);
  const dialogs = Array.from(new Set(containerCandidates)).filter((candidate) => (
    !containerCandidates.some(
      (other) => other !== candidate && candidate.contains(other),
    )
  ));

  if (deepestTextAnchors.length === 0) {
    return {
      state: 'not-present',
      disconnect_popup_count: 0,
      exact_connect_count: 0,
    };
  }
  if (dialogs.length === 0) {
    return {
      state: 'blocked',
      reason: 'disconnect-popup-container-not-found',
      disconnect_popup_count: deepestTextAnchors.length,
      exact_connect_count: exactConnectControls.length,
    };
  }
  if (dialogs.length !== 1) {
    return {
      state: 'blocked',
      reason: 'multiple-disconnected-session-dialogs',
      disconnect_popup_count: dialogs.length,
      exact_connect_count: exactConnectControls.length,
    };
  }

  const buttons = exactConnectControls.filter((element) => dialogs[0].contains(element));
  if (buttons.length !== 1) {
    return {
      state: 'blocked',
      reason: 'connect-button-not-unique',
      disconnect_popup_count: 1,
      exact_connect_count: buttons.length,
    };
  }

  buttons[0].click();
  return {
    state: 'clicked',
    disconnect_popup_count: 1,
    exact_connect_count: 1,
  };
})()
`;

export class DisconnectedSessionRecoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DisconnectedSessionRecoveryError';
    this.code = 'DISCONNECTED_SESSION_RECOVERY_FAILED';
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function evaluateRecoveryState(client) {
  const response = await client.Runtime.evaluate({
    expression: DISCONNECTED_SESSION_RECOVERY_EXPRESSION,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    const message = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || 'Unknown session recovery evaluation error';
    throw new DisconnectedSessionRecoveryError(`Disconnected-session recovery evaluation failed: ${message}`);
  }
  const state = response.result?.value;
  if (!state || typeof state.state !== 'string') {
    throw new DisconnectedSessionRecoveryError('Disconnected-session recovery returned an invalid state.');
  }
  if (!Number.isInteger(state.disconnect_popup_count) || state.disconnect_popup_count < 0) {
    throw new DisconnectedSessionRecoveryError('Disconnected-session recovery returned an invalid popup count.');
  }
  if (!Number.isInteger(state.exact_connect_count) || state.exact_connect_count < 0) {
    throw new DisconnectedSessionRecoveryError('Disconnected-session recovery returned an invalid Connect count.');
  }
  return state;
}

function connectedEvidence(initial) {
  return Object.freeze({
    state: 'not-present',
    session_state: 'connected',
    disconnect_popup_count: initial.disconnect_popup_count,
    exact_connect_count: initial.exact_connect_count,
    reclaim_attempted: false,
    reclaim_succeeded: false,
    reclaim_click_count: 0,
  });
}

function reclaimedEvidence(initial) {
  return Object.freeze({
    state: 'reclaimed',
    session_state: 'reclaimed',
    disconnect_popup_count: initial.disconnect_popup_count,
    exact_connect_count: initial.exact_connect_count,
    reclaim_attempted: true,
    reclaim_succeeded: true,
    reclaim_click_count: 1,
  });
}

export async function recoverDisconnectedSession(client, options = {}) {
  const pollCount = options.pollCount ?? DEFAULT_POLL_COUNT;
  const pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const initial = await evaluateRecoveryState(client);

  if (initial.state === 'not-present') {
    if (initial.disconnect_popup_count !== 0 || initial.exact_connect_count !== 0) {
      throw new DisconnectedSessionRecoveryError(
        'Disconnected-session recovery returned inconsistent no-popup evidence.',
      );
    }
    return connectedEvidence(initial);
  }
  if (initial.state === 'blocked') {
    throw new DisconnectedSessionRecoveryError(
      `Disconnected-session recovery blocked: ${initial.reason || 'ambiguous-dialog'}`,
    );
  }
  if (initial.state !== 'clicked') {
    throw new DisconnectedSessionRecoveryError(
      `Disconnected-session recovery returned unexpected state: ${initial.state}`,
    );
  }
  if (initial.disconnect_popup_count !== 1 || initial.exact_connect_count !== 1) {
    throw new DisconnectedSessionRecoveryError(
      'Disconnected-session recovery returned inconsistent click evidence.',
    );
  }

  for (let attempt = 0; attempt < pollCount; attempt += 1) {
    await delay(pollDelayMs);
    const current = await evaluateRecoveryState(client);
    if (current.state === 'not-present') {
      if (current.disconnect_popup_count !== 0 || current.exact_connect_count !== 0) {
        throw new DisconnectedSessionRecoveryError(
          'Disconnected-session recovery returned inconsistent cleared-popup evidence.',
        );
      }
      return reclaimedEvidence(initial);
    }
    if (current.state === 'blocked') {
      throw new DisconnectedSessionRecoveryError(
        `Disconnected-session recovery blocked: ${current.reason || 'ambiguous-dialog'}`,
      );
    }
  }

  throw new DisconnectedSessionRecoveryError('Disconnected-session recovery timed out.');
}
