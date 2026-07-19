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
    return /session\\s+(?:has\\s+)?been\\s+disconnected/i.test(text)
      || /disconnected.{0,160}another device/i.test(text)
      || /another device.{0,160}session/i.test(text)
      || /(?:disconnected|disconnection).{0,160}\bdevice\b/i.test(text)
      || /\bdevice\b.{0,160}(?:disconnected|disconnection)/i.test(text);
  };

  const dialogs = Array.from(document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="dialog"], [class*="popup"]',
  ))
    .filter(isVisible)
    .filter(isDisconnectedSession);

  if (dialogs.length === 0) return { state: 'not-present' };
  if (dialogs.length !== 1) {
    return { state: 'blocked', reason: 'multiple-disconnected-session-dialogs' };
  }

  const buttons = Array.from(dialogs[0].querySelectorAll('button, [role="button"], a'))
    .filter(isVisible)
    .filter((element) => /^connect$/i.test(textOf(element)));
  if (buttons.length !== 1) {
    return { state: 'blocked', reason: 'connect-button-not-unique' };
  }

  buttons[0].click();
  return { state: 'clicked' };
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
  return state;
}

export async function recoverDisconnectedSession(client, options = {}) {
  const pollCount = options.pollCount ?? DEFAULT_POLL_COUNT;
  const pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const initial = await evaluateRecoveryState(client);

  if (initial.state === 'not-present') return initial;
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

  for (let attempt = 0; attempt < pollCount; attempt += 1) {
    await delay(pollDelayMs);
    const current = await evaluateRecoveryState(client);
    if (current.state === 'not-present') return { state: 'reclaimed' };
    if (current.state === 'blocked') {
      throw new DisconnectedSessionRecoveryError(
        `Disconnected-session recovery blocked: ${current.reason || 'ambiguous-dialog'}`,
      );
    }
  }

  throw new DisconnectedSessionRecoveryError('Disconnected-session recovery timed out.');
}
