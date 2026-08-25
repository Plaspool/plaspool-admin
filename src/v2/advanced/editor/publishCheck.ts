import type { DocNode, Post } from '../data/types';
import { IDB_SCHEME } from '../data/doc';
import { isAllowedHref, isAllowedImageSrc } from '../data/docguards';

export interface PublishWarning {
  id: string;
  message: string;
}

/**
 * The things worth knowing before a post goes public.
 *
 * Every one of these is a *warning*, never a block. A writer who wants to
 * publish something with a missing excerpt has a reason, and an editor that
 * refuses is an editor people learn to route around. The job here is to make
 * the cost visible at the moment it can still be paid cheaply.
 *
 * Pure over `Post` so it can be tested without an editor instance, and so a
 * server could eventually run the same list against a submitted document.
 */
export function publishWarnings(post: Post): PublishWarning[] {
  const out: PublishWarning[] = [];
  const headings: number[] = [];
  let missingAlt = 0;
  let remote = 0;
  let brokenLinks = 0;

  const walk = (n: DocNode) => {
    if (n.type === 'heading') headings.push(Number(n.attrs?.level) || 2);
    if (n.type === 'image') {
      const src = String(n.attrs?.src ?? '');
      if (!String(n.attrs?.alt ?? '').trim()) missingAlt += 1;
      if (!src.startsWith(IDB_SCHEME) && isAllowedImageSrc(src)) remote += 1;
    }
    for (const mark of n.marks ?? []) {
      if (mark.type !== 'link') continue;
      const href = String(mark.attrs?.href ?? '').trim();
      // A link to nothing, to the page it is already on, or to a protocol the
      // reader will strip anyway — all of them render as text that looks
      // clickable and isn't.
      if (!href || href === '#' || /^https?:\/\/?$/i.test(href) || !isAllowedHref(href)) {
        brokenLinks += 1;
      }
    }
    n.content?.forEach(walk);
  };
  walk(post.content);

  if (missingAlt) {
    out.push({
      id: 'alt',
      message: `${missingAlt} ${missingAlt === 1 ? 'image has' : 'images have'} no alt text — readers using a screen reader will be told nothing about ${missingAlt === 1 ? 'it' : 'them'}.`,
    });
  }
  if (remote) {
    out.push({
      id: 'remote',
      message: `${remote} ${remote === 1 ? 'image is' : 'images are'} loaded from another site. ${remote === 1 ? 'It' : 'They'} will break if that site removes ${remote === 1 ? 'it' : 'them'}, and ${remote === 1 ? 'it is' : 'they are'} not in your backups.`,
    });
  }
  if (!post.excerpt.trim()) {
    out.push({
      id: 'excerpt',
      message: 'There is no excerpt, so listings and link previews will have nothing to show.',
    });
  }
  if (!post.category.trim()) {
    out.push({
      id: 'category',
      message: 'No category — this post won’t appear under any of them.',
    });
  }

  // A document that opens at h3, or jumps h2 → (nothing) → h3 before any h2,
  // reads to a screen reader as a section with no parent.
  const firstH2 = headings.indexOf(2);
  const firstH3 = headings.indexOf(3);
  if (firstH3 !== -1 && (firstH2 === -1 || firstH3 < firstH2)) {
    out.push({
      id: 'headings',
      message:
        'A subheading appears before any heading. Screen readers use that nesting to navigate, so start the section with a Heading.',
    });
  }

  if (brokenLinks) {
    out.push({
      id: 'links',
      message: `${brokenLinks} ${brokenLinks === 1 ? 'link points' : 'links point'} nowhere usable and will render as plain text.`,
    });
  }

  return out;
}
