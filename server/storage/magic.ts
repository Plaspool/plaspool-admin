/**
 * Byte-level identification of uploaded images.
 *
 * Everything here reads the object's own bytes. The declared `Content-Type` on
 * an upload slot is a client claim and spec §5.4 says so verbatim: the commit
 * path fetches the first bytes back out of R2 and asks these functions what
 * they actually are, rather than trusting what the browser said it was sending.
 *
 * Two properties every function in this file holds to, because a caller stores
 * what it gets back:
 *
 * - **Short input is not a parse failure worth throwing over.** Every reader is
 *   handed the head of a ranged GET, so running off the end is the normal case,
 *   not an exception. Truncated input yields `null`/`false`, never a throw and
 *   never a partially-read number.
 * - **Uncertain is `null`, never a guess.** `readDimensions` returning a wrong
 *   number is worse than returning nothing: the caller writes it to
 *   `images.width`/`images.height` and every consumer downstream believes it.
 */

/** The five types spec §5.4 allows. */
export type ImageType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif';

export interface Dimensions {
  width: number;
  height: number;
}

// ---------------------------------------------------------------- helpers

function u16be(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

function u16le(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function u24le(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
}

/**
 * Unsigned 32-bit big-endian. The `>>> 0` is what makes it unsigned: `b[at] <<
 * 24` is a *signed* shift in JS, so a box larger than 2 GiB or a PNG width with
 * the top bit set comes back negative.
 *
 * Honest about what that is worth: it is correctness in this function, not a
 * guard anything downstream depends on. Every consumer rejects a negative
 * anyway — `ok()` requires a positive dimension, `findBox` requires `size >= 8`
 * — so dropping it changes no outcome reachable with a buffer under 2 GiB, and
 * the suite cannot distinguish the two. Kept because a helper named `u32be`
 * that returns a negative number is a trap for the next reader, not because a
 * measured failure was traced to it.
 */
function u32be(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

/**
 * ASCII compare against a literal.
 *
 * The range check states the intent; it does not add safety. An out-of-range
 * read on a `Uint8Array` is `undefined`, which compares unequal to every
 * charCode, so the loop already returns false past the end. Same for
 * `bytesAt`. Neither is defending against anything measured — they are here so
 * a reader does not have to re-derive that fact, and so a later change to
 * either loop cannot quietly start depending on the `undefined` behaviour.
 */
function tagAt(b: Uint8Array, at: number, tag: string): boolean {
  if (at < 0 || at + tag.length > b.length) return false;
  for (let i = 0; i < tag.length; i += 1) {
    if (b[at + i] !== tag.charCodeAt(i)) return false;
  }
  return true;
}

function bytesAt(b: Uint8Array, at: number, values: readonly number[]): boolean {
  if (at + values.length > b.length) return false;
  for (let i = 0; i < values.length; i += 1) {
    if (b[at + i] !== values[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------- sniffing

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Brands that mean "this ISO base-media file is an AVIF".
 *
 * `avis` is the image-sequence brand (an animated AVIF). It is accepted and
 * reported as `image/avif` — that is the registered media type for sequences
 * too, there is no separate one, and a caller that allows AVIF has no reason to
 * allow the still and refuse the animation. Note the consequence honestly: an
 * `avis` file can carry many frames, so "it is an image" does not mean "it is
 * one frame's worth of bytes". Size is bounded by `byteSize` at slot time, not
 * by anything here.
 */
const AVIF_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis']);

function brandAt(b: Uint8Array, at: number): string | null {
  if (at + 4 > b.length) return null;
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

/**
 * Identify an image from its leading bytes, or `null` if it is not one of the
 * five allowed types.
 *
 * `null` is what an HTML file renamed `.png` gets, which is the case this
 * exists for: without it the object is served back later under a
 * `Content-Type` the uploader chose.
 *
 * **What this cannot do, stated rather than implied:** a signature check
 * identifies a prefix, not a whole file. A polyglot — a real GIF whose comment
 * block or trailing bytes are also a valid HTML document, or a JPEG with a ZIP
 * appended — is a *genuine* GIF/JPEG and the honest answer is `image/gif` /
 * `image/jpeg`, which is what this returns. Sniffing is not the defence against
 * a polyglot and cannot be: what makes one dangerous is a browser being talked
 * into re-interpreting the bytes, and that is stopped on the way out (serve
 * from a signed URL with the stored `Content-Type` and
 * `X-Content-Type-Options: nosniff`), not on the way in. Do not read a non-null
 * result as "these bytes are inert".
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length < 4) return null;

  // JPEG: SOI (FF D8) immediately followed by the first marker's FF.
  if (bytesAt(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  if (bytesAt(bytes, 0, PNG_SIGNATURE)) return 'image/png';

  if (tagAt(bytes, 0, 'GIF87a') || tagAt(bytes, 0, 'GIF89a')) return 'image/gif';

  // WebP: `RIFF` <u32 le size> `WEBP` <four-CC>. All THREE tags are required.
  // `RIFF` alone is also WAV, AVI and a dozen other container formats, and
  // `RIFF????WEBP` followed by arbitrary bytes is not decodable by anything —
  // WHATWG's sniffing algorithm requires the `VP8` chunk tag at offset 12 for
  // exactly that reason. Without it, `RIFF` + `WEBP` + an HTML document sniffs
  // as an image and gets stored as one.
  if (tagAt(bytes, 0, 'RIFF') && tagAt(bytes, 8, 'WEBP')) {
    if (tagAt(bytes, 12, 'VP8 ') || tagAt(bytes, 12, 'VP8L') || tagAt(bytes, 12, 'VP8X')) {
      return 'image/webp';
    }
    return null;
  }

  // AVIF: an ISO base-media `ftyp` box. The brand list is scanned in full and
  // not just read at offset 8, because libheif — which is what most AVIF
  // encoders are underneath — writes major brand `mif1` or `miaf` with `avif`
  // in `compatible_brands`. Testing the major brand alone rejects a large share
  // of real, valid AVIFs.
  if (tagAt(bytes, 4, 'ftyp')) {
    const major = brandAt(bytes, 8);
    if (major !== null && AVIF_BRANDS.has(major)) return 'image/avif';

    /**
     * compatible_brands runs from offset 16 to the end of the ftyp box, and the
     * scan is bounded by the DECLARED box size — never by the buffer.
     *
     * Falling back to the buffer length when the declaration is unusable is a
     * vulnerability, not a leniency: the uploader controls every byte, so a
     * scan that runs to end-of-file makes every 4-aligned offset in the file a
     * candidate brand. Measured on the first version of this code, an ftyp
     * declaring size 0 with the ASCII `avif` sitting anywhere later in the file
     * — inside pixel data, inside a filename, anywhere — was reported as
     * `image/avif`.
     *
     * So an out-of-range declaration means "this ftyp is unreadable", which is
     * `null`. Nothing is lost by it: an ftyp box is a few dozen bytes and sits
     * at offset 0, so any prefix long enough to be worth sniffing contains it
     * whole. `< 16` covers both a size-0 ("to end of file") declaration and a
     * box too small to hold a compatible_brands list at all.
     */
    const declared = u32be(bytes, 0);
    if (declared < 16 || declared > bytes.length) return null;
    for (let at = 16; at + 4 <= declared; at += 4) {
      const brand = brandAt(bytes, at);
      if (brand !== null && AVIF_BRANDS.has(brand)) return 'image/avif';
    }
    // Deliberately falls through to `null`: `heic`, `mif1`-without-`avif`, mp4
    // and friends are all `ftyp` boxes and none of them are in the allow list.
  }

  return null;
}

// ---------------------------------------------------------------- EXIF

/**
 * The result of looking for an APP1/Exif segment.
 *
 * Three values and not a boolean, and the third one is the whole reason this
 * type exists. A boolean forces "the buffer ended before I reached the end of
 * the segment table" to be reported as `false`, and the caller reads `false` as
 * "clean, accept the upload" — so a JPEG that carries GPS coordinates behind a
 * large enough segment is admitted, and the privacy control the spec asks for
 * silently does not apply. It is not a hypothetical: a display-class or CMYK
 * ICC profile in an APP2 routinely exceeds the 64 KiB prefix the commit path
 * fetches, and the uploader chooses the segment order regardless.
 *
 * `readDimensions` is already careful to distinguish "unknown" from a value;
 * this is the same discipline applied to the control that actually protects a
 * person. On `unknown` the caller must refetch more bytes or reject — never
 * accept.
 */
export type ExifState =
  /** An APP1 segment with an `Exif\0\0` header is present. Reject the upload. */
  | 'present'
  /** The segment table was walked to SOS/EOI and held no such segment. */
  | 'absent'
  /** The bytes ran out, or the segment table is malformed. Not a verdict. */
  | 'unknown';

/**
 * Does this JPEG still carry an APP1/Exif segment?
 *
 * NOTE FOR CALLERS: this deliberately does not return a boolean, and is named
 * `exifMarkerState` rather than `hasExifMarker` so that no call site can write
 * `if (hasExifMarker(b))` and quietly treat the truncated case as clean. See
 * `ExifState`.
 *
 * Spec §5.4: the client strips EXIF by re-encoding through a canvas, and the
 * server enforces that rather than trusting it. EXIF is where the camera writes
 * GPS coordinates, so an image published from a phone leaks the author's
 * location if this returns a false negative.
 *
 * **It walks the segment table. It is not a substring scan, and the difference
 * is the whole point.** The four bytes `Exif` occur in compressed pixel data
 * roughly once every 4 GB of entropy-coded scan — which sounds rare until you
 * remember it only has to happen once to reject a writer's photograph with no
 * explanation they can act on. Walking the markers looks only where an APP1
 * segment can legally begin, so pixel data cannot produce a hit at all.
 *
 * **Stated limitation — this is JPEG-only, and that is a real gap, not a
 * complete check.** WebP carries EXIF in a RIFF `EXIF` chunk and PNG in an
 * `eXIf` chunk, and both formats are in the allowed list, so a WebP or PNG with
 * GPS metadata passes this function untouched. Spec §5.4 asks only for the JPEG
 * marker check and this implements exactly that; closing the other two is a
 * separate piece of work. Anything that is not a JPEG at
 * all returns `absent`, meaning "no JPEG APP1/Exif segment here", NOT "no EXIF
 * here".
 */
export function exifMarkerState(bytes: Uint8Array): ExifState {
  // Too short to hold even an SOI: no evidence in either direction.
  if (bytes.length < 2) return 'unknown';
  // Definitively not a JPEG. There is no JPEG segment table to walk, and that
  // is a conclusion rather than a shortfall of bytes.
  if (!bytesAt(bytes, 0, [0xff, 0xd8])) return 'absent';

  let at = 2;
  while (at + 1 < bytes.length) {
    // Markers may be preceded by any number of 0xFF fill bytes. Delete this
    // loop and the walk desynchronises on any padded file — and reports it
    // clean, because desynchronising looks exactly like reaching the end.
    if (bytes[at] !== 0xff) return 'unknown'; // desynchronised — malformed
    let marker = bytes[at + 1];
    let head = at + 2;
    while (marker === 0xff && head < bytes.length) {
      marker = bytes[head];
      head += 1;
    }

    // Standalone markers carry no length field: TEM (0x01) and RST0–RST7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at = head;
      continue;
    }
    // SOS starts entropy-coded data, whose bytes are not markers, and EOI ends
    // the image. Past either one there is no segment table left, so the walk is
    // COMPLETE — this is the only place `absent` may be concluded. Stopping at
    // EOI alone would walk compressed pixel data as if it were a marker table,
    // which is the false positive this function exists to avoid.
    if (marker === 0xda || marker === 0xd9) return 'absent';

    if (head + 2 > bytes.length) return 'unknown';
    const length = u16be(bytes, head);
    /*
     * A segment's length field counts its own two bytes, so anything under 2 is
     * malformed. DEFENCE IN DEPTH, and provably so — do not let this comment
     * grow a claim it cannot support.
     *
     * It is not an infinite-loop guard: `at` becomes `head + length` and `head`
     * is already at least `at + 2`, so the walk advances even at length 0. Nor
     * does removing it change any outcome. The length is read from
     * `bytes[head]`/`bytes[head + 1]`, so `length < 2` forces `bytes[head]` to
     * be 0x00 — and the walk then resumes at `head` or `head + 1`, both of
     * which are 0x00 or 0x01 and neither of which is the 0xFF a marker must
     * start with. The desync branch above returns `unknown` for it regardless.
     * Kept because it states the invariant at the point the invariant is read,
     * and because it stops being equivalent the moment anything else here
     * changes.
     */
    if (length < 2) return 'unknown';
    const payload = head + 2;
    const segmentEnd = head + length;

    if (marker === 0xe1) {
      if (payload + 6 <= Math.min(segmentEnd, bytes.length)) {
        // The six bytes must lie inside THIS SEGMENT, not merely inside the
        // buffer. Bounding by `bytes.length` alone reads the next segment's
        // bytes as this one's payload, so an empty APP1 followed by the right
        // six bytes reports Exif that is not there.
        if (bytesAt(bytes, payload, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00])) return 'present';
      } else if (segmentEnd > bytes.length) {
        // An APP1 whose payload the prefix cut off. It may or may not be the
        // Exif one, and that is exactly what `unknown` is for.
        return 'unknown';
      }
    }

    at = segmentEnd;
  }
  // Ran out of buffer without reaching SOS or EOI. Undetermined, NOT clean.
  return 'unknown';
}

// ---------------------------------------------------------------- dimensions

/**
 * Pixel dimensions read out of the file, or `null` when they cannot be read.
 *
 * The server derives these rather than accepting them from the client, so a
 * wrong answer is stored and believed. Every branch below therefore returns
 * `null` the moment it is not certain — truncated head, unrecognised sub-format,
 * a container whose dimension box is not present in the bytes we were handed.
 *
 * **How many bytes the caller must fetch.** The commit path reads a fixed-length
 * prefix with a ranged GET, so the length it picks decides which of these can
 * answer at all:
 *
 * - GIF needs 10 bytes; PNG needs 24; WebP needs 30.
 * - JPEG has no fixed offset — the SOF segment sits after every APP/DQT/DHT
 *   segment, and an ICC profile or a thumbnail can push it past 64 KiB. It is
 *   found by walking, and returns `null` if the walk runs out of bytes.
 * - AVIF has no fixed offset either: the `ispe` box is nested
 *   `meta → iprp → ipco → ispe`, and `meta` can follow a large `mdat`.
 *
 * **64 KiB is the recommended prefix** — it covers GIF/PNG/WebP outright and
 * the overwhelming majority of real JPEG and AVIF headers. It does not
 * guarantee JPEG or AVIF, and that residue surfaces as `null` (an unknown
 * dimension), never as a wrong number.
 */
export function readDimensions(bytes: Uint8Array, type: ImageType): Dimensions | null {
  switch (type) {
    case 'image/png':
      return pngDimensions(bytes);
    case 'image/gif':
      return gifDimensions(bytes);
    case 'image/jpeg':
      return jpegDimensions(bytes);
    case 'image/webp':
      return webpDimensions(bytes);
    case 'image/avif':
      return avifDimensions(bytes);
    default:
      return null;
  }
}

/**
 * No real image is this wide or this tall.
 *
 * JPEG's fields cap at 65 535 and VP8's at 16 383, but PNG's IHDR and AVIF's
 * `ispe` are 32-bit, so a crafted header can declare 4 294 967 295 — a number
 * that is not a legal PNG width (the spec caps at 2^31 − 1), cannot be decoded
 * by anything, and would be stored and then multiplied by a caller computing an
 * area or an aspect ratio. Anything past this bound is a header that disagrees
 * with reality, which is `null`, not a dimension.
 */
const MAX_DIMENSION = 100_000;

function ok(width: number, height: number): Dimensions | null {
  // A zero dimension is not a real image and would divide by zero in any
  // aspect-ratio calculation downstream. Report it as unknown.
  if (width <= 0 || height <= 0) return null;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

function pngDimensions(bytes: Uint8Array): Dimensions | null {
  // The signature is followed by the IHDR chunk: length(4) type(4) width(4)
  // height(4). IHDR is required by the spec to be first, but it is verified
  // rather than assumed — the alternative is reading a length field as a width.
  if (bytes.length < 24 || !tagAt(bytes, 12, 'IHDR')) return null;
  return ok(u32be(bytes, 16), u32be(bytes, 20));
}

function gifDimensions(bytes: Uint8Array): Dimensions | null {
  // Logical screen descriptor, little-endian, immediately after the 6-byte
  // header. This is the canvas size; a frame may be smaller, which is the
  // dimension a viewer sees and the one worth storing.
  if (bytes.length < 10) return null;
  return ok(u16le(bytes, 6), u16le(bytes, 8));
}

/**
 * Start-of-frame markers. Baseline, extended-sequential, progressive and
 * lossless, in all four Huffman/arithmetic spellings.
 *
 * The excluded values inside these ranges matter: 0xC4 is DHT, 0xC8 is JPG and
 * 0xCC is DAC. All three sit in the middle of the C0–CF run and none of them is
 * a frame header — reading dimensions out of a Huffman table yields a plausible
 * pair of numbers with nothing wrong-looking about them.
 */
function isSofMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegDimensions(bytes: Uint8Array): Dimensions | null {
  if (!bytesAt(bytes, 0, [0xff, 0xd8])) return null;

  let at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    let marker = bytes[at + 1];
    let head = at + 2;
    while (marker === 0xff && head < bytes.length) {
      marker = bytes[head];
      head += 1;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at = head;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // scan reached, no SOF

    if (head + 2 > bytes.length) return null;
    const length = u16be(bytes, head);
    if (length < 2) return null;

    if (isSofMarker(marker)) {
      // SOF payload: precision(1) height(2) width(2) components(1) ...
      const payload = head + 2;
      /**
       * The DECLARED length must cover the frame header, not just the buffer.
       *
       * Without this, a segment marked SOF0 with length 2 — a header that
       * contains nothing — reads its five bytes out of whatever segment happens
       * to follow, and returns a confident pair of numbers for a file that has
       * no frame header at all. Measured on the first version of this code:
       * `FF D8 FF C0 00 02 FF FE 00 04 AA BB` returned `{1194, 65024}`, read
       * from the following COM segment. That is precisely the "wrong number a
       * caller will store" this file's header forbids. 2 (length field) + 6
       * (precision, height, width, component count) = 8.
       */
      if (length < 8) return null;
      if (payload + 5 > bytes.length) return null;
      return ok(u16be(bytes, payload + 3), u16be(bytes, payload + 1));
    }

    at = head + length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): Dimensions | null {
  // Three sub-formats behind one `RIFF....WEBP` header, with the dimensions in
  // three different places and three different encodings. Reading offset 26 as
  // a width — which works for VP8L and is what a single-case implementation
  // ends up doing — produces garbage for the other two.
  if (bytes.length < 16 || !tagAt(bytes, 0, 'RIFF') || !tagAt(bytes, 8, 'WEBP')) {
    return null;
  }

  // VP8X (extended: alpha, animation, or an ICC profile). Canvas size is stored
  // MINUS ONE as two 24-bit little-endian fields.
  if (tagAt(bytes, 12, 'VP8X')) {
    if (bytes.length < 30) return null;
    return ok(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  }

  // VP8L (lossless). 14 bits of width-1 then 14 bits of height-1, packed
  // little-endian across bytes 21..24, after the 0x2F signature byte.
  if (tagAt(bytes, 12, 'VP8L')) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }

  // VP8 (lossy). The keyframe header carries the 3-byte start code 9D 01 2A,
  // then width and height as 14-bit little-endian values with a 2-bit scale in
  // the high bits — which is why both are masked to 0x3FFF rather than read as
  // plain uint16s.
  if (tagAt(bytes, 12, 'VP8 ')) {
    if (bytes.length < 30) return null;
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) return null;
    return ok(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }

  return null;
}

/**
 * AVIF dimensions live in an `ispe` box nested `meta → iprp → ipco → ispe`.
 * There is no fixed offset and there cannot be one: box order is not fixed, and
 * `meta` may follow a multi-megabyte `mdat`.
 *
 * `meta` is a FullBox — 4 bytes of version+flags before its children — while
 * `iprp` and `ipco` are plain containers. Skipping that difference walks four
 * bytes off and finds nothing.
 *
 * Not walked exhaustively on purpose: only the one path down to `ispe` is
 * descended, and anything else (a `grid` derived image, whose real display size
 * lives elsewhere) returns `null` rather than the first `ispe` encountered,
 * which for a grid is one tile.
 */
function avifDimensions(bytes: Uint8Array): Dimensions | null {
  const meta = findBox(bytes, 0, bytes.length, 'meta');
  if (!meta) return null;
  // Skip the FullBox version/flags word.
  const metaChildren = meta.start + 4;
  if (metaChildren > meta.end) return null;

  const iprp = findBox(bytes, metaChildren, meta.end, 'iprp');
  if (!iprp) return null;
  const ipco = findBox(bytes, iprp.start, iprp.end, 'ipco');
  if (!ipco) return null;

  // `ipco` holds every property of every item; the first `ispe` is the primary
  // item's in a single-image AVIF, which is what this path is for.
  const ispe = findBox(bytes, ipco.start, ipco.end, 'ispe');
  if (!ispe) return null;
  // ispe is a FullBox: version+flags(4) width(4) height(4). `ispe.end` is
  // already clamped to the buffer by `findBox`, so this one check covers both
  // "the box declares less than it needs" and "the prefix ended inside it" —
  // and it is why that clamp is load-bearing rather than decorative.
  if (ispe.start + 12 > ispe.end) return null;
  return ok(u32be(bytes, ispe.start + 4), u32be(bytes, ispe.start + 8));
}

interface BoxSpan {
  /** First byte of the box's payload. */
  start: number;
  /** One past the box's last byte, clamped to what we actually hold. */
  end: number;
}

/**
 * Find a named ISO base-media box among the siblings in `[from, limit)`.
 *
 * Every advance is guarded because the sizes come from the file: a box that
 * declares size 0 or 1 (`size === 1` means a 64-bit largesize follows, and
 * `size === 0` means "to end of file") would otherwise loop forever or read
 * backwards on a hostile upload. Both are treated as "cannot walk further",
 * which costs a dimension read and never a hang.
 */
function findBox(
  bytes: Uint8Array,
  from: number,
  limit: number,
  name: string,
): BoxSpan | null {
  let at = from;
  const stop = Math.min(limit, bytes.length);
  while (at + 8 <= stop) {
    const size = u32be(bytes, at);
    const type = brandAt(bytes, at + 4);
    if (type === null) return null;
    if (size < 8) return null;
    const end = at + size;
    if (type === name) return { start: at + 8, end: Math.min(end, stop) };
    if (end <= at) return null;
    at = end;
  }
  return null;
}
