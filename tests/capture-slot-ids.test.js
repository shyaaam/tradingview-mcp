import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';

import {
  CAPTURE_SLOT_IDS,
  CAPTURE_SLOT_ID_PATTERN,
  LAYOUT_MARKER_PATTERN,
  captureSlotMarkerLetter,
  isCaptureSlotId,
} from '../src/core/capture-slot-ids.js';
import { savedChartLayoutMarker } from '../src/core/saved-chart-authority.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';

const KEY = 'a'.repeat(64);

/** The marker exactly as the provider built it before the pool could grow (slot a -> A, anything else -> B). */
function markerBeforeTheChange(captureSlotId, reconciliationKey) {
  const slot = captureSlotId === 'v5-capture-slot-a' ? 'A' : 'B';
  const digest = createHash('sha256').update(`tv-observer-v5:saved-chart:${captureSlotId}:${reconciliationKey}`, 'utf8').digest('base64url').slice(0, 32);
  return `V5OBS-${slot}-${digest}`;
}

test('the provider accepts the capture slots a to h, in order, and nothing else', () => {
  assert.deepEqual([...CAPTURE_SLOT_IDS], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((letter) => `v5-capture-slot-${letter}`));
  for (const id of CAPTURE_SLOT_IDS) {
    assert.equal(isCaptureSlotId(id), true, id);
    assert.match(id, CAPTURE_SLOT_ID_PATTERN);
  }
  for (const bad of ['v5-capture-slot-i', 'v5-capture-slot-', 'v5-capture-slot-aa', 'V5-CAPTURE-SLOT-A', 'slot-a', '', null, undefined, 5]) {
    assert.equal(isCaptureSlotId(bad), false, String(bad));
  }
  assert.equal(CAPTURE_SLOT_ID_PATTERN.test('v5-capture-slot-i'), false);
});

test('slots a and b keep their markers byte for byte, so layouts created before the pool grew are still found', () => {
  for (const id of ['v5-capture-slot-a', 'v5-capture-slot-b']) {
    assert.equal(savedChartLayoutMarker(id, KEY), markerBeforeTheChange(id, KEY), id);
  }
  assert.match(savedChartLayoutMarker('v5-capture-slot-a', KEY), /^V5OBS-A-/u);
  assert.match(savedChartLayoutMarker('v5-capture-slot-b', KEY), /^V5OBS-B-/u);
});

test('every slot has its own letter and its own marker', () => {
  const markers = CAPTURE_SLOT_IDS.map((id) => savedChartLayoutMarker(id, KEY));
  assert.equal(new Set(markers).size, 8);
  CAPTURE_SLOT_IDS.forEach((id, index) => {
    const letter = 'ABCDEFGH'[index];
    assert.equal(captureSlotMarkerLetter(id), letter);
    assert.match(markers[index], new RegExp(`^V5OBS-${letter}-[A-Za-z0-9_-]{32}$`, 'u'));
    assert.match(markers[index], LAYOUT_MARKER_PATTERN);
  });
  assert.throws(() => captureSlotMarkerLetter('v5-capture-slot-i'), /Unknown V5 capture slot/u);
  assert.throws(() => savedChartLayoutMarker('v5-capture-slot-i', KEY), /invalid/iu);
  assert.equal(LAYOUT_MARKER_PATTERN.test(`V5OBS-I-${'a'.repeat(32)}`), false);
});

test('every slot-scoped tool schema takes slots a to h and markers A to H, and refuses slot i', () => {
  let checked = 0;
  for (const [name, definition] of Object.entries(observerToolDefinitions)) {
    const shape = definition.inputSchema;
    if (shape === undefined || shape.capture_slot_id === undefined) continue;
    checked += 1;
    for (const id of CAPTURE_SLOT_IDS) assert.equal(shape.capture_slot_id.safeParse(id).success, true, `${name} ${id}`);
    assert.equal(shape.capture_slot_id.safeParse('v5-capture-slot-i').success, false, name);
  }
  assert.ok(checked >= 3, `slot-scoped input schemas found: ${checked}`);
  const markerSchemas = [];
  const visit = (schema) => {
    if (schema === undefined) return;
    markerSchemas.push(schema);
  };
  for (const definition of Object.values(observerToolDefinitions)) {
    const output = definition.outputSchema;
    if (output !== undefined && output.layout_marker !== undefined) visit(output.layout_marker);
  }
  assert.ok(markerSchemas.length >= 3);
  for (const schema of markerSchemas) {
    for (const letter of 'ABCDEFGH') assert.equal(schema.safeParse(`V5OBS-${letter}-${'x'.repeat(32)}`).success, true, letter);
    assert.equal(schema.safeParse(`V5OBS-I-${'x'.repeat(32)}`).success, false);
  }
  assert.ok(z.enum(CAPTURE_SLOT_IDS).safeParse('v5-capture-slot-h').success);
});
