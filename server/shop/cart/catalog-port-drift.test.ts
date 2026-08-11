/**
 * `CatalogPort` is declared TWICE, and the two must not drift.
 *
 * ═══ THE SEAM ═══
 * `shared/commerce/ports.ts` carries an inline `CatalogPort` block (contract §5
 * puts it there) and also `export * from './catalog-port'` (Catalog moved its
 * declaration into a file it owns after `ports.ts` was clobbered twice —
 * A-CAT-009). A local export SHADOWS a star re-export silently: no error, no
 * warning, no ambiguity reported. So
 *
 *     import type { CatalogPort } from 'shared/commerce/ports'         → the inline copy
 *     import type { CatalogPort } from 'shared/commerce/catalog-port'  → Catalog's copy
 *
 * are different types with the same name, and which one a consumer gets depends
 * on which path it happened to type. Catalog's `port.ts` implements the second;
 * Cart consumes the second. Nothing points at the first, and nothing would say
 * so if it drifted.
 *
 * They are identical today — verified by this file rather than by reading — so
 * the cost of the duplication is currently zero and entirely latent. That is
 * precisely the shape GAUNTLET.md records in every round: two things that have
 * to agree, with nothing checking that they do. Amendment A-011 asks for the
 * inline block to be deleted; until it is, this fails the moment they diverge.
 *
 * TEXT COMPARISON AND NOT A TYPE ASSIGNABILITY CHECK, deliberately. Structural
 * assignability is exactly what would NOT catch the interesting drift: a field
 * added to one and not the other still assigns in one direction, and a doc
 * comment that stops matching the behaviour assigns in both.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PORTS = 'shared/commerce/ports.ts';
const CATALOG_PORT = 'shared/commerce/catalog-port.ts';

/** The declaration of `name`, from `export` to its closing brace at column 0. */
function declaration(file: string, name: string): string | null {
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const start = source.search(new RegExp(`^export (?:interface|type) ${name}\\b`, 'm'));
  if (start < 0) return null;
  const rest = source.slice(start);
  // `}` at column 0 for an interface; `;` at the end of a line for a type alias
  // union, which is how `ReservationResult` is written.
  const end = rest.search(/\n\}|;\n/);
  return rest
    .slice(0, end < 0 ? undefined : end + 2)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SHARED_NAMES = ['VariantQuote', 'ReservationRequest', 'ReservationResult', 'CatalogPort'];

describe('the two CatalogPort declarations', () => {
  it('both exist — the duplication is real, not imagined', () => {
    // If this goes red because the inline block is GONE, that is A-011 being
    // resolved: delete this file's first two cases and keep the third.
    for (const name of SHARED_NAMES) {
      expect(declaration(PORTS, name), `${PORTS} ${name}`).not.toBeNull();
      expect(declaration(CATALOG_PORT, name), `${CATALOG_PORT} ${name}`).not.toBeNull();
    }
  });

  it('are byte-identical once comments and whitespace are removed', () => {
    for (const name of SHARED_NAMES) {
      expect(declaration(PORTS, name), name).toBe(declaration(CATALOG_PORT, name));
    }
  });

  it('ports.ts re-exports the file it duplicates, which is what makes it silent', () => {
    // Without the star re-export the duplication would be two unrelated modules
    // and a consumer would have to choose one on purpose. WITH it, both names
    // are exported from one path and TypeScript resolves the collision by
    // preferring the local declaration, saying nothing.
    const source = readFileSync(PORTS, 'utf8');
    expect(source).toContain("export * from './catalog-port'");
  });
});

describe('what Cart actually consumes', () => {
  it('imports the port from the file Catalog implements against', async () => {
    /*
     * The assertion that matters for correctness, as opposed to hygiene: Cart's
     * `catalog-port.ts` and Catalog's `port.ts` must name the same module, or
     * Cart is type-checked against a declaration nobody implements.
     */
    const cart = readFileSync('server/shop/cart/catalog-port.ts', 'utf8');
    const catalog = readFileSync('server/shop/catalog/port.ts', 'utf8');
    expect(cart).toContain("shared/commerce/catalog-port");
    expect(cart).not.toMatch(/from '\.\.\/\.\.\/\.\.\/shared\/commerce\/ports'/);
    expect(catalog).toContain("shared/commerce/catalog-port");
  });

  it('and the real implementation satisfies Cart’s instantiation of it', async () => {
    // A value-level check, so a signature change in Catalog's implementation
    // fails here rather than at the first request. The import is confined to
    // this file and `real-catalog.test.ts`; no Cart source module imports
    // anything from `server/shop/catalog/` (contract §2 R2).
    const { catalogPort } = await import('../catalog/port');
    const port: import('./catalog-port').CatalogPort = catalogPort;
    expect(typeof port.quote).toBe('function');
    expect(typeof port.reserve).toBe('function');
    expect(typeof port.release).toBe('function');
    expect(typeof port.commitReservation).toBe('function');
  });
});
