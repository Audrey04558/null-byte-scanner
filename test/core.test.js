import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_BYTES,
  SCAN,
  classifyByte,
  scanBuffer,
  isBinary,
} from '../src/index.js';

const enc = (...bytes) => new Uint8Array(bytes);

// --- CONTROL_BYTES as a spec, not just an implementation detail -----------------

test('TAB, LF, CR are explicitly NOT control bytes', () => {
  assert.equal(CONTROL_BYTES.has(0x09), false);
  assert.equal(CONTROL_BYTES.has(0x0A), false);
  assert.equal(CONTROL_BYTES.has(0x0D), false);
});

test('NUL and DEL are control bytes', () => {
  assert.equal(CONTROL_BYTES.has(0x00), true);
  assert.equal(CONTROL_BYTES.has(0x7F), true);
});

test('C1 range 0x80-0x9F is NOT flagged (Latin-1 safe)', () => {
  for (let b = 0x80; b <= 0x9F; b++) {
    assert.equal(CONTROL_BYTES.has(b), false);
  }
});

// --- classifyByte ------------------------------------------------------------

test('classifyByte returns the right category for key bytes', () => {
  assert.equal(classifyByte(0x41), SCAN.TEXT);      // 'A'
  assert.equal(classifyByte(0x09), SCAN.TEXT);      // TAB
  assert.equal(classifyByte(0x0A), SCAN.TEXT);      // LF
  assert.equal(classifyByte(0x0D), SCAN.TEXT);      // CR
  assert.equal(classifyByte(0x00), SCAN.NULL);
  assert.equal(classifyByte(0x04), SCAN.CONTROL);   // EOT
  assert.equal(classifyByte(0x1B), SCAN.CONTROL);   // ESC
  assert.equal(classifyByte(0x7F), SCAN.CONTROL);   // DEL
});

test('classifyByte coerces non-number inputs to 0 (NUL) rather than throwing', () => {
  assert.equal(classifyByte(NaN), SCAN.NULL);
  assert.equal(classifyByte(true), SCAN.CONTROL);   // true|0 === 1
  assert.equal(classifyByte(false), SCAN.NULL);
});

// --- scanBuffer: basic shape -------------------------------------------------

test('empty buffer scans to zero counts and -1 offsets', () => {
 const r = scanBuffer(enc());
 assert.deepEqual(r, {
   scanned: 0,
   total: 0,
   nullCount: 0,
   controlCount: 0,
   firstNull: -1,
   firstControl: -1,
   truncated: false,
 });
});

test('pure ASCII text yields no nulls or controls', () => {
  const r = scanBuffer(enc(0x48, 0x69, 0x21, 0x0A)); // "Hi!\n"
  assert.equal(r.nullCount, 0);
  assert.equal(r.controlCount, 0);
  assert.equal(r.firstNull, -1);
  assert.equal(r.firstControl, -1);
  assert.equal(r.scanned, 4);
  assert.equal(r.truncated, false);
});

test('mixed content records correct first offsets', () => {
  // 'A' NUL 'B' ESC 'C' NUL
  const r = scanBuffer(enc(0x41, 0x00, 0x42, 0x1B, 0x43, 0x00));
  assert.equal(r.nullCount, 2);
  assert.equal(r.controlCount, 1);
  assert.equal(r.firstNull, 1);
  assert.equal(r.firstControl, 3);
});

// --- maxSample / truncation --------------------------------------------------

test('maxSample caps inspection and marks truncated', () => {
  const buf = enc(0x41, 0x42, 0x00, 0x43, 0x44, 0x45);
  const r = scanBuffer(buf, 3);
  assert.equal(r.scanned, 3);
  assert.equal(r.total, 6);
  assert.equal(r.nullCount, 1);   // the NUL at index 2 is within the sample
  assert.equal(r.truncated, true);
});

test('maxSample larger than buffer scans everything, not truncated', () => {
  const r = scanBuffer(enc(0x41, 0x42), 100);
  assert.equal(r.scanned, 2);
  assert.equal(r.total, 2);
  assert.equal(r.truncated, false);
});

test('maxSample = Infinity scans the whole buffer', () => {
  const bytes = [];
  for (let i = 0; i < 1000; i++) bytes.push(0x00);
  const r = scanBuffer(enc(...bytes), Infinity);
  assert.equal(r.scanned, 1000);
  assert.equal(r.nullCount, 1000);
  assert.equal(r.firstNull, 0);
  assert.equal(r.truncated, false);
});

test('negative maxSample is treated as no limit', () => {
  const r = scanBuffer(enc(0x41, 0x42), -1);
  assert.equal(r.scanned, 2);
  assert.equal(r.truncated, false);
});

test('NaN maxSample is treated as no limit', () => {
  const r = scanBuffer(enc(0x41, 0x42), NaN);
  assert.equal(r.scanned, 2);
  assert.equal(r.truncated, false);
});

// --- input coercion ----------------------------------------------------------

test('scanBuffer accepts a regular Array by coercing to Uint8Array', () => {
  const r = scanBuffer([0x41, 0x00, 0x42]);
  assert.equal(r.nullCount, 1);
  assert.equal(r.scanned, 3);
});

test('scanBuffer coerces null/undefined to an empty buffer', () => {
  assert.deepEqual(scanBuffer(null).scanned, 0);
  assert.deepEqual(scanBuffer(undefined).scanned, 0);
});

// --- isBinary decision rule --------------------------------------------------

test('isBinary: any NUL means binary', () => {
  assert.equal(isBinary({ scanned: 100, nullCount: 1, controlCount: 0 }), true);
});

test('isBinary: lone control byte is NOT binary (under 1/8 density)', () => {
  assert.equal(isBinary({ scanned: 100, nullCount: 0, controlCount: 1 }), false);
});

test('isBinary: control density >= 1/8 means binary', () => {
  // 12 controls in 100 scanned → 96 >= 100? No. Not binary.
  assert.equal(isBinary({ scanned: 100, nullCount: 0, controlCount: 12 }), false);
  // 13 controls in 100 scanned → 104 >= 100 → binary.
  assert.equal(isBinary({ scanned: 100, nullCount: 0, controlCount: 13 }), true);
});

test('isBinary: empty scan is not binary', () => {
  assert.equal(isBinary({ scanned: 0, nullCount: 0, controlCount: 0 }), false);
});

test('isBinary: null/undefined result is not binary (defensive)', () => {
  assert.equal(isBinary(null), false);
  assert.equal(isBinary(undefined), false);
});

test('end-to-end: a small binary blob is flagged', () => {
  // 8 bytes, 1 NUL → binary by the NUL rule
  const r = scanBuffer(enc(0x41, 0x42, 0x00, 0x43, 0x44, 0x45, 0x46, 0x47));
  assert.equal(isBinary(r), true);
});

test('end-to-end: a short UTF-8 string is not flagged', () => {
  const text = 'hello, world\n';
  const r = scanBuffer(new TextEncoder().encode(text));
  assert.equal(isBinary(r), false);
});
