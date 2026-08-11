import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { StudioImage } from './ImageNode';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CharacterCount from '@tiptap/extension-character-count';

/**
 * The block schema. Deliberately small and stable — every node here maps to a
 * block type the future backend can store and diff independently.
 */
/**
 * Paste repair.
 *
 * The schema has two heading levels (the article's own <h1> is the title
 * field), so a pasted <h1> would otherwise be silently demoted to a paragraph
 * and the structure of an imported draft would vanish. Remap instead of drop.
 * Table cells are flattened by the schema too, so give them a separator rather
 * than concatenating "cell Acell B".
 */
function repairPastedHTML(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc.querySelectorAll('h1').forEach((el) => rename(doc, el, 'h2'));
  doc.querySelectorAll('h4, h5, h6').forEach((el) => rename(doc, el, 'h3'));

  // Give each row its own block and each cell a visible boundary.
  doc.querySelectorAll('tr').forEach((row) => {
    const cells = [...row.querySelectorAll('th, td')].map((c) =>
      (c.textContent ?? '').trim(),
    );
    const p = doc.createElement('p');
    p.textContent = cells.filter(Boolean).join(' · ');
    row.replaceWith(p);
  });

  return doc.body.innerHTML;
}

function rename(doc: Document, el: Element, tag: string) {
  const next = doc.createElement(tag);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
}

const PasteRepair = Extension.create({
  name: 'pasteRepair',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('pasteRepair'),
        props: {
          transformPastedHTML: (html) => {
            try {
              return repairPastedHTML(html);
            } catch {
              // A parse failure must never block the paste itself.
              return html;
            }
          },
        },
      }),
    ];
  },
});

export const editorExtensions = [
  StarterKit.configure({
    heading: { levels: [2, 3] },
    codeBlock: { HTMLAttributes: { class: 'doc-code' } },
    blockquote: { HTMLAttributes: { class: 'doc-quote' } },
    horizontalRule: { HTMLAttributes: { class: 'doc-rule' } },
    link: false,
    underline: false,
  }),
  Underline,
  Link.configure({
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    protocols: ['http', 'https', 'mailto'],
    HTMLAttributes: { rel: 'noopener noreferrer nofollow', class: 'doc-link' },
  }),
  StudioImage.configure({
    inline: false,
    allowBase64: false,
    HTMLAttributes: { class: 'doc-image' },
  }),
  TaskList.configure({ HTMLAttributes: { class: 'doc-tasks' } }),
  TaskItem.configure({ nested: true }),
  CharacterCount,
  PasteRepair,
  Placeholder.configure({
    placeholder: ({ node }) => {
      if (node.type.name === 'heading') return 'Heading';
      return 'Tell your story…';
    },
    showOnlyWhenEditable: true,
    includeChildren: false,
  }),
];
