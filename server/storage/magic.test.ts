import { describe, it, expect } from 'vitest';
import { sniffImageType, exifMarkerState, readDimensions } from './magic';
import type { ImageType } from './magic';

/**
 * Every fixture is built byte by byte in this file.
 *
 * No binary files checked into the repo: a fixture whose bytes are not visible
 * in the test cannot be reasoned about when it fails, and half of what is being
 * tested here IS the byte layout. Building them also lets the awkward cases —
 * a JPEG whose scan data happens to spell `Exif`, an AVIF whose major brand is
 * `mif1` — be constructed exactly, which is not something a real encoder can be
 * asked to produce on demand.
 */

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16be = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u24le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
/**
 * Concatenate byte runs. Takes `Uint8Array` as well as `number[]` because
 * `[].flat()` does NOT spread a typed array — it keeps it as one element, and
 * `Uint8Array.from` then fills the result with NaN→0. Spreading each part
 * explicitly is what makes `bytes(gif(), ascii('...'))` mean what it reads as.
 */
const bytes = (...parts: (number[] | Uint8Array)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => [...p]));

// ------------------------------------------------------------ builders

/** A PNG: 8-byte signature then an IHDR chunk. */
function png(width = 640, height = 480): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    u32be(13),
    ascii('IHDR'),
    u32be(width),
    u32be(height),
    [8, 6, 0, 0, 0], // bit depth, colour type, compression, filter, interlace
    u32be(0), // CRC placeholder — nothing here verifies it
  );
}

function gif(width = 12, height = 34, version = 'GIF89a'): Uint8Array {
  return bytes(ascii(version), u16le(width), u16le(height), [0x00, 0x00, 0x00]);
}

/** A JPEG segment: FF <marker> <length incl. the length field> <payload>. */
function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16be(payload.length + 2), ...payload];
}

/** SOF0 with the height/width where a baseline JPEG puts them. */
function sof0(width: number, height: number): number[] {
  return segment(0xc0, [8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0]);
}

interface JpegOptions {
  width?: number;
  height?: number;
  /** Prepend an APP1 segment carrying a real `Exif\0\0` header. */
  exif?: boolean;
  /** Bytes placed in the entropy-coded scan, after SOS. */
  scan?: number[];
  /** Extra segments before the SOF, e.g. a large APP2 ICC profile. */
  before?: number[];
}

function jpeg(options: JpegOptions = {}): Uint8Array {
  const { width = 100, height = 50, exif = false, scan = [0x00, 0x11], before = [] } = options;
  return bytes(
    [0xff, 0xd8], // SOI
    exif ? segment(0xe1, [...ascii('Exif'), 0x00, 0x00, ...ascii('MM'), 0x00, 0x2a]) : [],
    before,
    sof0(width, height),
    segment(0xda, [1, 1, 0, 0, 63, 0]), // SOS
    scan,
    [0xff, 0xd9], // EOI
  );
}

/** A RIFF/WEBP container wrapping one chunk. */
function webp(chunkTag: string, chunkPayload: number[]): Uint8Array {
  const body = [...ascii(chunkTag), ...u32be(0), ...chunkPayload];
  return bytes(ascii('RIFF'), [0, 0, 0, 0], ascii('WEBP'), body);
}

function webpLossy(width = 320, height = 240): Uint8Array {
  // frame tag(3) then the 9D 01 2A start code, then 14-bit w/h little-endian.
  return webp('VP8 ', [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]);
}

function webpLossless(width = 11, height = 7): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14);
  return webp('VP8L', [
    0x2f,
    packed & 0xff,
    (packed >>> 8) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 24) & 0xff,
  ]);
}

function webpExtended(width = 4000, height = 3000): Uint8Array {
  return webp('VP8X', [0x10, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}

/** An ISO base-media box. */
function box(name: string, payload: number[]): number[] {
  return [...u32be(payload.length + 8), ...ascii(name), ...payload];
}

function ftyp(major: string, compatible: string[]): number[] {
  return box('ftyp', [...ascii(major), ...u32be(0), ...compatible.flatMap(ascii)]);
}

function ispeChain(width: number, height: number): number[] {
  const ispe = box('ispe', [...u32be(0), ...u32be(width), ...u32be(height)]);
  // meta is a FullBox: four bytes of version+flags before its children.
  return box('meta', [...u32be(0), ...box('iprp', box('ipco', ispe))]);
}

function avif(
  major = 'avif',
  compatible: string[] = ['avif', 'mif1'],
  dims: { width: number; height: number } | null = { width: 1920, height: 1080 },
): Uint8Array {
  return bytes(ftyp(major, compatible), dims ? ispeChain(dims.width, dims.height) : []);
}

// ------------------------------------------------------------ sniffing

describe('sniffImageType', () => {
  it.each<[string, Uint8Array, ImageType]>([
    ['jpeg (JFIF APP0)', bytes([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['jpeg (bare SOF)', jpeg(), 'image/jpeg'],
    ['png', png(), 'image/png'],
    ['gif87a', gif(1, 1, 'GIF87a'), 'image/gif'],
    ['gif89a', gif(), 'image/gif'],
    ['webp lossy', webpLossy(), 'image/webp'],
    ['webp lossless', webpLossless(), 'image/webp'],
    ['webp extended', webpExtended(), 'image/webp'],
    ['avif', avif(), 'image/avif'],
  ])('sniffs %s', (_name, input, expected) => {
    expect(sniffImageType(input)).toBe(expected);
  });

  it('requires the third JPEG signature byte, not just SOI', () => {
    /**
     * The single branch deciding whether attacker-controlled bytes get stored
     * under an allowed `Content-Type`, and it was pinned only by the `length <
     * 4` floor — so shortening the signature to `FF D8` passed the whole suite.
     * A real JPEG's SOI is always followed by the 0xFF of its first marker;
     * two bytes and then a document is not a JPEG.
     */
    const soiThenHtml = bytes([0xff, 0xd8], ascii('<!DOCTYPE html><script>alert(1)</script>'));
    expect(sniffImageType(soiThenHtml)).toBeNull();
  });

  it('returns null for an HTML file renamed to .png', () => {
    const html = bytes(ascii('<!DOCTYPE html>\n<html><body>hi</body></html>'));
    expect(sniffImageType(html)).toBeNull();
  });

  it('returns null for empty and truncated input', () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
    expect(sniffImageType(bytes([0xff, 0xd8]))).toBeNull(); // two of JPEG's three
    expect(sniffImageType(png().subarray(0, 6))).toBeNull();
    expect(sniffImageType(bytes(ascii('RIFF'), [0, 0, 0, 0]))).toBeNull(); // no WEBP tag
    expect(sniffImageType(bytes(ascii('GIF8')))).toBeNull();
  });

  it('requires a known WebP chunk tag, not just RIFF....WEBP', () => {
    // WHATWG's algorithm checks the four-CC at offset 12. Without it, a RIFF
    // header glued to a document is stored as an image.
    const chunkless = bytes(
      ascii('RIFF'),
      [0, 0, 0, 0],
      ascii('WEBP'),
      ascii('<!DOCTYPE html><script>alert(1)</script>'),
    );
    expect(sniffImageType(chunkless)).toBeNull();
  });

  it('does not accept a non-WebP RIFF container', () => {
    // `RIFF` alone is WAV, AVI and others. Requiring the second tag is what
    // keeps an audio file from being stored as an image.
    const wav = bytes(ascii('RIFF'), [0, 0, 0, 0], ascii('WAVE'), ascii('fmt '));
    expect(sniffImageType(wav)).toBeNull();
  });

  describe('AVIF brand handling', () => {
    it('accepts a libheif file whose MAJOR brand is mif1 and avif is only in compatible_brands', () => {
      // The regression this pins: reading the major brand at offset 8 and
      // stopping rejects most real-world AVIFs, because libheif writes
      // mif1/miaf as the major brand.
      expect(sniffImageType(avif('mif1', ['mif1', 'miaf', 'avif']))).toBe('image/avif');
      expect(sniffImageType(avif('miaf', ['miaf', 'avif']))).toBe('image/avif');
    });

    it('accepts an avis sequence as image/avif', () => {
      expect(sniffImageType(avif('avis', ['avis', 'avif']))).toBe('image/avif');
      expect(sniffImageType(avif('mif1', ['msf1', 'avis']))).toBe('image/avif');
    });

    it('rejects other ftyp containers', () => {
      // HEIC shares the container and the mif1 brand, and is NOT in the allow
      // list; mp4 is the same shape again.
      expect(sniffImageType(avif('heic', ['mif1', 'heic']))).toBeNull();
      expect(sniffImageType(avif('mif1', ['mif1', 'miaf']))).toBeNull();
      expect(sniffImageType(avif('isom', ['isom', 'mp42']))).toBeNull();
    });

    it('does not read past the declared ftyp box for brands', () => {
      // `avif` appearing in a LATER box must not be mistaken for a compatible
      // brand of an ftyp that never claimed it. The trailing bytes are aligned
      // to 4 from the start of the file, so a scan bounded by the buffer rather
      // than by the box WILL find them — which is what this catches.
      const file = bytes(ftyp('isom', ['isom']), box('free', ascii('avif')));
      expect(sniffImageType(file)).toBeNull();
    });

    it('rejects an ftyp whose declared size is 0, instead of scanning the whole file', () => {
      // The vulnerability, exactly as reported: size 0 means "to end of file",
      // and treating it as such makes every 4-aligned offset in an
      // attacker-controlled file a candidate brand.
      const sizeZero = bytes(
        u32be(0),
        ascii('ftyp'),
        ascii('isom'),
        u32be(0),
        ascii('isomiso2MOOVavif'),
      );
      expect(sniffImageType(sizeZero)).toBeNull();
    });

    it('rejects an ftyp declaring a size larger than the bytes we hold', () => {
      // Same hazard through the other door: an oversized declaration must not
      // fall back to the buffer length.
      const overDeclared = bytes(
        u32be(0xffffff00),
        ascii('ftyp'),
        ascii('isom'),
        u32be(0),
        ascii('junkjunkavif'),
      );
      expect(sniffImageType(overDeclared)).toBeNull();
      // And it must not hang or throw on a wildly out-of-range size.
      const truncated = bytes(u32be(0xffffff00), ascii('ftyp'), ascii('mif1'), u32be(0));
      expect(sniffImageType(truncated)).toBeNull();
    });

    it('still accepts a well-formed ftyp whose brands sit inside the declared box', () => {
      // The guard above must not be satisfied by rejecting everything.
      expect(sniffImageType(avif('mif1', ['mif1', 'avif']))).toBe('image/avif');
    });
  });

  it('reports a GIF/HTML polyglot as a GIF, which is the honest answer', () => {
    // A real GIF header followed by markup is a real GIF. Sniffing identifies
    // the prefix; it is not, and cannot be, a safety verdict on the whole file.
    // The defence against a polyglot is the stored Content-Type and nosniff on
    // the way out. This test exists so nobody later "fixes" the sniffer by
    // scanning for `<script>` and starts rejecting valid images.
    const polyglot = bytes(gif(1, 1), ascii('<script>alert(1)</script>'));
    expect(sniffImageType(polyglot)).toBe('image/gif');
  });
});

// ------------------------------------------------------------ EXIF

describe('exifMarkerState', () => {
  it('detects an APP1/Exif segment', () => {
    expect(exifMarkerState(jpeg({ exif: true }))).toBe('present');
  });

  it('reports absent for a clean, canvas-re-encoded JPEG', () => {
    expect(exifMarkerState(jpeg())).toBe('absent');
  });

  it('does NOT false-positive on scan data that happens to contain "Exif"', () => {
    // The reason this walks the segment table instead of scanning for a
    // substring. These bytes are entropy-coded pixel data; there is no APP1
    // segment anywhere in the file.
    const withExifInPixels = jpeg({
      scan: [0x37, 0x9c, ...ascii('Exif'), 0x00, 0x00, 0x42, 0x8a],
    });
    expect(exifMarkerState(withExifInPixels)).toBe('absent');
  });

  it('stops at SOS: a marker-shaped APP1/Exif sequence in the scan is not read', () => {
    // Scan data is entropy-coded, not a marker table. A walk that stopped only
    // at EOI would parse these bytes as a real APP1 segment and reject the
    // upload — which is the same false positive as a substring scan, arrived at
    // by a different route.
    const decoyInScan = jpeg({
      scan: [0xff, 0xe1, 0x00, 0x10, ...ascii('Exif'), 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00],
    });
    expect(exifMarkerState(decoyInScan)).toBe('absent');
  });

  it('tolerates 0xFF fill bytes before a marker', () => {
    // Legal padding. Without the fill-byte loop the walk desynchronises here
    // and the Exif segment beyond it is never reached.
    const padded = bytes(
      [0xff, 0xd8],
      [0xff, 0xff, 0xff],
      segment(0xe1, [...ascii('Exif'), 0x00, 0x00, 0x4d, 0x4d]),
      sof0(4, 4),
      segment(0xda, [1, 1, 0, 0, 63, 0]),
      [0x00, 0xff, 0xd9],
    );
    expect(exifMarkerState(padded)).toBe('present');
  });

  it('does not report Exif from an EMPTY APP1 immediately followed by those six bytes', () => {
    /**
     * The six bytes compared must lie inside the APP1's OWN declared payload.
     *
     * The bytes matter down to the byte here, and an earlier version of this
     * fixture did not: it put the `Exif\0\0` behind a COM header, so the six
     * bytes at `payload` were `FF FE 00 0A 45 78` and never matched anything —
     * the segment bound was never reached and the test passed against code
     * that did not have it. These bytes put `Exif\0\0` at `payload` exactly,
     * with the APP1 declaring a length of 2 (an empty payload), so the only
     * thing standing between them and a `present` verdict is the segment bound.
     *
     * `unknown`, not `absent`, and that is forced: for the six bytes to sit at
     * `payload` they must start with 0x45, so the walk desynchronises on the
     * next iteration. Both live outcomes are distinguishable from the mutant's.
     */
    const emptyApp1 = bytes(
      [0xff, 0xd8],
      [0xff, 0xe1, 0x00, 0x02], // APP1, length 2 — no payload at all
      [0x45, 0x78, 0x69, 0x66, 0x00, 0x00], // 'Exif\0\0', outside that segment
      [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0],
    );
    // Bounding by `bytes.length` instead of by the segment reports 'present'.
    expect(exifMarkerState(emptyApp1)).toBe('unknown');
  });

  it('does NOT false-positive on "Exif" inside another segment\'s payload', () => {
    // A comment segment quoting the word, e.g. from an editor that logs what it
    // stripped. Only APP1 counts, and only at the payload's first byte.
    const comment = jpeg({ before: segment(0xfe, ascii('stripped Exif   block')) });
    expect(exifMarkerState(comment)).toBe('absent');
  });

  it('checks the MARKER, not just the payload: a COM starting with Exif\\0\\0 is absent', () => {
    // Only APP1 (0xE1) can carry Exif. Drop the marker test and any segment
    // whose payload happens to begin with those six bytes rejects the upload.
    const comStartingWithExif = jpeg({
      before: segment(0xfe, [...ascii('Exif'), 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a]),
    });
    expect(exifMarkerState(comStartingWithExif)).toBe('absent');
  });

  it('does not treat an APP1 XMP segment as Exif', () => {
    // XMP is also APP1, identified by a namespace URI rather than `Exif\0\0`.
    // It carries no GPS data and rejecting it would fail ordinary exports.
    const xmp = jpeg({ before: segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/ ')) });
    expect(exifMarkerState(xmp)).toBe('absent');
  });

  it('finds Exif after other segments, not only as the first one', () => {
    const late = jpeg({
      before: [
        ...segment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
        ...segment(0xe1, [...ascii('Exif'), 0x00, 0x00, 0x49, 0x49]),
      ],
    });
    expect(exifMarkerState(late)).toBe('present');
  });

  it('says UNKNOWN, never absent, when the prefix ends before the walk does', () => {
    // The finding this pins. A boolean cannot express "I did not get far
    // enough", so the caller reads truncation as cleanliness and admits a photo
    // carrying GPS coordinates. A real display-class ICC profile in an APP2
    // exceeds the 64 KiB prefix on its own, and the uploader picks the segment
    // order anyway.
    const behindBigIcc = jpeg({
      before: [
        ...segment(0xe2, new Array(0x7ffe).fill(0x41)),
        ...segment(0xe1, [...ascii('Exif'), 0x00, 0x00, 0x49, 0x49]),
      ],
    });
    expect(exifMarkerState(behindBigIcc)).toBe('present');
    expect(exifMarkerState(behindBigIcc.subarray(0, 8192))).toBe('unknown');
  });

  it('says unknown for empty, truncated and malformed input', () => {
    expect(exifMarkerState(new Uint8Array(0))).toBe('unknown');
    expect(exifMarkerState(bytes([0xff]))).toBe('unknown');
    expect(exifMarkerState(bytes([0xff, 0xd8]))).toBe('unknown'); // SOI, then nothing
    expect(exifMarkerState(jpeg({ exif: true }).subarray(0, 5))).toBe('unknown');
    // A segment header that is present but whose payload is cut off.
    expect(exifMarkerState(jpeg({ exif: true }).subarray(0, 8))).toBe('unknown');
  });

  it('says absent for input that is definitively not a JPEG', () => {
    // A conclusion, not a shortfall: there is no JPEG segment table here, and
    // the caller is not helped by being asked to fetch more of a PNG.
    expect(exifMarkerState(png())).toBe('absent');
    expect(exifMarkerState(webpLossy())).toBe('absent');
  });

  it('terminates on a malformed zero-length segment instead of looping', () => {
    // A length field below 2 would advance by a non-positive amount. Unknown
    // rather than absent — a file this broken has not been checked.
    const malformed = bytes([0xff, 0xd8], [0xff, 0xe1, 0x00, 0x00], ascii('Exif'));
    expect(exifMarkerState(malformed)).toBe('unknown');
    /*
     * No fixture here pins the `length < 2` guard itself, and none can — see
     * the note on it in `magic.ts`. Removing it is an equivalent mutation, and
     * a test written to look like it caught something would be worse than the
     * absence of one.
     */
    const desynced = bytes([0xff, 0xd8], [0x12, 0x34, 0x56, 0x78]);
    expect(exifMarkerState(desynced)).toBe('unknown');
  });

  it('is a JPEG-only check: a WebP carrying an EXIF chunk is NOT reported', () => {
    // The stated gap, pinned so it is a known limitation rather than a surprise.
    // WebP stores EXIF in a RIFF `EXIF` chunk and PNG in `eXIf`; neither is
    // covered, and both formats are in the allowed list.
    const withExifChunk = bytes(
      ascii('RIFF'),
      [0, 0, 0, 0],
      ascii('WEBP'),
      ascii('VP8X'),
      u32be(10),
      [0x08, 0, 0, 0, ...u24le(9), ...u24le(9)],
      ascii('EXIF'),
      u32be(6),
      ascii('Exif'),
      [0, 0],
    );
    expect(sniffImageType(withExifChunk)).toBe('image/webp');
    expect(exifMarkerState(withExifChunk)).toBe('absent');
  });
});

// ------------------------------------------------------------ dimensions

describe('readDimensions', () => {
  it('reads PNG from IHDR', () => {
    expect(readDimensions(png(1234, 5678), 'image/png')).toEqual({ width: 1234, height: 5678 });
  });

  it('returns null for a PNG whose first chunk is not IHDR', () => {
    const noIhdr = bytes(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      u32be(4),
      ascii('tEXt'),
      u32be(9),
      u32be(9),
    );
    expect(readDimensions(noIhdr, 'image/png')).toBeNull();
  });

  it('reads GIF from the logical screen descriptor (little-endian)', () => {
    expect(readDimensions(gif(0x0102, 0x0304), 'image/gif')).toEqual({
      width: 0x0102,
      height: 0x0304,
    });
  });

  it('reads JPEG by walking to the SOF, not from a fixed offset', () => {
    // A 20 KB APP2 ICC profile ahead of the frame header, which is what a
    // fixed-offset reader gets wrong.
    const icc = segment(0xe2, new Array(20000).fill(0x41));
    expect(readDimensions(jpeg({ width: 800, height: 600, before: icc }), 'image/jpeg')).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('does not mistake a DHT segment for a frame header', () => {
    // 0xC4 sits inside the C0–CF run but is a Huffman table. Reading its
    // payload as a frame yields believable-looking numbers.
    const withDht = jpeg({
      width: 7,
      height: 9,
      before: segment(0xc4, [0x00, 0x01, 0x02, 0x03, 0x04, 0x05]),
    });
    expect(readDimensions(withDht, 'image/jpeg')).toEqual({ width: 7, height: 9 });
  });

  it('returns null for a SOF whose DECLARED length cannot hold a frame header', () => {
    // The finding: a SOF0 marked length 2 contains nothing, so the five bytes
    // get read out of the FOLLOWING segment and a confident, entirely invented
    // pair of numbers is returned for a file with no frame header at all.
    // Before the guard this exact input returned { width: 1194, height: 65024 }.
    const emptySof = bytes(
      [0xff, 0xd8],
      [0xff, 0xc0, 0x00, 0x02], // SOF0, length 2 — an empty segment
      [0xff, 0xfe, 0x00, 0x04, 0xaa, 0xbb], // a COM whose bytes look plausible
    );
    expect(readDimensions(emptySof, 'image/jpeg')).toBeNull();
  });

  it('returns null when the SOF header is cut off mid-payload', () => {
    // Declared length is fine; the buffer is what ran out. Still not a guess.
    /**
     * One byte further than the obvious fixture, deliberately.
     *
     * Cutting immediately after the precision byte leaves the height's high
     * byte missing, so the mutant that drops the `payload + 5 > bytes.length`
     * bound reads a width of 0 and is caught by the zero check instead — the
     * guard under test never runs. These bytes carry a plausible height (0x012c
     * = 300) and one byte of the width, so removing the bound yields
     * `{ width: 256, height: 300 }`: a confident, entirely invented answer for
     * a file whose frame header is not present.
     */
    const cut = bytes([0xff, 0xd8], [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01]);
    expect(readDimensions(cut, 'image/jpeg')).toBeNull();
  });

  it('returns null when the marker table desynchronises', () => {
    /**
     * `jpegDimensions` has the same desync guard as `exifMarkerState`, and only
     * one of the two was covered — the uncovered copy being the one whose
     * result is written to `images.width`. Here the byte at offset 2 is 0x00
     * where a marker's 0xFF must be: without the guard the walk reads the
     * following bytes as a SOF anyway and returns `{ width: 200, height: 100 }`
     * for a file that is not a parseable JPEG.
     */
    const desynced = bytes([0xff, 0xd8], [0x00, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x01]);
    expect(readDimensions(desynced, 'image/jpeg')).toBeNull();
  });

  it('returns null for a JPEG whose SOF is past the fetched prefix', () => {
    // The caller fetches a fixed-length head. Beyond it, unknown — never a
    // number read out of whatever the buffer happened to end on.
    const big = jpeg({ before: segment(0xe2, new Array(70000).fill(0x41)) });
    expect(readDimensions(big.subarray(0, 65536), 'image/jpeg')).toBeNull();
  });

  it.each<[string, Uint8Array, { width: number; height: number }]>([
    ['VP8 (lossy)', webpLossy(320, 240), { width: 320, height: 240 }],
    ['VP8L (lossless)', webpLossless(11, 7), { width: 11, height: 7 }],
    ['VP8X (extended)', webpExtended(4000, 3000), { width: 4000, height: 3000 }],
  ])('reads WebP %s', (_name, input, expected) => {
    expect(readDimensions(input, 'image/webp')).toEqual(expected);
  });

  it('masks the VP8 scale bits out of the lossy dimensions', () => {
    // The top two bits of each 16-bit field are an upscaling hint, not size.
    const scaled = webpLossy(320 | (1 << 14), 240 | (2 << 14));
    expect(readDimensions(scaled, 'image/webp')).toEqual({ width: 320, height: 240 });
  });

  it('returns null for an unknown WebP chunk rather than guessing an offset', () => {
    expect(readDimensions(webp('ALPH', new Array(20).fill(1)), 'image/webp')).toBeNull();
  });

  it('verifies the VP8L signature byte before decoding the packed bits', () => {
    // Without the 0x2F check, four arbitrary bytes at offset 21 become a
    // width and a height.
    const wrongSignature = webp('VP8L', [0x11, 0xff, 0xff, 0xff, 0x0f]);
    expect(readDimensions(wrongSignature, 'image/webp')).toBeNull();
  });

  it('verifies the VP8 keyframe start code before reading the dimensions', () => {
    // Without the 9D 01 2A check, offsets 26–29 of anything are read as size.
    const noStartCode = webp('VP8 ', [
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...u16le(320), ...u16le(240),
    ]);
    expect(readDimensions(noStartCode, 'image/webp')).toBeNull();
  });

  it('returns null rather than a truncated PNG height read from a short buffer', () => {
    // Missing bytes read as 0 in a bitwise expression, so a partly-present
    // 32-bit field yields a POSITIVE, wrong number rather than an obvious NaN.
    // This is why the PNG guard is 24 and not 16.
    // The height must be one a truncated read would report as PLAUSIBLE.
    // 0x12340000 is not: the mutant reads 0x12340000 = 305 397 760 and gets
    // caught by MAX_DIMENSION, so the length guard is never exercised.
    // 65536 = 0x00010000 truncates to exactly 65536, which is under the cap —
    // so with the guard weakened to 16 this returns { 1234, 65536 }.
    const cut = png(1234, 65536).subarray(0, 22);
    expect(readDimensions(cut, 'image/png')).toBeNull();
  });

  it('returns null rather than a truncated GIF height read from a short buffer', () => {
    // Height 0x0304 with only its low byte present would otherwise read as 4.
    expect(readDimensions(gif(0x0102, 0x0304).subarray(0, 9), 'image/gif')).toBeNull();
  });

  it('rejects a header declaring a dimension no real image can have', () => {
    // A 32-bit IHDR field can hold 4 294 967 295, which is not a legal PNG
    // width and cannot be decoded — but WOULD be stored and then multiplied.
    expect(readDimensions(png(0xffffffff, 100), 'image/png')).toBeNull();
    expect(readDimensions(avif('avif', ['avif'], { width: 8, height: 0xfffffff0 }), 'image/avif'))
      .toBeNull();
  });

  it('reads AVIF by traversing meta -> iprp -> ipco -> ispe', () => {
    expect(readDimensions(avif('avif', ['avif'], { width: 1920, height: 1080 }), 'image/avif'))
      .toEqual({ width: 1920, height: 1080 });
    // Same answer when the ispe chain sits behind a large mdat, which is the
    // reason there is no fixed offset to read.
    const withMdat = bytes(
      ftyp('mif1', ['mif1', 'avif']),
      box('mdat', new Array(4096).fill(0x7f)),
      ispeChain(64, 48),
    );
    expect(readDimensions(withMdat, 'image/avif')).toEqual({ width: 64, height: 48 });
  });

  it('returns null for an AVIF with no ispe in the fetched prefix', () => {
    expect(readDimensions(avif('avif', ['avif'], null), 'image/avif')).toBeNull();
    const truncated = avif().subarray(0, 40);
    expect(readDimensions(truncated, 'image/avif')).toBeNull();
  });

  it('returns null on a zero dimension rather than reporting one', () => {
    expect(readDimensions(png(0, 100), 'image/png')).toBeNull();
    expect(readDimensions(gif(10, 0), 'image/gif')).toBeNull();
  });

  it('returns null for empty input in every format', () => {
    const empty = new Uint8Array(0);
    for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'] as const) {
      expect(readDimensions(empty, type)).toBeNull();
    }
  });

  it('returns null for truncated input in every format', () => {
    const cases: [Uint8Array, ImageType][] = [
      [jpeg().subarray(0, 4), 'image/jpeg'],
      [png().subarray(0, 20), 'image/png'],
      [gif().subarray(0, 7), 'image/gif'],
      [webpLossless().subarray(0, 22), 'image/webp'],
      [webpExtended().subarray(0, 26), 'image/webp'],
      [avif().subarray(0, 24), 'image/avif'],
    ];
    for (const [input, type] of cases) {
      expect(readDimensions(input, type)).toBeNull();
    }
  });

  it('terminates on an ISO box declaring an impossible size instead of looping', () => {
    // A box header is 8 bytes, so any declared size below that cannot advance
    // the walk. Size 0 ("to end of file") and size 4 are both refused.
    expect(readDimensions(bytes(ftyp('avif', ['avif']), u32be(0), ascii('meta')), 'image/avif'))
      .toBeNull();
    expect(readDimensions(bytes(ftyp('avif', ['avif']), u32be(4), ascii('meta')), 'image/avif'))
      .toBeNull();
  });

  it('returns null for an ispe box the prefix cut short', () => {
    /**
     * Pins BOTH guards on this path: `findBox`'s clamp of a box's end to the
     * bytes actually held, and the `ispe.start + 12 > ispe.end` bound. Remove
     * either and the box looks complete, the missing byte reads as zero, and a
     * dimension is returned for data that never arrived.
     *
     * The dimensions are chosen so the wrong answer is PLAUSIBLE. The previous
     * fixture used 0x0a0b0c0d × 0x01020304, both far over MAX_DIMENSION, so
     * every mutant was killed by the sanity cap and neither guard here was
     * exercised at all. 300 × 0x0000c800 (51 200) is under the cap, and
     * because the height's low byte is 0x00, dropping exactly one byte still
     * reads back as 51 200 — so an unguarded parser returns
     * `{ width: 300, height: 51200 }` rather than anything obviously broken.
     */
    const full = avif('avif', ['avif'], { width: 300, height: 0xc800 });
    expect(readDimensions(full.subarray(0, full.length - 1), 'image/avif')).toBeNull();
  });
});
