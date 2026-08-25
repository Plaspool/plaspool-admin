import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface Match {
  from: number;
  to: number;
}

export interface FindState {
  query: string;
  caseSensitive: boolean;
  index: number;
  matches: Match[];
}

const EMPTY: FindState = { query: '', caseSensitive: false, index: 0, matches: [] };

export const findKey = new PluginKey<FindState>('findReplace');

/**
 * Flatten the document's text with a map back to document positions.
 *
 * Searching each text node separately would miss any match that crosses a mark
 * boundary — "**find** me" is two text nodes, and "find me" would never match.
 * A newline is pushed when a new block starts so a match cannot span two
 * paragraphs, which is what a reader would consider two separate places.
 */
function flatten(doc: PMNode): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i += 1) map.push(pos + i);
      text += node.text;
    } else if (node.isBlock && text.length && !text.endsWith('\n')) {
      text += '\n';
      map.push(pos);
    }
    return true;
  });
  return { text, map };
}

export function findMatches(doc: PMNode, query: string, caseSensitive: boolean): Match[] {
  if (!query) return [];
  const { text, map } = flatten(doc);
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: Match[] = [];
  let at = hay.indexOf(needle);
  // Bounded so a pathological document can't hang the typing path.
  while (at !== -1 && out.length < 5000) {
    const from = map[at];
    const last = map[at + needle.length - 1];
    if (from !== undefined && last !== undefined) out.push({ from, to: last + 1 });
    at = hay.indexOf(needle, at + Math.max(needle.length, 1));
  }
  return out;
}

/**
 * Find and replace, scoped to the document.
 *
 * Kept out of the browser's own find because that one searches the chrome as
 * well as the writing, cannot replace, and scrolls to matches inside collapsed
 * panels. Replace-all is deliberately a single transaction: `onUpdate` walks
 * the whole document to recount words on every transaction, so replacing 200
 * matches one at a time would re-open the "typing cost scales with document
 * length" regression that Round 1 fixed.
 */
export const FindReplace = Extension.create({
  name: 'findReplace',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply(tr, prev, _old, next) {
            const meta = tr.getMeta(findKey) as Partial<FindState> | undefined;
            if (!meta && !tr.docChanged) return prev;
            const merged = { ...prev, ...meta };
            const matches = findMatches(next.doc, merged.query, merged.caseSensitive);
            return {
              ...merged,
              matches,
              index: matches.length ? Math.min(merged.index, matches.length - 1) : 0,
            };
          },
        },
        props: {
          decorations(state) {
            const f = findKey.getState(state);
            if (!f || !f.matches.length) return null;
            return DecorationSet.create(
              state.doc,
              f.matches.map((m, i) =>
                Decoration.inline(m.from, m.to, {
                  class: i === f.index ? 'find-hit is-current' : 'find-hit',
                }),
              ),
            );
          },
        },
      }),
    ];
  },
});

/** Only exported so the bar can drive the plugin without reaching into it. */
export function setFind(tr: Transaction, patch: Partial<FindState>): Transaction {
  return tr.setMeta(findKey, patch);
}

export function getFind(state: EditorState): FindState {
  return findKey.getState(state) ?? EMPTY;
}
