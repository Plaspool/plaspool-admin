// @vitest-environment jsdom
/**
 * The checklist DOM contract.
 *
 * One stylesheet (styles/prose.css) draws both the editor surface and the
 * published article, which only holds while both surfaces build the same
 * boxes. The editor's half is not ours to change: TipTap's TaskItem node view
 * emits `li > label(input + span) + div`, and the empty <span> is load-bearing
 * — a label without it lays out differently. So this pins DocRenderer to that
 * shape. Geometry (baseline offset, indent, contrast) is measured in a real
 * browser; this file guards only the structure those measurements assume.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DocRenderer } from '../../components/DocRenderer';
import type { DocNode } from '../../data/types';

const paragraph = (text: string): DocNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const taskItem = (text: string, checked: boolean, ...rest: DocNode[]): DocNode => ({
  type: 'taskItem',
  attrs: { checked },
  content: [paragraph(text), ...rest],
});

const taskList = (...items: DocNode[]): DocNode => ({ type: 'taskList', content: items });

const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });

/** Asserts the node-view shape on one <li>, and hands back its content div. */
function expectTaskItemShape(item: Element): HTMLDivElement {
  expect(item.tagName).toBe('LI');
  // The checked state lives on the <li> because that is what the strikethrough
  // and the editor's node view both key off.
  expect(item.hasAttribute('data-checked')).toBe(true);
  expect(item.children.length).toBe(2);

  const label = item.children[0];
  const content = item.children[1];
  expect(label.tagName).toBe('LABEL');
  expect(content.tagName).toBe('DIV');

  expect(label.children.length).toBe(2);
  const input = label.children[0] as HTMLInputElement;
  const styler = label.children[1];
  expect(input.tagName).toBe('INPUT');
  expect(input.type).toBe('checkbox');
  // The reader never mutates the document, so the box is display-only.
  expect(input.readOnly).toBe(true);
  expect(styler.tagName).toBe('SPAN');
  expect(styler.childNodes.length).toBe(0);

  return content as HTMLDivElement;
}

describe('checklist rendering', () => {
  it('emits the node-view shape: li[data-checked] > label(input + span) + div', () => {
    const { container } = render(<DocRenderer doc={doc(taskList(taskItem('Ship it', false)))} />);

    const list = container.querySelector('ul.doc-tasks');
    expect(list).not.toBeNull();
    expect(list!.children.length).toBe(1);

    const item = list!.children[0];
    expect(item.getAttribute('data-checked')).toBe('false');
    const content = expectTaskItemShape(item);
    expect(content.textContent).toBe('Ship it');
    expect((item.querySelector('input') as HTMLInputElement).checked).toBe(false);
  });

  it('reflects the checked attribute on both the li and the input', () => {
    const { container } = render(<DocRenderer doc={doc(taskList(taskItem('Done', true)))} />);

    const item = container.querySelector('li')!;
    expect(item.getAttribute('data-checked')).toBe('true');
    expectTaskItemShape(item);
    expect((item.querySelector('input') as HTMLInputElement).checked).toBe(true);
  });

  it('carries the data-type attributes TipTap serialises, so it parses back', () => {
    const { container } = render(<DocRenderer doc={doc(taskList(taskItem('Round trip', false)))} />);

    expect(container.querySelector('ul')!.getAttribute('data-type')).toBe('taskList');
    expect(container.querySelector('li')!.getAttribute('data-type')).toBe('taskItem');
  });

  it('keeps a nested taskList inside its parent item, after the paragraph', () => {
    const nested = taskList(taskItem('Child', true));
    const { container } = render(
      <DocRenderer doc={doc(taskList(taskItem('Parent', false, nested)))} />,
    );

    const parent = container.querySelector('li')!;
    const parentContent = expectTaskItemShape(parent);

    // TaskItem is configured `nested: true`, so the sub-list is a sibling of
    // the paragraph inside the content div — which is where its indent comes
    // from, one checkbox column in from its parent's.
    expect(parentContent.children.length).toBe(2);
    expect(parentContent.children[0].tagName).toBe('P');

    const sublist = parentContent.children[1];
    expect(sublist.tagName).toBe('UL');
    expect(sublist.classList.contains('doc-tasks')).toBe(true);

    const child = sublist.children[0];
    expect(child.getAttribute('data-checked')).toBe('true');
    expect(expectTaskItemShape(child).textContent).toBe('Child');
  });
});
