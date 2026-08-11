/**
 * The document derivations moved to `shared/doc.ts` so `server/` can derive
 * `content_text`, word counts and excerpts identically. This shim keeps every
 * existing frontend import working.
 */
export * from '../../shared/doc';
