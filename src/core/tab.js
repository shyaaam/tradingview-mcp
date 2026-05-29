/**
 * Core tab management logic.
 * Controls TradingView Desktop/Web tabs via CDP and Electron/browser keyboard shortcuts.
 */
import { getClient, listCdpTargets, activateTarget } from '../connection.js';

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const targets = await listCdpTargets();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      target_id: t.id,
      title: (t.title || '').replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab() {
  const c = await getClient();

  // Electron/TradingView Desktop uses Ctrl+T for new tab on macOS too
  // But some versions use Cmd+T
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  // Verify a new tab appeared
  const state = await list();
  return { success: true, action: 'new_tab_opened', ...state };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index or target_id and set it as the legacy default target.
 */
export async function switchTab({ index, target_id }) {
  const tabs = await list();
  let target;
  let idx = null;

  if (target_id) {
    target = tabs.tabs.find(t => t.id === target_id || t.target_id === target_id);
    if (!target) throw new Error(`Tab target_id ${target_id} not found (have ${tabs.tab_count} tabs)`);
    idx = target.index;
  } else {
    idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= tabs.tab_count) {
      throw new Error(`Tab index ${index} out of range (have ${tabs.tab_count} tabs)`);
    }
    target = tabs.tabs[idx];
  }

  try {
    await activateTarget(target.id);
    return { success: true, action: 'switched', index: idx, tab_id: target.id, target_id: target.id, chart_id: target.chart_id };
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
}
