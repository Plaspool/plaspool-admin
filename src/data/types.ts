/**
 * The domain model moved to `shared/types.ts` so `server/` can import the same
 * definitions. This shim keeps every existing frontend import working.
 */
export * from '../../shared/types';
