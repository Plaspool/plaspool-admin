import { describe, expect, it } from 'vitest';
import { docToText, firstBlockText, summarise } from './doc';
import type { DocNode } from './types';

/**
 * `firstBlockText` / `summarise` — the product overview fallback (migration 0580).
 *
 * THE FIRST TEST IS THE WHOLE REASON THESE FUNCTIONS EXIST. The obvious
 * implementation of "the first line of the description" is
 * `docToText(doc).split('\n')[0]`, and it is wrong in a way no casual fixture
 * reveals: `docToText` collapses every newline into a space, so the split
 * yields the ENTIRE document. A one-paragraph fixture cannot tell the two
 * implementations apart, which is precisely how this ships unnoticed — the same
 * shape as migration 0520's lax-jsonpath doubling.
 */

const doc = (...paragraphs: string[]): DocNode => ({
  type: 'doc',
  content: paragraphs.map((text) => ({
    type: 'paragraph',
    content: text === '' ? [] : [{ type: 'text', text }],
  })),
});

describe('firstBlockText', () => {
  it('returns ONLY the first block, where a naive split would return everything', () => {
    const d = doc('First paragraph.', 'Second paragraph.', 'Third.');

    expect(firstBlockText(d)).toBe('First paragraph.');

    // The trap, pinned: `docToText` has no newlines to split on, so the naive
    // spelling returns the whole document and looks correct on one paragraph.
    expect(docToText(d)).toBe('First paragraph. Second paragraph. Third.');
    expect(docToText(d).split('\n')[0]).not.toBe('First paragraph.');
  });

  it('skips a leading empty block rather than returning nothing', () => {
    // The editor leaves an empty paragraph at the top more often than anyone
    // would like, and the first block of such a document is honestly the first
    // one with words in it.
    expect(firstBlockText(doc('', '  ', 'The real opening.'))).toBe('The real opening.');
  });

  it('is empty for an empty, contentless or nullish document', () => {
    expect(firstBlockText(doc())).toBe('');
    expect(firstBlockText({ type: 'doc' })).toBe('');
    expect(firstBlockText(null)).toBe('');
    expect(firstBlockText(undefined)).toBe('');
  });

  it('flattens marks and nested inline nodes inside the block', () => {
    const d: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Matte ' },
            { type: 'text', text: 'PLA', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' filament.' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Not this.' }] },
      ],
    };
    expect(firstBlockText(d)).toBe('Matte PLA filament.');
  });
});

describe('summarise', () => {
  it('returns a short first block untouched, with no ellipsis', () => {
    expect(summarise(doc('Short enough.'), 300)).toBe('Short enough.');
  });

  it('cuts on a word boundary and never exceeds max', () => {
    const d = doc('aaa bbb ccc ddd eee fff');
    const out = summarise(d, 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out).toBe('aaa bbb…');
    // Never mid-word.
    expect(out).not.toContain('cc…');
  });

  it('hard-cuts a single word longer than max rather than breaking the ceiling', () => {
    // No space to cut at. Returning the whole word would silently exceed a
    // bound the caller is relying on.
    const out = summarise(doc('supercalifragilistic'), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is exactly at the boundary, not one over', () => {
    // 300 characters exactly: no truncation, because `<=` is inclusive.
    const exact = 'x'.repeat(300);
    expect(summarise(doc(exact), 300)).toBe(exact);
    expect(summarise(doc('x'.repeat(301)), 300).length).toBeLessThanOrEqual(300);
  });
});
