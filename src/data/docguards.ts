import type { DocNode } from './types';

/**
 * Document guards the *client* enforces: what counts as an empty document, and
 * what counts as a safe URL.
 *
 * These live here rather than in `shared/doc.ts` because they are decisions
 * about this app's surfaces — the editor's exit path and the reader's
 * allow-list — not derivations the server has to reproduce byte-for-byte. If a
 * server ever sanitises foreign documents it will need its own copy of the URL
 * rule; that is recorded in ARCHITECTURE.md § TODO — future backend.
 */

/**
 * Structural emptiness — a different question from `wordCount === 0`.
 *
 * An image-only or divider-only document has no words at all. Treating that as
 * blank is how a draft holding a just-uploaded photo was destroyed, along with
 * its image bytes, the moment the writer clicked "Posts": `isBlankDraft` said
 * yes, `discardIfBlank` called `destroyPost`, and `collectOrphanImages` swept
 * the blob. No confirmation, no grace period, no undo — in an app whose only
 * destructive operation is supposed to be user-confirmed.
 *
 * Deliberately an allow-list. A deny-list ("no image, no rule, no table…")
 * silently re-opens the hole the next time a node type joins the schema. Here
 * an unrecognised node counts as content, which is the safe direction to fail.
 */
const BLANK_DOC_NODES = new Set(['doc', 'paragraph', 'text']);

export function isBlankDoc(doc: DocNode | null | undefined): boolean {
  if (!doc) return true;
  let blank = true;
  const walk = (n: DocNode) => {
    if (!blank) return;
    if (!BLANK_DOC_NODES.has(n.type)) {
      blank = false;
      return;
    }
    if (typeof n.text === 'string' && n.text.trim() !== '') {
      blank = false;
      return;
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return blank;
}

/**
 * One URL allow-list, enforced on both sides of the app.
 *
 * TipTap's Link `protocols` option only *appends* to a hardcoded baseline that
 * already contains `tel`, `ftp`, `xmpp` and `sms`, so configuring it restricted
 * nothing: the editor accepted links the reader then silently stripped of their
 * anchor, leaving bare text where the writer saw a link. The editor and the
 * article have to agree about what a link is — ARCHITECTURE.md §5.
 *
 * The link rule now LIVES IN `shared/validate.ts` and is re-exported here, so
 * the server applies the identical predicate. `shared/` cannot import from
 * `src/`, and a second copy of the regex on the server is exactly the drift the
 * shared module exists to prevent. Every existing frontend import is unchanged.
 */
export { ALLOWED_LINK_PROTOCOLS, isAllowedHref } from '../../shared/validate';
import { isStorableImageSrc } from '../../shared/validate';

/**
 * The image rule, and it is the SAME OBJECT the server validates against.
 *
 * This used to be a second array declared here, with a comment saying the two
 * lists differed on purpose because `isStorableImageSrc` refused `http:`. That
 * difference was not a policy, it was a **permanent 422**: the editor keeps an
 * `http:` image through paste, `savePost` validates on every save, and spec §8
 * makes a validation refusal a permanent stop — so one pasted image made the
 * post unsavable forever and the writer kept typing into something that could
 * never be persisted. Two lists that are supposed to be equal are exactly the
 * drift this codebase has paid for three times (the link allow-list, twice).
 *
 * So there is one list, it lives where the server can read it, and the alias
 * below keeps every existing frontend import unchanged.
 */
export { STORABLE_IMAGE_PROTOCOLS as ALLOWED_IMAGE_PROTOCOLS } from '../../shared/validate';
export { isStorableImageSrc as isAllowedImageSrc } from '../../shared/validate';

/** True for a URL that points off this device — i.e. one that breaks offline. */
export function isRemoteSrc(value: unknown): boolean {
  return isStorableImageSrc(value);
}
