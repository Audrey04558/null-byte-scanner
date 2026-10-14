# null-byte-scanner

Scans a `Uint8Array` (or anything coercible to one) for NUL bytes and other C0 control characters and tells you, in one call, whether the content is binary or corrupted.

## Usage

```js
import { scanBuffer, isBinary } from 'null-byte-scanner';

const bytes = new Uint8Array([0x41, 0x42, 0x00, 0x43]);
const result = scanBuffer(bytes);

if (isBinary(result)) {
  // don't try to decode this as text
}
```

`scanBuffer(buffer, maxSample = 8192)` returns `{ scanned, total, nullCount, controlCount, firstNull, firstControl, truncated }`. `isBinary(result)` returns a boolean.

## Why

Every text-processing pipeline eventually ingests a file that isn't text — a `.png` renamed to `.csv`, a UTF-16 file decoded as UTF-8 and filled with `\x00`, a terminal escape dump. Decoding those as text either crashes or silently produces garbage. This library gives you a cheap, dependency-free gatekeeper: one function, one result, no streaming state to manage.

The trade-off is that the classifier is a heuristic, not a parser. It does not validate UTF-8, it does not respect BOMs, and it does not look at C1 control bytes (`0x80`–`0x9F`) because those are legitimate in Latin-1 / Windows-1252 text and flagging them would break on European-language files. If you need real encoding validation, use a dedicated library.

## The awkward edge

`maxSample` defaults to 8192 (the same threshold git uses). A file whose first 8 KiB is clean text but which contains a NUL at byte 9000 will be reported as text. If you need to be sure, pass `Infinity` as the second argument — but be aware that on a multi-gigabyte file that means reading every byte into memory first; this library does not stream.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

