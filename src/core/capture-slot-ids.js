/**
 * The V5 capture slots this provider accepts: v5-capture-slot-a to v5-capture-slot-h, in that order. One list for every schema, validator
 * and layout marker, so a pool can grow without an edit in eight places. The marker letter is the slot's own letter in upper case;
 * slots a and b keep the letters A and B they always had, so layouts created before the pool grew are still found.
 */
export const CAPTURE_SLOT_IDS = Object.freeze([
  'v5-capture-slot-a', 'v5-capture-slot-b', 'v5-capture-slot-c', 'v5-capture-slot-d',
  'v5-capture-slot-e', 'v5-capture-slot-f', 'v5-capture-slot-g', 'v5-capture-slot-h',
]);

export function isCaptureSlotId(value) {
  return typeof value === 'string' && CAPTURE_SLOT_IDS.includes(value);
}

/** The marker letter of a slot: A for v5-capture-slot-a, B for -b, ... H for -h. */
export function captureSlotMarkerLetter(captureSlotId) {
  if (!isCaptureSlotId(captureSlotId)) throw new Error('Unknown V5 capture slot');
  return captureSlotId.slice(-1).toUpperCase();
}

/** `V5OBS-<letter>-<32 base64url characters>`, the letter any of the supported slots'. */
export const LAYOUT_MARKER_PATTERN = /^V5OBS-[A-H]-[A-Za-z0-9_-]{32}$/;
/** The slot ids as a regular expression alternative, for the id pattern checks. */
export const CAPTURE_SLOT_ID_PATTERN = /^v5-capture-slot-[a-h]$/u;
