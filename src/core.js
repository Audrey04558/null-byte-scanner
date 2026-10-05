/**
 * Core scanner. Pure functions that operate on `Uint8Array` inputs.
 * No I/O, no Node-specifics. Safe to reuse in a browser or a worker.
 */

/**
 * The control characters we consider "binary". Tab (0x09), LF (0x0A),
 * and CR (0x0D) are the only C0 controls that appear in legitimate text
 * files on Unix; everything else in 0x00–0x1F (and 0x7F, DEL) is treated as
 * a signal that the data is not plain text. We deliberately do NOT count
 * 0x7F-0x9F (C1 controls) — those are common in Latin-1 / Windows-1252
 * text and would produce false positives.
 *
 * Intentionally exposed so callers can build their own classifier on top
 * of the same notion of "binary" that this library uses.
 */
export const CONTROL_BYTES = new Set([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, /* 0x09 TAB ok */ 0x0B, /* 0x0A LF ok, 0x0D CR ok */
  0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15,
  0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D,
  0x1E, 0x1F, 0x7F,
]);

/**
 * Result of a single-byte scan. We aggregate per-byte so callers can stop
 * early or report the first problem rather than scanning the whole file.
 */
export const SCAN = Object.freeze({
  TEXT: 0,       // byte is normal text / tab / newline / CR
  NULL: 1,       // explicit NUL — the strongest corruption signal
  CONTROL: 2,    // other C0 control (or DEL) — weaker binary signal
});

/**
 * Classify a single byte. Returns one of the `SCAN.*` constants.
 * Exposed for callers that want to stream their own input.
 */
export function classifyByte(byte) {
  const b = byte | 0; // coerce to int32; also maps NaN → 0, booleans → 0/1
  if (b === 0x00) return SCAN.NULL;
  if (CONTROL_BYTES.has(b)) return SCAN.CONTROL;
  return SCAN.TEXT;
}

/**
 * Full scan of a buffer. Returns counts and, for diagnostics, the first
 * offset of each problematic byte type.
 *
 * `maxSample` caps the number of bytes inspected. Many callers only need
 * to know whether a file is binary, not how many null bytes it has, and
 * scanning a 4GB ISO for every NUL is a waste. Default of 8192 mirrors
 * git's heuristic. A caller who wants the whole file can pass `Infinity`.
 */
export function scanBuffer(buffer, maxSample = 8192) {
  const view = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer ?? []);

  const limit = Number.isFinite(maxSample) && maxSample >= 0
    ? Math.min(view.length, maxSample | 0)
    : view.length;

  let nullCount = 0;
  let controlCount = 0;
  let firstNull = -1;
  let firstControl = -1;

  for (let i = 0; i < limit; i++) {
    const b = view[i];
    if (b === 0x00) {
      nullCount++;
      if (firstNull === -1) firstNull = i;
    } else if (CONTROL_BYTES.has(b)) {
      controlCount++;
      if (firstControl === -1) firstControl = i;
    }
  }

  return {
    scanned: limit,
    total: view.length,
    nullCount,
    controlCount,
    firstNull,
    firstControl,
    truncated: view.length > limit,
  };
}

/**
 * Decide whether a scanned result indicates binary / corrupted content.
 *
 * Decision rule, picked deliberately and only this one:
 *   - ANY NUL byte → binary. A NUL in a text file is always corruption.
 *   - Otherwise, if ≥1 non-NUL control byte per 8 inspected bytes → binary.
 *     This catches mixed-control-byte files (e.g. terminal escape dumps)
 *     without flagging a lone STX from a sloppy editor. The 1/8 threshold
 *     matches git's long-standing `buffer_is_binary` heuristic.
 */
export function isBinary(result) {
  if (!result) return false;
  if (result.nullCount > 0) return true;
  if (result.scanned === 0) return false;
  return result.controlCount * 8 >= result.scanned;
}
