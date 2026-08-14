import { readFileSync } from 'node:fs';

/**
 * The seed block of `0012_service_areas.sql`, generated from data that is
 * checked in — never fetched.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL, RATHER THAN ~800 HAND-TYPED VALUES TUPLES.
 *
 * A service area is *a place a van goes*. Two populations make up the seed and
 * they come from different places:
 *
 *   - the served districts, curated once from Overpass (OpenStreetMap) at
 *     authoring time and edited by hand — the noise struck out, the zones the
 *     query does not return added, the aliases people actually type attached;
 *   - every local government area of every other region, 768 of them, read out
 *     of `docs/superpowers/data/ng-states-lgas.json`.
 *
 * Hand-typing the second population is 768 opportunities to fat-finger a place
 * name into a migration that cannot be edited once it has run anywhere. So the
 * INSERT is generated from the JSON and the GENERATED SQL IS COMMITTED — the
 * migration stays one plain reviewable file, and `gen-service-areas.test.ts`
 * re-runs this module and asserts the committed block is byte-identical to what
 * it produces. The generator is the proof, not a build step: nothing runs it at
 * migration time, and nothing may.
 *
 * THE APPLICATION MUST NEVER CALL OVERPASS. It is a shared public service with
 * no uptime promise — one of the two calls made while authoring this answered
 * "the server is probably too busy", which is survivable in a terminal and
 * unacceptable in a customer's address form. It is business data regardless:
 * which places you *serve* is a decision about drivers, not a fact about
 * geography.
 *
 * THE GRANULARITY IS DELIBERATELY MIXED, and the schema does not care. In the
 * capital territory people navigate by district — and the territory's own six
 * LGAs (Abaji, Bwari, Gwagwalada, Kuje, Kwali, Municipal) are useless for
 * dispatch, because "Municipal" contains every district a board would show. So
 * that region's areas are DISTRICTS and its LGAs are dropped on the floor;
 * everywhere else the LGA *is* the recognised unit (Port Harcourt, Eti-Osa,
 * Alimosho) and is used verbatim. An area is a name in a region with an active
 * flag; nothing downstream asks which kind it was.
 *
 * THE SHIPPED DATASET HAS REAL ERRORS IN IT — it spells Badagry "Badagary" and
 * carries at least one entry ("Akukutor") that is not a Rivers LGA. That is not
 * a reason to correct it here: everything outside the served region ships
 * INACTIVE, so no customer meets a bad name until an owner switches it on, and
 * the areas screen can rename and add. A pre-loaded list is a starting point,
 * not an authority.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Where the 37 regions and their LGAs live, repo-relative. */
export const DATASET = 'docs/superpowers/data/ng-states-lgas.json';

/**
 * The one region whose areas are districts rather than LGAs, named by its full
 * legal name because that is what the dataset calls it and what the column
 * stores. The city inside it is never named in source — see §10 of the plan and
 * the `/abuja/i` half of both grep guards: the served set is EDITABLE BY THE
 * OWNER, so a component or a route that matched on the place would be wrong the
 * first time somebody switched a district off.
 */
export const DISTRICT_REGION = 'Federal Capital Territory';

/**
 * The served districts, active on day one.
 *
 * TWENTY-ONE FROM THE QUERY, SEVEN ADDED BY HAND. The Overpass query
 * (`node["place"~"^(suburb|quarter|neighbourhood|district)$"]` over the
 * territory's bounding box, run 2026-08-13) returned the first twenty-one plus
 * noise — "CBN Quaters Lugbe Phase 2", "NCCE Quarters Karmo" — struck out here
 * once, by a human, on purpose. The seven zones are not in the query's answer at
 * all: OpenStreetMap files them under their parent, and the owner's decision is
 * that each is its own area, because they are separate places to a driver and
 * dispatch is what areas are for.
 *
 * ALIASES ARE WHAT STOP A CUSTOMER BEING REFUSED FOR SPELLING THEIR OWN
 * NEIGHBOURHOOD THEIR OWN WAY. They hold only the OTHER spellings: the resolver
 * folds case and punctuation out of `name` too, so an alias equal to the name
 * would be a second copy of a match that already works. Every one of them is
 * lowercase, which the column's own contract requires.
 */
interface District {
  name: string;
  aliases?: string[];
}

export const DISTRICTS: readonly District[] = [
  { name: 'Maitama District', aliases: ['maitama'] },
  { name: 'Wuse District', aliases: ['wuse'] },
  { name: 'Wuse II District', aliases: ['wuse 2', 'wuse ii', 'wuse2'] },
  { name: 'Garki', aliases: ['garki 1', 'garki i', 'garki district'] },
  { name: 'Garki II District', aliases: ['garki 2', 'garki ii', 'garki2'] },
  { name: 'Asokoro District', aliases: ['asokoro'] },
  { name: 'Central Business District', aliases: ['cbd', 'central area'] },
  { name: 'Guzape', aliases: ['guzape district'] },
  { name: 'Gudu', aliases: ['gudu district'] },
  { name: 'Durumi', aliases: ['durumi district'] },
  { name: 'Jabi', aliases: ['jabi district'] },
  { name: 'Jahi', aliases: ['jahi district'] },
  { name: 'Kado', aliases: ['kado district'] },
  { name: 'Katampe', aliases: ['katampe district', 'katampe extension'] },
  { name: 'Kaura', aliases: ['kaura district'] },
  { name: 'Kukwaba', aliases: ['kukwaba district'] },
  { name: 'Mabushi', aliases: ['mabushi district'] },
  { name: 'Utako', aliases: ['utako district'] },
  { name: 'Wuye', aliases: ['wuye district'] },
  { name: 'Dakibiyu', aliases: ['dakibiyu district'] },
  { name: 'Gwarinpa', aliases: ['gwarimpa', 'gwarinpa estate'] },
  { name: 'Wuse Zone 1', aliases: ['zone 1'] },
  { name: 'Wuse Zone 2', aliases: ['zone 2'] },
  { name: 'Wuse Zone 3', aliases: ['zone 3'] },
  { name: 'Wuse Zone 4', aliases: ['zone 4'] },
  { name: 'Wuse Zone 5', aliases: ['zone 5'] },
  { name: 'Wuse Zone 6', aliases: ['zone 6'] },
  { name: 'Wuse Zone 7', aliases: ['zone 7'] },
];

/**
 * The clock the seed is stamped with — the same fixed authoring-time constant
 * migration 0012 carries in the journal.
 *
 * A CONSTANT AND NOT A CLOCK READ, the rule 0011's seed states: a seed stamped
 * `now()` makes two databases disagree about when the shop opened and makes this
 * generator's output depend on the minute it ran, which would make the
 * byte-identity test below meaningless.
 */
export const SEEDED_AT = 1786600001100;

/** `marketing_service_areas_key_ck`, in TypeScript: lowercase, alphanumeric,
 *  hyphen and underscore, never leading punctuation. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The stable handle: the region's slug, then the area's.
 *
 * QUALIFIED BY REGION BECAUSE PLACE NAMES REPEAT. "Obi" is an LGA of two
 * different states and "Ifelodun" of two more; a bare name slug would collide
 * and the unique index would refuse the second row, silently costing a state one
 * of its areas. The generator asserts global uniqueness below rather than
 * trusting this argument.
 */
export function areaKey(region: string, name: string): string {
  return `${slug(region)}-${slug(name)}`;
}

/**
 * The primary key, derived from the same two names.
 *
 * DETERMINISTIC RATHER THAN MINTED, unlike every id this application creates at
 * run time. `newId()` is `Date.now()` plus random hex, which would make each run
 * of this generator produce a different file and turn the committed SQL into
 * something nobody can reproduce. Seed rows are DATA, and data with a stable
 * name can be referenced, re-run and diffed. Underscores rather than hyphens so
 * the id reads as one token when it appears in a URL or a log line.
 */
export function areaId(region: string, name: string): string {
  return `area_${areaKey(region, name).replace(/-/g, '_')}`;
}

interface SeedRow {
  id: string;
  key: string;
  region: string;
  name: string;
  aliases: readonly string[];
  active: boolean;
  sortOrder: number;
}

/** A SQL string literal. Names carry slashes, hyphens and apostrophes
 *  ("Ado-Odo/Ota", "Ogba/Egbema/Ndoni"); doubling the quote is the only
 *  escaping a `text` literal needs and the only one that is always right. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function aliasArray(aliases: readonly string[]): string {
  if (aliases.length === 0) return `'{}'`;
  return `ARRAY[${aliases.map(quote).join(', ')}]`;
}

/**
 * Every row the seed installs, in the order it installs them.
 *
 * THE SERVED REGION FIRST, so a reviewer reading the generated block top-down
 * meets the twenty-eight rows that are actually switched on before the seven
 * hundred that are not. Within a region `sort_order` is the position in this
 * list, which for the districts is the curated order above and for everywhere
 * else is the dataset's own — alphabetical, as it happens, which is what an
 * areas screen grouping by region wants.
 */
export function seedRows(datasetJson: string): SeedRow[] {
  const dataset = JSON.parse(datasetJson) as Record<string, string[]>;

  const rows: SeedRow[] = DISTRICTS.map((district, index) => ({
    id: areaId(DISTRICT_REGION, district.name),
    key: areaKey(DISTRICT_REGION, district.name),
    region: DISTRICT_REGION,
    name: district.name,
    aliases: district.aliases ?? [],
    /*
     * THE ONLY `true` IN THIS FILE. Everything else ships off, so the failure
     * mode of a forgotten flag is "we do not serve there" rather than "we
     * promised a van we cannot send".
     */
    active: true,
    sortOrder: index,
  }));

  for (const [region, names] of Object.entries(dataset)) {
    /*
     * THE SERVED REGION'S OWN LGAs ARE DROPPED. Its six are administrative
     * units, not dispatch units — one of them contains every district above —
     * so seeding them would put a second, overlapping answer to "where is this
     * address" in the same table as the first.
     */
    if (region === DISTRICT_REGION) continue;
    names.forEach((name, index) => {
      rows.push({
        id: areaId(region, name),
        key: areaKey(region, name),
        region,
        name,
        /* NO ALIASES OUTSIDE THE SERVED REGION. An alias is a guess about what a
         * customer types, and nobody has typed one of these yet; the owner adds
         * them on the areas screen the week a driver is hired there. */
        aliases: [],
        active: false,
        sortOrder: index,
      });
    });
  }

  return rows;
}

/**
 * The generated block, exactly as migration 0012 carries it — between its two
 * marker comments, with no trailing newline.
 *
 * ONE STATEMENT FOR ~800 ROWS rather than one per row. The migration runner
 * splits on `--> statement-breakpoint`, so 796 statements would be 796 round
 * trips against Neon for a seed that is logically one act; and a partial seed —
 * some rows in, some not, because the runner died in the middle — is a database
 * whose switcher is missing districts with nothing to say so.
 *
 * `ON CONFLICT DO NOTHING` WITH NO INFERENCE TARGET, unlike 0011's
 * `ON CONFLICT (key)`. This table has TWO unique indexes — the key, and the
 * expression index over `(region, lower(name))` — and a conflict target names
 * only one of them: a re-run that collided on the other would raise 23505 and
 * abort a migration whose whole point is to be replayable. The bare form covers
 * both, and the seed writes no column it would want to update anyway.
 */
export function renderSeed(datasetJson: string): string {
  const rows = seedRows(datasetJson);

  assertConsistent(rows);

  const lines: string[] = [];
  lines.push('INSERT INTO marketing_service_areas');
  lines.push('  (id, key, region, name, aliases, active, seeded, sort_order,');
  lines.push('   revision, created_at, updated_at)');
  lines.push('VALUES');

  let lastRegion: string | null = null;
  rows.forEach((row, index) => {
    if (row.region !== lastRegion) {
      lines.push(`  -- ${row.region}`);
      lastRegion = row.region;
    }
    const tail = index === rows.length - 1 ? '' : ',';
    lines.push(
      `  (${quote(row.id)}, ${quote(row.key)}, ${quote(row.region)}, ${quote(row.name)}, ` +
        `${aliasArray(row.aliases)}, ${row.active}, true, ${row.sortOrder}, ` +
        `1, ${SEEDED_AT}, ${SEEDED_AT})${tail}`,
    );
  });

  lines.push('ON CONFLICT DO NOTHING;');
  return lines.join('\n');
}

/**
 * The generator's own guard — every invariant the DDL will enforce, checked
 * BEFORE the SQL is written rather than discovered when a migration aborts
 * halfway through a production database.
 *
 * A THROW AND NOT A WARNING. This runs at authoring time on a developer's
 * machine, where a crash costs nothing and a silently-dropped state costs a
 * region its areas.
 */
/** An area named the way a refusal should name it: the region, then the place. */
function where(row: Pick<SeedRow, 'region' | 'name'>): string {
  return [row.region, row.name].join(' / ');
}

function assertConsistent(rows: readonly SeedRow[]): void {
  const keys = new Set<string>();
  const ids = new Set<string>();
  const withinRegion = new Set<string>();
  const shape = /^[a-z0-9][a-z0-9_-]*$/;

  for (const row of rows) {
    if (!shape.test(row.key)) throw new Error(`service areas: key is unshaped — ${row.key}`);
    if (keys.has(row.key)) throw new Error(`service areas: duplicate key — ${row.key}`);
    if (ids.has(row.id)) throw new Error(`service areas: duplicate id — ${row.id}`);
    keys.add(row.key);
    ids.add(row.id);

    /* The expression unique index, evaluated here: a region may not hold two
     * areas whose names differ only in case. */
    const scoped = where({ ...row, name: row.name.toLowerCase() });
    if (withinRegion.has(scoped)) {
      throw new Error(`service areas: duplicate name in ${row.region} — ${row.name}`);
    }
    withinRegion.add(scoped);

    if (row.name !== row.name.trim() || row.name === '') {
      throw new Error(`service areas: name is untrimmed or empty — ${JSON.stringify(row.name)}`);
    }
    for (const alias of row.aliases) {
      if (alias !== alias.toLowerCase()) {
        throw new Error(`service areas: alias is not lowercase — ${alias}`);
      }
    }
  }

  /*
   * ALIASES AND NAMES SHARE ONE NAMESPACE UNDER THE RESOLVER'S FOLDING, so an
   * alias that folds onto another area's name is a resolution with two right
   * answers. Checked across the WHOLE seed rather than within a region: the
   * resolver is handed a string, not a region.
   */
  const folded = new Map<string, SeedRow>();
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const row of rows) {
    for (const token of [row.name, ...row.aliases]) {
      const at = fold(token);
      const held = folded.get(at);
      folded.set(at, row);
      /*
       * TWO TOKENS OF ONE AREA MAY FOLD TOGETHER, and that is not ambiguity —
       * `wuse 2` and `wuse2` are one answer written twice, which is exactly what
       * an alias list for a place people spell six ways looks like. Only a
       * collision BETWEEN rows can send a customer to the wrong board.
       */
      if (held === undefined || held.id === row.id) continue;
      /*
       * ONLY TWO *SERVED* AREAS FOLDING TOGETHER IS AN AMBIGUITY, because the
       * resolver's tie-break is "active first" and only an active area can
       * accept a return. Two shapes are therefore legal and both occur:
       *
       *   - INACTIVE against INACTIVE — "Obi" is an LGA of two states, "Bassa"
       *     of two more. Neither is served; the resolver answers the same 409
       *     for both, and the areas screen is where an owner disambiguates
       *     before switching one on.
       *   - ACTIVE against INACTIVE — three of them today: Garki, Gudu and
       *     Kaura are each a served district AND an LGA of some other state.
       *     "garki" resolves to the served one, which is the only one that
       *     could have taken the return anyway.
       *
       * Two ACTIVE rows would leave the resolver choosing by sort order between
       * two places a van could really go, which is a customer sent to the wrong
       * board. There are none today and this is what keeps it that way.
       */
      if (row.active && held.active) {
        throw new Error(
          `service areas: "${token}" resolves to both ${where(held)} and ${where(row)}`,
        );
      }
    }
  }
}

/**
 * `npx tsx scripts/gen-service-areas.ts` prints the block on stdout.
 *
 * PRINTS RATHER THAN WRITES. The generated SQL lives inside a migration between
 * two marker comments, surrounded by prose a generator has no business rewriting;
 * a human pastes it once, and the test is what keeps the two in step afterwards.
 */
if (process.argv[1]?.endsWith('gen-service-areas.ts')) {
  process.stdout.write(`${renderSeed(readFileSync(DATASET, 'utf8'))}\n`);
}
