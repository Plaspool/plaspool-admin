/**
 * The size ceilings, and the one property that matters about them: the
 * validator must refuse a document BEFORE the database physically can.
 *
 * `MAX_DOC_BYTES` alone did not give that. A `tsvector` cannot exceed
 * MAXSTRPOS = 1 048 575 bytes of lexemes and positions, so a high-diversity
 * document well under the 2 MB serialised ceiling of spec §4.6 was accepted
 * here and then rejected by Postgres with SQLSTATE 54000 — a code spec §8 has
 * no row for, on an UPDATE that leaves the existing row readable and
 * permanently unwritable.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_CONTENT_TEXT_BYTES,
  MAX_DOC_BYTES,
  checkDocSize,
  utf8Bytes,
} from './validate';
import { docToText } from './doc';
import type { DocNode } from './types';

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** `k` distinct terms — the shape that defeats lexeme deduplication. */
const glossary = (k: number) => Array.from({ length: k }, (_, i) => `term${i}`).join(' ');

describe('document size ceilings', () => {
  it('accepts an ordinary document', () => {
    expect(checkDocSize(doc('Hello world.'))).toBeNull();
  });

  it('accepts a large document whose body text is under the derived-text ceiling', () => {
    // 2 MB of ordinary prose is fine — this is not a "long posts are banned"
    // rule. Lexemes dedupe, so an eight-word vocabulary repeated to 2 MB is a
    // 1 572-byte tsvector.
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    let prose = '';
    while (prose.length < MAX_CONTENT_TEXT_BYTES - 5_000) {
      prose += `${words[prose.length % 8]} `;
    }
    const value = doc(prose);
    expect(utf8Bytes(docToText(value))).toBeLessThan(MAX_CONTENT_TEXT_BYTES);
    expect(checkDocSize(value)).toBeNull();
  });

  it('rejects a document over the serialised ceiling', () => {
    // One long run of one repeated character: huge serialised, trivial tsvector.
    const value = doc('x'.repeat(MAX_DOC_BYTES + 1));
    expect(checkDocSize(value)).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('rejects the high-diversity document the database cannot store', () => {
    // 80 000 distinct terms, 788 889 bytes. Spec-legal by the serialised
    // ceiling; SQLSTATE 54000 at the database. This is the case that was
    // accepted here and unwritable there.
    const body = glossary(80_000);
    expect(utf8Bytes(body)).toBeLessThan(MAX_DOC_BYTES);
    expect(utf8Bytes(body)).toBeGreaterThan(MAX_CONTENT_TEXT_BYTES);
    expect(checkDocSize(doc(body))).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('measures the derived text, not the serialised document', () => {
    // The two ceilings are independent: a document can be small serialised and
    // over the derived-text line, or the reverse. Checking only `MAX_DOC_BYTES`
    // is what let the 54000 through.
    const body = glossary(80_000);
    const value = doc(body);
    expect(utf8Bytes(JSON.stringify(value))).toBeLessThan(MAX_DOC_BYTES);
    expect(checkDocSize(value)).not.toBeNull();
  });

  it('counts UTF-8 bytes, not UTF-16 units', () => {
    // `String.length` undercounts by up to 3x, so a character ceiling bounds
    // nothing for multibyte text — 600 000 CJK characters are 1.4 MB and still
    // raise 54000. This is why the constant is a byte count.
    const cjk = '漢'.repeat(200_000);
    expect(cjk.length).toBeLessThan(MAX_CONTENT_TEXT_BYTES);
    expect(utf8Bytes(cjk)).toBe(600_000);
    expect(checkDocSize(doc(cjk))).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('sits below the ceiling exactly at the ceiling', () => {
    const body = 'a'.repeat(MAX_CONTENT_TEXT_BYTES);
    expect(checkDocSize(doc(body))).toBeNull();
    expect(checkDocSize(doc(`${body}bb`))).toEqual({
      path: 'content',
      reason: 'too_large',
    });
  });

  it('refuses a value it cannot serialise rather than guessing', () => {
    const circular: Record<string, unknown> = { type: 'doc', content: [] };
    circular.self = circular;
    expect(checkDocSize(circular)).toEqual({ path: 'content', reason: 'too_large' });
  });

  it('leaves non-document values to Task 4, which reports them as malformed', () => {
    expect(checkDocSize(null)).toBeNull();
    expect(checkDocSize({ type: 'paragraph' })).toBeNull();
  });

  it('the derived-text ceiling is strictly under the serialised one', () => {
    // If it ever crept above, the derived check would be unreachable and the
    // 54000 would be back.
    expect(MAX_CONTENT_TEXT_BYTES).toBeLessThan(MAX_DOC_BYTES);
    // Pinned, not incidental: this number is also the `CASE` threshold in
    // `server/db/migrations/0001_bound_search_input.sql`, and the margin it
    // buys is measured — the worst of twelve adversarial shapes at this size
    // produced a 808 580-byte lexeme area against a 1 048 575-byte limit.
    expect(MAX_CONTENT_TEXT_BYTES).toBe(500_000);
    expect(MAX_DOC_BYTES).toBe(2 * 1024 * 1024);
  });
});
