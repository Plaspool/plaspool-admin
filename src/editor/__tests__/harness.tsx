/**
 * Shared rig for the block-schema tests.
 *
 * Everything here exists to drive the *real* editor rather than a mock of it:
 * a real ProseMirror view, the real input-rule plugin, the real keymap chain,
 * the real Dexie write path and the real reader component. A block that only
 * works when a test hand-writes its JSON is a block that does not work.
 */
import { Editor } from '@tiptap/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { editorExtensions } from '../extensions';
import { BLOCK_TYPES, type BlockContext, type BlockType } from '../BlockMenu';
import { DocRenderer } from '../../components/DocRenderer';
import { db } from '../../data/db';
import { createPost, savePost } from '../../data/posts';
import { IDB_SCHEME } from '../../data/doc';
import type { DocNode, Post } from '../../data/types';

/** What an inline image looks like once its bytes are in the local store. */
export const IMAGE_SRC = `${IDB_SCHEME}img_test`;

/**
 * One editor, guaranteed destroyed.
 *
 * `editorExtensions` is a module-level array of extension *instances*, so two
 * live editors would share them. Every case therefore builds and tears down
 * inside this scope rather than holding an editor open across tests.
 */
export function withEditor<T>(fn: (editor: Editor) => T): T {
  const editor = new Editor({
    extensions: editorExtensions,
    element: document.createElement('div'),
  });
  try {
    return fn(editor);
  } finally {
    editor.destroy();
  }
}

/**
 * Type text the way a person does, one character at a time, through the view's
 * `handleTextInput` prop.
 *
 * This is the mechanism that matters. `insertContent` writes to the document
 * directly and never consults the input-rule plugin, so every markdown
 * shorthand would silently stay literal text and the shorthand half of this
 * suite would pass without testing anything. The "the rig itself" suite in
 * blocks.test.tsx fails loudly if this stops firing input rules.
 *
 * `handleTextInput` takes a fifth argument in this version of
 * prosemirror-view: the transaction the editor would have applied had no
 * handler claimed the keystroke. Passing the real one — rather than dropping
 * the parameter — keeps this on the same path the view itself takes, and it is
 * the same transaction the fallback below dispatches.
 */
export function type(editor: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const deflt = () => editor.state.tr.insertText(ch, from, to);
    const handled = editor.view.someProp('handleTextInput', (f) =>
      f(editor.view, from, to, ch, deflt),
    );
    if (!handled) editor.view.dispatch(deflt());
  }
}

export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/**
 * Press a key through the view's `handleKeyDown` prop chain.
 *
 * Deliberately not `editor.commands.keyboardShortcut(...)`: that runs only the
 * shortcuts TipTap extensions registered, whereas `handleKeyDown` walks every
 * plugin's handler in the order a real keydown does — extension keymaps, the
 * list keymap, the table keymap and ProseMirror's base keymap included.
 * Backspace-lifts-a-quote and Enter-leaves-a-list both live in that tail.
 *
 * Returns whether the editor consumed the key.
 */
export function press(editor: Editor, key: string, mods: Mods = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: !!mods.shift,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  });
  return !!editor.view.someProp('handleKeyDown', (f) => f(editor.view, event));
}

/**
 * `getJSON()` is typed `JSONContent`, whose `type` is optional; `DocNode`
 * requires it. The document root always carries `type: 'doc'`, so the widening
 * is sound — but it has to be spelled out rather than inferred.
 */
export function asDoc(editor: Editor): DocNode {
  return editor.getJSON() as unknown as DocNode;
}

/** The palette entry for an id, or a loud failure if the menu lost it. */
export function blockType(id: string): BlockType {
  const block = BLOCK_TYPES.find((b) => b.id === id);
  if (!block) throw new Error(`BLOCK_TYPES has no entry with id "${id}"`);
  return block;
}

/** Invoke a palette entry exactly as `BlockMenu` and `SlashMenu` do. */
export function runBlock(id: string, editor: Editor, ctx?: BlockContext) {
  blockType(id).run(editor, ctx ?? { insertImage: () => {} });
}

/** The reader's output for a document, as a string. */
export function renderDoc(doc: DocNode): string {
  return renderToStaticMarkup(<DocRenderer doc={doc} />);
}

export async function emptyDb() {
  await db.posts.clear();
  await db.revisions.clear();
  await db.images.clear();
}

/**
 * Editor → Dexie → back. The whole point of the block tests: whatever the
 * editor produced has to survive the persistence layer and still be something
 * the reader understands.
 */
export async function roundTrip(content: DocNode): Promise<Post> {
  const created = await createPost();
  await savePost(created.id, { content });
  const stored = await db.posts.get(created.id);
  if (!stored) throw new Error('the post did not survive savePost');
  return stored;
}

/**
 * `BlockMenu`'s `shouldShow` predicate, duplicated verbatim.
 *
 * It is an inline arrow passed to `<FloatingMenu shouldShow>`, it is not
 * exported, and BlockMenu.tsx is not ours to change. This copy is pinned by
 * tests that drive a real selection into each context — so if the original
 * drifts these tests keep passing, and the duplication is then the bug. Kept
 * character-for-character with the source so a diff between them is obvious.
 */
export function canShowBlockMenu(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || !editor.isEditable) return false;
  const parent = $from.parent;
  return (
    parent.content.size === 0 &&
    (parent.type.name === 'paragraph' || parent.type.name === 'heading') &&
    $from.depth === 1
  );
}

// ------------------------------------------------------------- doc builders

export const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });

export const para = (text?: string): DocNode =>
  text === undefined
    ? { type: 'paragraph' }
    : { type: 'paragraph', content: [{ type: 'text', text }] };
