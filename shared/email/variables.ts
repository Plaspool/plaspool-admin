/**
 * THE TEMPLATE PLACEHOLDER VOCABULARY, AND THE ONE GATE BUILT ON IT, decided
 * once for both sides of the wire.
 *
 * `{{unsubscribe_url}}` is the variable that decides whether a broadcast may be
 * sent at all. The server refuses the send (`server/routes/email.ts`
 * `assertSendable`); the admin screen warns while the template is still being
 * written, so the refusal is visible before somebody reaches for a button that
 * then 412s. That is two implementations of one rule, and they had already
 * drifted: the server scanned with the same whitespace-tolerant pattern it
 * substitutes with, while the client scanned for the exact literal
 * `{{unsubscribe_url}}`. A template written `{{ unsubscribe_url }}` renders
 * correctly and the server would send it — but the editor showed a red "no
 * unsubscribe link" warning the operator had no way to clear.
 *
 * THAT DIVERGENCE COULD ONLY EVER PRODUCE A FALSE WARNING, never an unlawful
 * send, because the server holds the real gate and was the more permissive
 * reader of the two. It is fixed here anyway, and in this direction — one
 * predicate, imported by both — because a warning an operator cannot clear is a
 * warning they learn to ignore, and because the next person to touch either copy
 * has no way to know the other one exists. This is the same arrangement
 * `shared/marketing/banners.ts` uses for the derived banner status, for the same
 * reason.
 *
 * `basket`/`basket_total`/`basket_url` WIDEN THE VOCABULARY, NOT THE GATE. They
 * joined `name`/`unsubscribe_url` so a "not bought yet" nudge can carry the
 * reader's own basket; `TEMPLATE_BLOCKS` below is the one further distinction
 * that vocabulary needs, and it is a security boundary rather than a courtesy —
 * see its own comment.
 *
 * NO IMPORTS, NO NODE, NO DOM. `src/data/api-email.ts` pulls this into the
 * browser bundle, so it is typechecked under `tsconfig.app.json`, whose `types`
 * is `["vite/client"]` — `process` and `Buffer` do not exist here.
 */

/** Everything the server knows how to put in a message. */
export const TEMPLATE_VARIABLES = [
  'name',
  'unsubscribe_url',
  'basket',
  'basket_total',
  'basket_url',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/**
 * The names that are MARKUP this server generated, not values somebody typed.
 *
 * The distinction is a security boundary rather than a convenience, and
 * `server/mail/transactional.ts` states it at length for system mail: scalars
 * are escaped into HTML because a product title is a field an operator typed;
 * blocks are inserted raw because escaping them would show the reader a
 * screenful of `&lt;table&gt;`. Nothing a customer or an operator supplies can
 * become a block — the map is built by name, from this closed set, and every
 * name in it is also in `TEMPLATE_VARIABLES` above so the save-time gate does
 * not need to know the difference between the two kinds at all.
 *
 * A block is also unavailable to a subject line, which `renderSubject` in
 * `server/email/render.ts` enforces by never handing `substitute` any blocks
 * when it renders one.
 */
export const TEMPLATE_BLOCKS = ['basket'] as const;

export type TemplateBlock = (typeof TEMPLATE_BLOCKS)[number];

/** True if `name` is one of the closed set of block placeholders — markup this
 *  server generated, never a value somebody typed. */
export function isTemplateBlock(name: string): name is TemplateBlock {
  return (TEMPLATE_BLOCKS as readonly string[]).includes(name);
}

/**
 * `{{…}}` WITH NO NESTED BRACE, which bounds what one placeholder can be.
 *
 * An unclosed `{{` therefore cannot swallow the document as far as the next `}}` a
 * hundred lines below it: the pattern simply does not match, and `{{name` stays in
 * the message as literal text. A stray extra brace, `{{{name}}}`, substitutes the
 * inner placeholder and leaves the outer braces alone, so the reader sees `{Ada}`.
 *
 * NEITHER OF THOSE IS SILENT, and that is the property being bought rather than a
 * limitation being apologised for. Every way of mistyping a placeholder ends up
 * VISIBLE in the message — which is the failure mode that gets reported and fixed,
 * as against a renderer that swallows the mistake and produces a message that reads
 * fine and says the wrong thing.
 *
 * A FUNCTION RATHER THAN A SHARED `const`, now that this crosses a module
 * boundary. A `/g` regex carries `lastIndex` as mutable state, and `matchAll`
 * *reads* it — so one caller anywhere doing `PLACEHOLDER.test(x)` would leave
 * the index parked past the first match and make every later scan in the process
 * silently start halfway through its own input. Inside one file that hazard is
 * reviewable; exported to two codebases it is not, and the cure costs an
 * allocation nobody can measure.
 */
export const placeholderPattern = (): RegExp => /\{\{([^{}]*)\}\}/g;

/** True if `name` is a variable this system can substitute. Callers pass the
 * TRIMMED capture — `{{ name }}` and `{{name}}` are the same variable. */
export function isTemplateVariable(name: string): name is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(name);
}

/**
 * True if `{{unsubscribe_url}}` appears at all.
 *
 * WHITESPACE-TOLERANT, BECAUSE THE RENDERER IS. `substitute` trims the capture
 * before it dispatches, so `{{ unsubscribe_url }}` is substituted with the real
 * URL and the reader gets a working link. A check that read the exact literal
 * instead would be answering a different question from the one that matters —
 * not "will this message carry a way out?" but "was it typed the way I expected?"
 */
export function hasUnsubscribeVariable(source: string): boolean {
  for (const match of source.matchAll(placeholderPattern())) {
    if (match[1].trim() === 'unsubscribe_url') return true;
  }
  return false;
}

/**
 * True if a body would need a basket resolved for it. Whitespace-tolerant, for
 * the reason `hasUnsubscribeVariable` above is: a template written
 * `{{ basket }}` carries a basket exactly as much as one written `{{basket}}`,
 * and a check that missed the spaced form would tell a caller "nothing to
 * resolve" about a template that plainly asks for one.
 *
 * A caller resolves a basket by EMAIL ADDRESS (`basketFor` in
 * `server/shop/admin/prospects.ts`), which is per-recipient and not free, so
 * this exists for the caller that needs to decide WHETHER to pay that cost
 * before it does — a broadcast with no `{{basket}}` anywhere has nothing to
 * gain from looking one up for every recipient.
 */
export function usesBasket(source: string): boolean {
  for (const match of source.matchAll(placeholderPattern())) {
    if (match[1].trim() === 'basket') return true;
  }
  return false;
}

/**
 * The one BLOCK name populated from the same per-recipient lookup as the two
 * scalars below — kept apart from `TEMPLATE_BLOCKS` above ON PURPOSE.
 * `TEMPLATE_BLOCKS` is EVERY block this server knows how to render, `basket`
 * today; `BASKET_VARIABLE_NAMES` below must only ever widen with a
 * basket-shaped name, never with every future block regardless of what it is
 * about. The day a `{{products}}` or `{{recommendations}}` block joins
 * `TEMPLATE_BLOCKS`, deriving `BASKET_VARIABLE_NAMES` from that array instead
 * of from this one would silently make `needsBasket` true for a template that
 * never mentions a basket at all — and because a skip is TERMINAL
 * (`markRecipientSkipped`, `server/email/repo.ts`), every recipient with an
 * empty basket would be skipped from a message that had nothing to do with
 * their basket, and never mailed at all.
 */
export const BASKET_BLOCKS = ['basket'] as const;

/**
 * The two SCALAR names populated from the same per-recipient lookup as
 * `basket`, even though neither one is a block — see `TemplateValues` in
 * `server/email/render.ts`. Named here, once, so `needsBasket` below is a
 * list-membership test rather than three hard-coded string comparisons: a
 * later basket variable joins this array (or `BASKET_BLOCKS` above, if it is
 * a block) and `needsBasket` widens with it, rather than staying narrow the
 * way three separate `=== '…'` checks would if a name were added to
 * `TEMPLATE_VARIABLES` above and simply forgotten here.
 */
export const BASKET_SCALARS = ['basket_total', 'basket_url'] as const;

const BASKET_VARIABLE_NAMES: readonly string[] = [...BASKET_BLOCKS, ...BASKET_SCALARS];

/**
 * True if a body needs a recipient's basket resolved for it AT ALL — every
 * name that comes from that one lookup, not only the `{{basket}}` block
 * `usesBasket` above answers for.
 *
 * `usesBasket` MATCHES ONLY THE BLOCK, which is exactly right for what it is
 * named — but `drainBroadcast` (`server/email/send.ts`) uses that same answer
 * to decide something bigger: whether to look a basket up AT ALL, and
 * therefore whether to SKIP a recipient whose basket has since emptied. A
 * template written "Your basket is worth {{basket_total}} — {{basket_url}}"
 * carries neither the block nor anything `usesBasket` would see, and yet it
 * depends on the reader's basket exactly as much as one that prints the
 * block. Deciding `drainBroadcast`'s basket need from `usesBasket` alone
 * leaves such a template's basket unresolved: the reader sees literal
 * `{{basket_total}}` braces, and — the exact failure this whole feature
 * exists to prevent — NOBODY IS SKIPPED, so a person who has already paid
 * still receives a message about the basket they left behind.
 *
 * DERIVED FROM `BASKET_BLOCKS` PLUS `BASKET_SCALARS` ABOVE — NEVER FROM
 * `TEMPLATE_BLOCKS`, which is every block this server knows, not only the
 * basket one — so a later basket variable cannot silently reopen this hole
 * the way this one opened it: add the name to `BASKET_BLOCKS` (if it is a
 * block) or `BASKET_SCALARS` (if it is a scalar) and this function widens
 * with it.
 *
 * WHITESPACE-TOLERANT, for the reason `usesBasket` and `hasUnsubscribeVariable`
 * both are: `{{ basket_total }}` depends on the basket exactly as much as
 * `{{basket_total}}` does, and a check that missed the spaced form would tell
 * a caller "nothing to resolve" about a template that plainly needs one.
 *
 * `usesBasket` ITSELF DOES NOT CHANGE. It keeps meaning "uses the block" —
 * a narrower, different question other callers may still depend on.
 */
export function needsBasket(source: string): boolean {
  for (const match of source.matchAll(placeholderPattern())) {
    if (BASKET_VARIABLE_NAMES.includes(match[1].trim())) return true;
  }
  return false;
}
