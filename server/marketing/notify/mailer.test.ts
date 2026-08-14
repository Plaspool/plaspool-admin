/**
 * The words a customer receives — rendered from the program's own labels, and
 * frozen the instant the award happens.
 *
 * TWO HALVES, AND THE SECOND IS THE ONE THAT MATTERS. The first asserts the
 * renderers are pure functions of `(view, labels)` and that every noun in their
 * output came from the labels. The second walks a REAL inspection, renames the
 * programme afterwards, and asserts the stored letter is untouched — because
 * "rendered at write time" is only a design until something proves that delivery
 * cannot re-render.
 *
 * NO WORD OF THE SHIPPED PRESET IS WRITTEN IN THIS FILE — not even to assert its
 * absence. The seeded wording is READ FROM ITS ROW in `beforeAll` and every
 * rendered string is checked against it, which keeps the literal out of this
 * subsystem's source (spec D11, and A10's grep guard) and makes the assertion
 * survive an edit to the seed. The fixtures use absurd labels — "Bottle Cap" /
 * "canister" — so a word that was read from a row cannot be mistaken for one
 * written in source.
 *
 * THE NUMBERS ARE FIXTURE NUMBERS. Four units minimum, seven points a unit,
 * deliberately not the preset's, which this file never reads for anything but
 * the absence check.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../../test/harness';
import { awardSentence, awardedSubject } from '../../../shared/marketing/copy';
import { collect, createRequest, inspect, receive, schedule } from '../returns/repo';
import {
  INTENT_COLUMNS,
  renderReturnAwarded,
  renderReturnRejected,
  rowToIntent,
  toMessage,
} from './mailer';
import type { Db } from '../../db/client';
import type { ProgramLabels } from '../../../shared/marketing/copy';
import type { MarketingEmailIntent, RenderedNotification, ReturnMailView } from './mailer';
import type { ReturnRow } from '../returns/repo';

let db: Db;
let close: () => Promise<void>;

/** The `when` migration 0011 carries, reused as the fixtures' clock. */
const T0 = 1786600001000;
const NOW = T0 + 60_000;
const ACTOR = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'dara@example.test';
const PER_UNIT = 7;

/** The three words this suite's programme lends every sentence about it. */
const CAPS: ProgramLabels = {
  name: 'Cap Returns',
  points: { one: 'Bottle Cap', other: 'Bottle Caps' },
  unit: { one: 'canister', other: 'canisters' },
};

/**
 * Every customer-facing word of the SEEDED preset, read from its row.
 *
 * Written this way rather than as a literal for the reason in the file header:
 * the shipped wording may not appear in this subsystem's source at all, and an
 * assertion built from the row keeps testing the right thing if the seed is
 * ever edited.
 */
let presetWords: string[] = [];

beforeAll(async () => {
  ({ db, close } = await migratedDb());
  const res = await db.execute(sql`
    SELECT name, points_label_singular, points_label_plural,
           unit_label_singular, unit_label_plural
      FROM marketing_programs WHERE seeded = true`);
  presetWords = Object.values(res.rows[0] ?? {}).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  // A seed that stopped seeding would make every absence assertion below vacuous.
  expect(presetWords.length).toBeGreaterThan(0);
});

afterAll(() => close());

beforeEach(async () => {
  await db.execute(sql`TRUNCATE marketing_return_requests, marketing_return_events,
                                marketing_ledger, marketing_balances,
                                marketing_email_intents CASCADE`);
  await db.execute(sql`DELETE FROM marketing_programs WHERE seeded = false`);
});

// ------------------------------------------------------------------- fixtures

/** The inspection, as the renderers see it. */
const AWARDED: ReturnMailView = {
  customerEmail: EMAIL,
  qtyAccepted: 5,
  qtyRejected: 1,
  pointsPerUnitSnapshot: PER_UNIT,
  rejectedReason: 'Crushed in transit',
};

/** Subject, text and html as one string — what "appears anywhere in the letter"
 *  means when a label is being looked for. */
function whole(rendered: RenderedNotification): string {
  return `${rendered.subject}\n${rendered.text}\n${rendered.html}`;
}

function saysNothingFromThePreset(rendered: RenderedNotification): void {
  for (const word of presetWords) {
    expect(whole(rendered), `preset word "${word}" reached a customer`).not.toContain(word);
  }
}

let keySeq = 0;

/** A programme inserted by SQL: this suite is about the words, and building its
 *  fixtures through another task's write path would make its failures ambiguous. */

/**
 * A place a van goes, named after nothing real.
 *
 * ABSURD ON PURPOSE, exactly as the labels are: a fixture named after a district
 * this business actually serves could not tell code that reads the area off the
 * row from code that hardcoded the place. It also keeps a real place name out of
 * a source file, which is the second half of the naming discipline.
 *
 * Migration 0012 refuses an AWARDED return with no service area
 * (`marketing_return_requests_area_award_ck`), so every fixture that walks the
 * lifecycle to its end needs one.
 */
const AREA = 'area_cabbage_quarter';

async function makeArea(): Promise<string> {
  await db.execute(sql`
    INSERT INTO marketing_service_areas
      (id, key, region, name, active, created_at, updated_at)
    VALUES (${AREA}, 'cabbage-quarter', 'Farflung Province', 'Cabbage Quarter',
            true, ${T0}, ${T0})
    ON CONFLICT DO NOTHING`);
  return AREA;
}

async function makeProgram(): Promise<string> {
  keySeq += 1;
  const id = `prg_mail_${keySeq}`;
  await db.execute(sql`
    INSERT INTO marketing_programs
      (id, key, kind, name, points_label_singular, points_label_plural,
       unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
       status, created_at, updated_at)
    VALUES (${id}, ${`bottle-caps-${keySeq}`}, 'unit_return', ${CAPS.name},
            ${CAPS.points.one}, ${CAPS.points.other},
            ${CAPS.unit!.one}, ${CAPS.unit!.other}, 4, ${PER_UNIT}, 'active', ${T0}, ${T0})`);
  return id;
}

/** Walk the real transitions to `received`, so an inspection can never run
 *  against a state the machine cannot produce. */
async function received(): Promise<ReturnRow> {
  const programId = await makeProgram();
  let row = await createRequest(db, {
    email: EMAIL,
    qtyDeclared: 6,
    programId,
    serviceAreaId: await makeArea(),
    customerName: 'Dara',
    pickupAddress: '12 Yaba Road',
    source: 'admin',
    actorId: ACTOR,
    now: NOW,
  });
  row = await schedule(db, row.id, {
    expectedRevision: row.revision,
    pickupAt: NOW + 86_400_000,
    driverName: 'Tunde',
    actorId: ACTOR,
    now: NOW,
  });
  row = await collect(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW });
  return receive(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW });
}

/** What the inspection actually stored, bodies and all. `returns/query.ts` has
 *  the WIRE reader, which deliberately selects no bodies — the detail screen
 *  shows delivery state, not the letter. */
async function storedIntents(requestId: string): Promise<MarketingEmailIntent[]> {
  const res = await db.execute(sql`
    SELECT ${INTENT_COLUMNS} FROM marketing_email_intents
     WHERE return_request_id = ${requestId}
     ORDER BY created_at ASC, id ASC`);
  return res.rows.map(rowToIntent);
}

/** Rename every word the programme lends — the thing that must not reach a
 *  letter already written. */
async function rename(programId: string): Promise<ProgramLabels> {
  const renamed: ProgramLabels = {
    name: 'Reel Returns',
    points: { one: 'Reel Credit', other: 'Reel Credits' },
    unit: { one: 'reel', other: 'reels' },
  };
  await db.execute(sql`
    UPDATE marketing_programs
       SET name = ${renamed.name},
           points_label_singular = ${renamed.points.one},
           points_label_plural = ${renamed.points.other},
           unit_label_singular = ${renamed.unit!.one},
           unit_label_plural = ${renamed.unit!.other},
           revision = revision + 1
     WHERE id = ${programId}`);
  return renamed;
}

// ----------------------------------------------------------- the award letter

describe('renderReturnAwarded — every noun is the programme’s', () => {
  it('takes its subject and its first line from shared/marketing/copy.ts, not from strings of its own', () => {
    /*
     * THE PHRASE-PARITY PIN (spec D11). The admin sees `awardSentence` under the
     * inspection form, confirms it in the dialog and reads it back in the toast;
     * the program editor previews `awardedSubject` while a rename is being
     * typed. Asserting EQUALITY against those two functions is what makes the
     * customer's inbox the same sentence rather than a fifth wording that agreed
     * with them on the day it was written.
     */
    const rendered = renderReturnAwarded(AWARDED, CAPS);
    expect(rendered.subject).toBe(awardedSubject(CAPS, 35));
    expect(rendered.text.split('\n')[0]).toBe(awardSentence(CAPS, 5, PER_UNIT, EMAIL));
  });

  it('says the programme’s words and none of the shipped preset’s', () => {
    const rendered = renderReturnAwarded(AWARDED, CAPS);
    expect(rendered.subject).toContain('Bottle Caps');
    expect(rendered.text).toContain('your Cap Returns return: 5 canisters accepted.');
    saysNothingFromThePreset(rendered);
  });

  it('is pure: the same inspection renders the same letter twice, and mutates nothing', () => {
    const view: ReturnMailView = { ...AWARDED };
    const first = renderReturnAwarded(view, CAPS);
    const second = renderReturnAwarded(view, CAPS);
    expect(second).toEqual(first);
    expect(view).toEqual(AWARDED);
    expect(CAPS.points).toEqual({ one: 'Bottle Cap', other: 'Bottle Caps' });
  });

  it('names the shortfall and its reason when some units were refused', () => {
    const rendered = renderReturnAwarded(AWARDED, CAPS);
    // The singular, and the reason in the same breath — asserted as one string
    // so "1 canisters" cannot pass as a substring of the plural.
    expect(rendered.text).toContain('We could not accept 1 canister — Crushed in transit.');
  });

  it('says nothing about a shortfall when everything was accepted', () => {
    const rendered = renderReturnAwarded(
      { ...AWARDED, qtyAccepted: 6, qtyRejected: 0, rejectedReason: null },
      CAPS,
    );
    // A "we could not accept 0 canisters" line is a support call about goods
    // nobody refused.
    expect(rendered.text).not.toContain('could not accept');
    expect(rendered.subject).toBe(awardedSubject(CAPS, 42));
  });

  it('falls back to neutral units for a programme that counts nothing', () => {
    /* `adhoc` programmes have no unit word — there is nothing being returned —
     * and `fmtUnits` answers "units" rather than inventing one. */
    const adhoc: ProgramLabels = { ...CAPS, unit: null };
    const rendered = renderReturnAwarded({ ...AWARDED, qtyRejected: 0, rejectedReason: null }, adhoc);
    expect(rendered.text).toContain('5 units accepted.');
    saysNothingFromThePreset(rendered);
  });

  it('singularises by magnitude, so one accepted unit is not "1 Bottle Caps"', () => {
    const rendered = renderReturnAwarded(
      { ...AWARDED, qtyAccepted: 1, qtyRejected: 0, rejectedReason: null, pointsPerUnitSnapshot: 1 },
      CAPS,
    );
    expect(rendered.subject).toBe('You earned 1 Bottle Cap');
    expect(rendered.text).toContain('1 canister accepted.');
  });
});

// -------------------------------------------------------- the rejection letter

describe('renderReturnRejected — an outcome and a reason, no arithmetic', () => {
  it('leads with the outcome in the programme’s words and carries the reason', () => {
    const rendered = renderReturnRejected(
      { ...AWARDED, qtyAccepted: 0, qtyRejected: 0, rejectedReason: 'Wrong items' },
      CAPS,
    );
    expect(rendered.subject).toContain('Cap Returns');
    expect(rendered.text).toContain('Bottle Caps');
    expect(rendered.text).toContain('Wrong items');
    /*
     * NO SUM, because there is no honest number to lead with: nothing was
     * accepted, and a driver who came back empty makes the rejected count zero
     * too. "0 accepted × 7 = 0 Bottle Caps" is arithmetic about a disappointment.
     */
    expect(rendered.text).not.toContain('×');
    saysNothingFromThePreset(rendered);
  });

  it('still reads as a whole letter when nobody recorded a reason', () => {
    const rendered = renderReturnRejected(
      { ...AWARDED, qtyAccepted: 0, qtyRejected: 0, rejectedReason: null },
      CAPS,
    );
    expect(rendered.text).not.toContain('Reason:');
    expect(rendered.text).toContain('reply to this message');
  });
});

// ------------------------------------------------------------------- escaping

describe('what a person typed cannot become markup', () => {
  it('escapes the programme’s own words and the rejection reason in the html part', () => {
    /*
     * Every value interpolated into a letter — the programme's name, its points
     * word, a rejection reason, the customer's own address — is something
     * somebody typed into a form. The text part keeps it verbatim; the html part
     * escapes it, which is why `escapeHtml` is imported rather than copied.
     */
    const hostile: ProgramLabels = {
      name: 'Caps <b>&</b> Co',
      points: { one: 'Cap"', other: 'Caps"' },
      unit: { one: 'canister', other: 'canisters' },
    };
    const rendered = renderReturnAwarded(
      { ...AWARDED, rejectedReason: 'Lid <script>alert(1)</script>' },
      hostile,
    );

    expect(rendered.html).toContain('Caps &lt;b&gt;&amp;&lt;/b&gt; Co');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).not.toContain('<b>');
    // And the text part is the record of what was said, unescaped.
    expect(rendered.text).toContain('Caps <b>&</b> Co');
  });
});

// ------------------------------------------- the letter the inspection stored

describe('the stored intent IS the message, and a rename never reaches it', () => {
  it('stores exactly what the renderer produced, addressed to the return’s own customer', async () => {
    const row = await received();
    await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 1,
      rejectedReason: 'Crushed in transit',
      actorId: ACTOR,
      now: NOW,
    });

    const [intent] = await storedIntents(row.id);
    expect(intent.kind).toBe('return_awarded');
    expect(intent.to).toBe(EMAIL);
    expect(intent.sentAt).toBeNull();
    expect(intent.attempts).toBe(0);

    /*
     * EQUALITY AGAINST THE RENDERER, not containment. The inspection renders
     * before it writes and the sweeper only ever copies columns, so these two
     * are the same three strings or the design has a hole in it.
     */
    const expected = renderReturnAwarded(AWARDED, CAPS);
    expect(intent.subject).toBe(expected.subject);
    expect(intent.text).toBe(expected.text);
    expect(intent.html).toBe(expected.html);

    // `toMessage` is the ONLY route from a row to a transport: four columns.
    expect(toMessage(intent)).toEqual({
      to: EMAIL,
      subject: expected.subject,
      text: expected.text,
      html: expected.html,
    });
  });

  it('a rename changes the future and never the letter already written', async () => {
    /*
     * THE PROPERTY SPEC D2d EXISTS FOR, at its least recoverable point: a
     * customer keeps an email forever. Rendering at DELIVERY time would tell
     * somebody who returned canisters in March that they earned Reel Credits in
     * June — a reward nobody ever promised them, in a currency that did not
     * exist when they packed the box.
     */
    const row = await received();
    await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 1,
      rejectedReason: 'Crushed in transit',
      actorId: ACTOR,
      now: NOW,
    });
    const before = (await storedIntents(row.id))[0];

    const renamed = await rename(row.programId);
    const after = (await storedIntents(row.id))[0];

    expect(toMessage(after)).toEqual(toMessage(before));
    expect(after.subject).toContain('Bottle Caps');
    expect(after.text).toContain('canisters');
    expect(whole(after)).not.toContain(renamed.points.other);
    expect(whole(after)).not.toContain(renamed.name);

    /*
     * AND THE TEST IS NOT VACUOUS: re-rendering the same inspection through the
     * new labels really would produce a different letter. Without this line the
     * assertions above would pass just as well if the renderer ignored labels
     * altogether.
     */
    expect(renderReturnAwarded(AWARDED, renamed).subject).not.toBe(after.subject);
  });

  it('an inspection that accepted nothing stores the rejection letter instead', async () => {
    const row = await received();
    await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 0,
      qtyRejected: 6,
      rejectedReason: 'Wrong items',
      actorId: ACTOR,
      now: NOW,
    });

    const [intent] = await storedIntents(row.id);
    const expected = renderReturnRejected(
      {
        customerEmail: EMAIL,
        qtyAccepted: 0,
        qtyRejected: 6,
        pointsPerUnitSnapshot: PER_UNIT,
        rejectedReason: 'Wrong items',
      },
      CAPS,
    );
    expect(intent.kind).toBe('return_rejected');
    expect(intent.subject).toBe(expected.subject);
    expect(intent.text).toBe(expected.text);
    saysNothingFromThePreset(intent);
  });
});
