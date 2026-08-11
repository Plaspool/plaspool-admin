/**
 * Document limits shared by the client and the server (spec §4.6).
 *
 * SCOPE. This file is Task 4's home for `ALLOWED_NODES`, `ALLOWED_MARKS` and
 * `validateDoc`. Only the size ceilings live here yet, because they are what
 * the database physically requires — `DocViolation` is declared in the shape
 * Task 4 will extend so the reasons do not have to be renamed later.
 */
import { docToText, isValidDoc } from './doc';

/** Serialised `content`, spec §4.6. */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;

/** Spec §4.6. Enforced by Task 4's `validateDoc`. */
export const MAX_DOC_DEPTH = 40;

/** Spec §4.6. Enforced by Task 4's `validateDoc`. */
export const MAX_DOC_NODES = 20_000;

/**
 * The ceiling on `docToText(content)` — the `posts.content_text` column, and
 * therefore the input to the generated `search` tsvector.
 *
 * THIS IS NOT A STYLE CHOICE, IT IS THE DATABASE'S LIMIT. A `tsvector` cannot
 * hold more than MAXSTRPOS = 1 048 575 bytes of lexemes and positions; past
 * that Postgres raises SQLSTATE 54000 and the row cannot be written at all.
 * Without a ceiling here a document this validator calls VALID — comfortably
 * under `MAX_DOC_BYTES` — is physically unstorable, and because the failure is
 * on an UPDATE it makes an existing post permanently unwritable rather than
 * merely refusing a new one.
 *
 * **Bytes, not characters.** `left(content_text, n)` in SQL counts characters,
 * so a character ceiling bounds nothing for multibyte text: 600 000 CJK
 * characters are 1.4 MB and still raise 54000 (measured on PGlite 18.3).
 *
 * **Why 500 000.** The worst of twelve adversarial shapes measured at this size
 * (2/3/4/5/6/8-character ASCII tokens, and 1/2/3-character tokens over 2-byte
 * and 3-byte alphabets) produced a 808 580-byte lexeme area — 22.9% under the
 * limit. Ordinary prose is nowhere near: lexemes dedupe, so 2 MB of an
 * eight-word vocabulary is a 1 572-byte tsvector. The shapes that get close are
 * the high-diversity ones — a glossary, an index, an SKU table, a changelog of
 * hashes, a CSV paste.
 *
 * The same number is the `CASE` threshold in
 * `server/db/migrations/0001_bound_search_input.sql`, and the two must stay
 * equal. The validator rejects at exactly the point the database starts
 * truncating, so a document that passes here is always indexed whole, and the
 * database's truncation branch is reachable only by a row that never came
 * through this validator — an import, a backfill, manual SQL.
 */
export const MAX_CONTENT_TEXT_BYTES = 500_000;

/**
 * Task 4 extends `reason` with the allow-list and structural failures
 * (`unknown_node`, `unknown_mark`, `bad_protocol`, `too_deep`,
 * `too_many_nodes`, `malformed`). `too_large` is spelled here now because it is
 * the one the storage layer forces.
 */
export interface DocViolation {
  /** JSON path of the offending node, or `content` for a whole-document limit. */
  path: string;
  reason: 'too_large';
}

/** UTF-8 length. `String.length` counts UTF-16 units and undercounts by up to 3× . */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The two size ceilings, checked without walking the document.
 *
 * Returns the violation rather than throwing, so a route can map it straight
 * onto the 422 `{ error: 'invalid_document', path }` of spec §8. Both are
 * checked here because they fail for different reasons and neither implies the
 * other: `MAX_DOC_BYTES` bounds what the request body and the `jsonb` column
 * carry, `MAX_CONTENT_TEXT_BYTES` bounds what the search index can be built
 * from, and a document can be small in one and over the line in the other.
 */
export function checkDocSize(value: unknown): DocViolation | null {
  let serialised: string;
  try {
    serialised = JSON.stringify(value) ?? '';
  } catch {
    // Circular or otherwise unserialisable. Task 4's `validateDoc` reports this
    // as `malformed`; until then, too_large is the honest answer for "we cannot
    // measure it, so we will not store it".
    return { path: 'content', reason: 'too_large' };
  }
  if (utf8Bytes(serialised) > MAX_DOC_BYTES) {
    return { path: 'content', reason: 'too_large' };
  }
  // `docToText` walks `content` arrays; anything that is not a document shape
  // is Task 4's `malformed`, not this function's business.
  if (!isValidDoc(value)) return null;
  if (utf8Bytes(docToText(value)) > MAX_CONTENT_TEXT_BYTES) {
    return { path: 'content', reason: 'too_large' };
  }
  return null;
}
