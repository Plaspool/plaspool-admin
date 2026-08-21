/**
 * The house style for every message this application sends, as ONE shell.
 *
 * WHY A SHELL AND NOT A TEMPLATE PER MESSAGE. There are ten of these now — an
 * order at each step of its life, a welcome, a password reset — and the thing a
 * customer actually recognises is not the wording, it is the masthead, the paper
 * colour and the shape of the button. Ten copies of that chrome is ten places to
 * miss when the accent colour changes, and the ones that get missed are the ones
 * nobody re-reads because they only send on a refund.
 *
 * ═══════════════ EMAIL HTML IS NOT WEB HTML, AND THE DIFFERENCES HERE ARE
 *                 DELIBERATE RATHER THAN OLD-FASHIONED ═══════════════
 *
 * **Tables for layout, not divs.** Outlook on Windows renders through Microsoft
 * Word's HTML engine, which has no meaningful float, no flexbox and no grid. A
 * div-based layout does not degrade there — it stacks into a single unstyled
 * column. Tables are the only box model every client agrees on.
 *
 * **Styles are INLINE on the element, and the `<style>` block is a progressive
 * enhancement only.** Gmail's web client strips `<head>` entirely on forwarded
 * mail and several mobile clients drop it always. Anything that must be true of
 * the message — colour, spacing, borders — is inline; the `<style>` block carries
 * only the things that cannot be inlined (media queries, dark-mode overrides) and
 * whose absence leaves the message correct rather than broken.
 *
 * **The card's shadow is a table cell, not `box-shadow`.** `box-shadow` is
 * unsupported in Outlook and inconsistent in Yahoo. The site's card is a hard
 * 3px offset with no blur (`--card-lift` in `src/styles/tokens.css`), and a solid
 * offset is the one shadow that CAN be drawn without the property: a dark cell
 * with the card inset into its top-left. It reproduces the site exactly rather
 * than approximating it, which is the whole reason that token was chosen.
 *
 * **No web fonts.** Spectral and Inter are what the admin uses; neither loads in
 * a mail client worth designing for, and `@import` in a message is stripped or
 * flagged. The stacks below name them first anyway — a client that happens to
 * have them installed gets the real thing — and then fall through to the closest
 * ubiquitous face, which is Georgia for the display serif and the system UI stack
 * for everything else.
 *
 * COLOURS ARE COPIED FROM `src/styles/tokens.css` BY HAND AND MUST STAY IN STEP.
 * They cannot be imported: this runs on the server with no CSS pipeline, and a
 * build step that parsed the stylesheet to produce constants would make sending
 * mail depend on the front end compiling. The values are listed together at the
 * top of this file so a change is one diff, and `brand.test.ts` pins them against
 * the stylesheet so the copy cannot rot silently.
 */

/* ------------------------------------------------------------------ palette */

/**
 * ⚠️  THE ACCENT COMES FROM `src/brand.ts`, NOT FROM `src/styles/tokens.css`.
 *
 * This is the one thing about this palette that is easy to get wrong, and the
 * first version of this file got it wrong: `tokens.css` declares `--accent` as a
 * green (`#1c6b4b`), and that green is never what a reader sees. `src/brand.ts`
 * carries PlaSpool's own ramp — navy `#231c50` — and `syncDocumentBrand()`
 * injects it over the token at boot, deliberately as a stylesheet rather than as
 * inline properties so the light/dark/`[data-theme]` cascade survives.
 *
 * So the stylesheet is the source of truth for the NEUTRALS (paper, ink, rules,
 * the card) and `src/brand.ts` is the source of truth for the ACCENT. Reading
 * both from the same file would be tidier and would produce green emails for a
 * navy shop. `brand.test.ts` pins each half against its own source.
 */
export const BRAND = {
  /* --- neutrals: `src/styles/tokens.css` `:root` --- */
  paper: '#fbfaf7',
  paperSunken: '#f2f0ea',
  paperInset: '#e8e5da',
  cardPaper: '#fbf7ec',
  cardLine: '#1f1d14',
  ink: '#16150f',
  ink2: '#3a372d',
  ink3: '#5c584a',
  ink4: '#64604f',
  rule: '#e2ded2',
  ruleStrong: '#c7c0ae',
  danger: '#962c1c',
  dangerSoft: '#f8ebe8',
  warn: '#7a5610',
  warnSoft: '#f6eeda',

  /* --- accent: `src/brand.ts` `brand.accent.light` --- */
  accent: '#231c50',
  accentHover: '#171041',
  accentSoft: '#e9e7f3',
  accentLine: '#b8b2d6',
  accentInk: '#ffffff',

  /* --- accent, dark surfaces: `src/brand.ts` `brand.accent.dark` --- */
  accentDark: '#9b93d4',
  accentSoftDark: '#211d33',
  accentLineDark: '#413a63',
} as const;

/**
 * Where the logo is fetched from.
 *
 * `brand.url` in `src/brand.ts`, which is the admin app's own origin — and that
 * is correct even though these messages are about the STOREFRONT, because
 * `public/brand/` is served from this deployment as a static asset, ahead of any
 * function and without authentication. The storefront is a separate Worker that
 * does not carry these files.
 *
 * Overridable, because the one thing that would break every logo at once is this
 * host moving.
 */
function assetOrigin(): string {
  const configured = process.env.BRAND_ASSET_ORIGIN?.trim();
  return (configured || 'https://blog-admin-app-gold.vercel.app').replace(/\/+$/, '');
}

/**
 * The lockup's own aspect ratio, 4800×980, as the height a masthead uses and the
 * width that follows from it.
 *
 * BOTH ARE WRITTEN AS HTML ATTRIBUTES, not only as CSS. Outlook ignores CSS
 * dimensions on an image and falls back to the intrinsic size — which for this
 * artwork is 4800px wide, i.e. a logo eight screens across. The attributes are
 * what stop that.
 */
const LOGO_H = 34;
const LOGO_W = Math.round((4800 / 980) * LOGO_H);

const FONT_DISPLAY =
  "'Spectral','Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Times New Roman',serif";
const FONT_UI =
  "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const FONT_MONO = "'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";

/** The card's hard offset, matching `--card-lift`. */
const LIFT = 3;

/** The reading column. 600px is the width every mail client lays out without
 * horizontal scroll, and the number every template gallery is cut to. */
const WIDTH = 600;

/* -------------------------------------------------------------- escaping */

/**
 * The five characters that change the meaning of HTML.
 *
 * A DELIBERATE THIRD COPY of the function in `server/email/render.ts`, which
 * documents the same decision for the same reason: that module belongs to the
 * marketing subsystem and importing it here would couple every transactional
 * message to a feature it has no business knowing about. The apostrophe is
 * included because URLs are substituted inside attributes and single-quoted
 * `href` values are not unusual.
 */
export function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ------------------------------------------------------------- components */

export interface ShellOptions {
  /** The document title, and the preheader when none is given separately. */
  title: string;
  /**
   * The grey line of text a mobile inbox shows beside the subject.
   *
   * WORTH THE UGLY MARKUP IT COSTS. Without one, every client fills that line
   * with the first text in the document — which for a designed message is the
   * masthead, so an inbox shows "PlaSpool PlaSpool PlaSpool" down the screen. The
   * hidden span below is the standard fix, and the padding entities after it stop
   * the client running on into the body copy.
   */
  preheader?: string;
  /** Rendered inside the card, already HTML. */
  body: string;
  /** Small print under the card. Already HTML; omitted when empty. */
  footer?: string;
}

/**
 * Wrap rendered body HTML in the branded document.
 *
 * THE DARK-MODE BLOCK IS NOT OPTIONAL POLISH. Apple Mail and Outlook.com do not
 * ask permission before inverting a light message for a reader in dark mode, and
 * their automatic inversion is a per-element colour flip that turns the accent
 * green muddy and, worse, leaves text that was already dark-on-dark unreadable —
 * the exact failure this repository fixed on its own screens in PR #48. Declaring
 * `color-scheme` and supplying explicit dark values takes the decision back for
 * every client that honours it; the rest get the light design intact.
 */
export function shell(options: ShellOptions): string {
  const preheader = options.preheader ?? options.title;
  const pad = '&#847;&zwnj;&nbsp;';
  const footer = options.footer
    ? `    <tr><td class="b-pad b-ink3" style="padding:22px 10px 0 10px;font-family:${FONT_UI};font-size:12px;line-height:1.65;color:${BRAND.ink4}">${options.footer}</td></tr>\n`
    : '';

  return `<!doctype html>
<html lang="en" style="margin:0;padding:0">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(options.title)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  /* Clients that ignore the media query keep every inline style, which is the
     complete light design — nothing below is load-bearing. */
  @media (prefers-color-scheme: dark) {
    .b-page  { background:#111009 !important; }
    .b-card  { background:#1b1a14 !important; border-color:#3a372d !important; }
    .b-shade { background:#000000 !important; }
    .b-ink   { color:#f2f0ea !important; }
    .b-ink2  { color:#d9d5c8 !important; }
    .b-ink3  { color:#b3ae9d !important; }
    .b-rule  { border-color:#3a372d !important; }
    .b-soft  { background:#20241f !important; border-color:#3a372d !important; }
    a.b-link { color:${BRAND.accentDark} !important; }
    /*
     * THE LOGO SWAP, AND IT DEGRADES TO LIGHT-ONLY RATHER THAN TO BOTH.
     *
     * The dark lockup is hidden INLINE (display:none on the element), so a
     * client that strips this whole block shows exactly one logo — the light
     * one, which is the correct choice for a light message. Doing it the other
     * way round, with the dark one visible by default, would show BOTH lockups
     * stacked in every client that drops the head, which is most of them on a
     * forwarded message.
     *
     * The names follow src/brand.ts: an asset is named for the background it
     * sits ON, so logo-dark.png is the one with light ink.
     */
    .b-logo-light { display:none !important; }
    .b-logo-dark  { display:block !important; }
    /* A reached node is the LIGHTENED navy on a dark ground; the brand hex is
       near-invisible there. Values from src/brand.ts brand.accent.dark. */
    .b-node-on   { background:${BRAND.accentDark} !important; border-color:${BRAND.accentDark} !important; color:${BRAND.accentSoftDark} !important; }
    .b-node-off  { background:#2a2820 !important; border-color:#4a463a !important; }
    .b-conn-on   { border-top-color:${BRAND.accentDark} !important; }
    .b-conn-off  { border-top-color:#4a463a !important; }
    .b-btn       { background:${BRAND.accentDark} !important; }
    .b-btn a     { color:#191338 !important; }
  }
  @media only screen and (max-width:620px) {
    .b-wrap { width:100% !important; }
    .b-pad  { padding-left:22px !important; padding-right:22px !important; }
    .b-h1   { font-size:24px !important; }
    .b-col  { display:block !important; width:100% !important; text-align:left !important; }
    /* The timeline stays horizontal on a phone — four short labels fit across
       320px, and stacking it would lose the left-to-right sense of a path. */
    .b-tl   { font-size:10px !important; letter-spacing:0 !important; }
  }
</style>
</head>
<body class="b-page" style="margin:0;padding:0;width:100%;background:${BRAND.paperSunken};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all">${esc(preheader)}${pad.repeat(5)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="b-page" style="background:${BRAND.paperSunken};margin:0;padding:0">
<tr><td align="center" style="padding:28px 12px 40px 12px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${WIDTH}" class="b-wrap" style="width:${WIDTH}px;max-width:100%">
    <tr><td style="padding:0 0 18px 0">${masthead()}</td></tr>
    <!-- The card, and its shadow. The outer cell IS the shadow: it is painted
         --card-line and the card is inset into its top-left by --card-lift,
         which draws the site's hard unblurred offset without box-shadow. -->
    <tr><td class="b-shade" style="background:${BRAND.cardLine};padding:0 ${LIFT}px ${LIFT}px 0;border-radius:16px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="b-card" style="background:${BRAND.cardPaper};border:2px solid ${BRAND.cardLine};border-radius:16px">
        <tr><td class="b-pad" style="padding:34px 38px 36px 38px;font-family:${FONT_UI};font-size:15px;line-height:1.62;color:${BRAND.ink2}">
${options.body}
        </td></tr>
      </table>
    </td></tr>
${footer}  </table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * The masthead. Wordmark only — NO IMAGE, and that is a decision.
 *
 * Every major client blocks remote images by default for an unknown sender, so a
 * logo-as-image is a broken-image icon for exactly the reader who has not decided
 * to trust the shop yet — the worst possible first impression, and the one an
 * operator never sees because their own client trusts their own domain. Type set
 * in the display face is legible before a single byte is fetched.
 */
function masthead(): string {
  const origin = assetOrigin();
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td align="left" style="font-family:${FONT_UI};font-size:19px;font-weight:700;color:${BRAND.ink};line-height:1">
        <img class="b-logo-light" src="${origin}/brand/logo-light.png" alt="PlaSpool"
             width="${LOGO_W}" height="${LOGO_H}"
             style="display:block;width:${LOGO_W}px;height:${LOGO_H}px;border:0;outline:none;text-decoration:none">
        <img class="b-logo-dark" src="${origin}/brand/logo-dark.png" alt="PlaSpool"
             width="${LOGO_W}" height="${LOGO_H}"
             style="display:none;width:${LOGO_W}px;height:${LOGO_H}px;border:0;outline:none;text-decoration:none">
      </td></tr>
    </table>`;
}

/** The page heading inside the card. */
export function h1(text: string): string {
  return `<h1 class="b-h1 b-ink" style="margin:0 0 10px 0;font-family:${FONT_DISPLAY};font-size:28px;line-height:1.22;font-weight:600;letter-spacing:-0.015em;color:${BRAND.ink}">${esc(text)}</h1>`;
}

/** A paragraph of body copy. `html` is already-rendered HTML, never raw input. */
export function p(html: string): string {
  return `<p class="b-ink2" style="margin:0 0 14px 0;font-family:${FONT_UI};font-size:15px;line-height:1.62;color:${BRAND.ink2}">${html}</p>`;
}

/** Muted small print. */
export function small(html: string): string {
  return `<p class="b-ink3" style="margin:0 0 10px 0;font-family:${FONT_UI};font-size:13px;line-height:1.6;color:${BRAND.ink4}">${html}</p>`;
}

export type Tone = 'accent' | 'danger' | 'warn' | 'neutral';

const TONES: Record<Tone, { fg: string; bg: string; line: string }> = {
  accent: { fg: BRAND.accent, bg: BRAND.accentSoft, line: BRAND.accentLine },
  danger: { fg: BRAND.danger, bg: BRAND.dangerSoft, line: '#e6c4bd' },
  warn: { fg: BRAND.warn, bg: BRAND.warnSoft, line: '#e0cfa4' },
  neutral: { fg: BRAND.ink3, bg: BRAND.paperInset, line: BRAND.ruleStrong },
};

/** The status pill above the heading — what happened, in one word. */
export function badge(text: string, tone: Tone = 'accent'): string {
  const t = TONES[tone];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0"><tr>
    <td style="background:${t.bg};border:1px solid ${t.line};border-radius:999px;padding:5px 13px;font-family:${FONT_UI};font-size:11px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${t.fg};white-space:nowrap">${esc(text)}</td>
  </tr></table>`;
}

/**
 * The primary call to action.
 *
 * PADDING ON THE CELL, NOT ON THE ANCHOR, and the anchor is `display:block`
 * inside it. A padded inline anchor is only clickable on its text in Outlook,
 * which turns a 44px-tall button into a 14px-tall link — and the reader who
 * misses it reports that the email "has no button".
 */
export function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px 0"><tr>
    <td class="b-btn" style="background:${BRAND.accent};border:2px solid ${BRAND.cardLine};border-radius:10px">
      <a href="${esc(href)}" style="display:block;padding:13px 26px;font-family:${FONT_UI};font-size:15px;font-weight:600;color:${BRAND.accentInk};text-decoration:none;letter-spacing:-0.005em">${esc(label)}&nbsp;&rarr;</a>
    </td>
  </tr></table>`;
}

/** A hairline between sections. */
export function divider(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 20px 0"><tr>
    <td class="b-rule" style="border-top:1px solid ${BRAND.rule};font-size:0;line-height:0">&nbsp;</td>
  </tr></table>`;
}

export interface LineRow {
  title: string;
  sku: string;
  qty: number;
  amount: string;
  /** Absolute URL of the product photograph, or absent. See `thumb`. */
  imageUrl?: string | null;
}

export interface TotalRow {
  label: string;
  amount: string;
  strong?: boolean;
}

/** The thumbnail's edge, in px. 56 is large enough to tell two filament colours
 * apart on a phone and small enough that four lines still fit above the fold. */
const THUMB = 56;

/**
 * The product photograph, or nothing at all.
 *
 * ═══ NOTHING, NOT A PLACEHOLDER ═══
 * A line with no `imageUrl` renders no cell — the text simply starts at the left
 * edge, exactly as it did before this existed. The alternative, a grey box with
 * an icon in it, is indistinguishable from a photograph that failed to load, so
 * it converts "this product has no picture" into "this email is broken".
 *
 * `alt=""` AND NOT THE PRODUCT'S NAME. The title is already the next thing in the
 * row, in bold; repeating it as alt text makes a screen reader say it twice and
 * makes a blocked-image client show it twice. An empty alt on a decorative image
 * is the correct answer, and it is why the title is NOT inside this cell.
 *
 * The dimensions are attributes as well as CSS for `masthead`'s reason: Outlook
 * ignores CSS on an image and falls back to the intrinsic size.
 */
function thumb(url: string | null | undefined): string {
  if (!url) return '';
  return `<td class="b-rule" width="${THUMB + 14}" valign="top" style="width:${THUMB + 14}px;padding:11px 14px 11px 0;border-bottom:1px solid ${BRAND.rule}">
        <img src="${esc(url)}" alt="" width="${THUMB}" height="${THUMB}"
             style="display:block;width:${THUMB}px;height:${THUMB}px;border-radius:8px;border:1px solid ${BRAND.rule};object-fit:cover;background:${BRAND.paperInset}">
      </td>`;
}

/**
 * The order lines, plus whatever totals the caller wants under them.
 *
 * THE SKU IS SHOWN AND IT IS NOT CLUTTER: it is the one string a customer can
 * quote to support that identifies exactly what they received, and it is the only
 * field on the row that a re-listing of the catalogue cannot change the meaning
 * of, because the order line is a snapshot.
 *
 * THE TOTALS ROW SPANS THE THUMBNAIL COLUMN. `colspan` is computed from whether
 * ANY row has a picture rather than assumed — a table whose body rows have three
 * cells and whose footer has two puts "Total" under the photographs and the
 * amount in the middle of the row, which is the failure that makes a designed
 * invoice look broken at exactly the line the reader checks hardest.
 */
export function lineTable(rows: LineRow[], totals: TotalRow[]): string {
  const withImages = rows.some((r) => Boolean(r.imageUrl));
  const span = withImages ? 2 : 1;

  const body = rows
    .map(
      (r) => `<tr>
      ${withImages ? thumb(r.imageUrl ?? null) : ''}
      <td class="b-rule b-ink2" valign="top" style="padding:11px 0;border-bottom:1px solid ${BRAND.rule};font-family:${FONT_UI};font-size:14px;line-height:1.45;color:${BRAND.ink2}">
        <span class="b-ink" style="font-weight:600;color:${BRAND.ink}">${esc(r.title)}</span><br>
        <span class="b-ink3" style="font-family:${FONT_MONO};font-size:11px;color:${BRAND.ink4};letter-spacing:0.02em">${esc(r.sku)}</span>
        <span class="b-ink3" style="font-size:12px;color:${BRAND.ink4}">&nbsp;&middot;&nbsp;qty ${r.qty}</span>
      </td>
      <td class="b-rule b-ink" align="right" valign="top" style="padding:11px 0;border-bottom:1px solid ${BRAND.rule};font-family:${FONT_MONO};font-size:13px;white-space:nowrap;color:${BRAND.ink}">${esc(r.amount)}</td>
    </tr>`,
    )
    .join('\n');

  const foot = totals
    .map((t) => {
      const padTop = t.strong ? '13px' : '7px';
      const size = t.strong ? '15px' : '13px';
      const weight = t.strong ? '700' : '400';
      const colour = t.strong ? BRAND.ink : BRAND.ink4;
      const cls = t.strong ? 'b-ink' : 'b-ink3';
      return `<tr>
      <td class="${cls}" colspan="${span}" style="padding:${padTop} 0 0 0;font-family:${FONT_UI};font-size:${size};font-weight:${weight};color:${colour}">${esc(t.label)}</td>
      <td class="${cls}" align="right" style="padding:${padTop} 0 0 0;font-family:${FONT_MONO};font-size:${size};font-weight:${weight};white-space:nowrap;color:${colour}">${esc(t.amount)}</td>
    </tr>`;
    })
    .join('\n');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 22px 0;border-collapse:collapse">
${body}
${foot}
  </table>`;
}

/**
 * A labelled fact panel — tracking number, delivery address, refund breakdown.
 *
 * Rows rather than a definition list, because a `dl` is unstyled in Outlook.
 */
export function facts(
  rows: { label: string; value: string; mono?: boolean }[],
  tone: Tone = 'neutral',
): string {
  const t = TONES[tone];
  const cells = rows
    .map(
      (r) => `<tr>
      <td class="b-ink3" style="padding:4px 14px 4px 0;font-family:${FONT_UI};font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:${BRAND.ink4};white-space:nowrap;vertical-align:top">${esc(r.label)}</td>
      <td class="b-ink" style="padding:4px 0;font-family:${r.mono ? FONT_MONO : FONT_UI};font-size:14px;font-weight:600;color:${BRAND.ink};vertical-align:top">${esc(r.value)}</td>
    </tr>`,
    )
    .join('\n');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="b-soft" style="margin:2px 0 20px 0;background:${t.bg};border:1px solid ${t.line};border-radius:10px">
    <tr><td class="b-pad" style="padding:15px 18px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">${cells}</table>
    </td></tr>
  </table>`;
}

export interface Step {
  label: string;
  /** `done` is behind the reader, `now` is where the order is, `next` is ahead. */
  state: 'done' | 'now' | 'next' | 'stopped';
}

/**
 * THE TIMELINE — the component that makes these messages a series rather than
 * several unrelated emails.
 *
 * A customer's real question on opening any of these is "where is my order and
 * what happens next", and answering it costs one row. Every message in the
 * lifecycle carries the same strip with a different position marked, so the shape
 * becomes familiar and the answer is readable before the copy is.
 *
 * `stopped` IS A DISTINCT STATE FROM `done`. A cancelled or refunded order has
 * not reached the end of the happy path — it left it — and drawing that as a
 * completed step would tell a customer their refund shipped.
 */
/** The node's diameter. Big enough to hold a legible tick at 13px. */
const NODE = 24;

/**
 * A GLYPH, NOT AN ICON FILE, and the reason is the same one that keeps the
 * masthead's fallback text: an `<img>` is blocked by default for an unknown
 * sender in every major client, so an icon-based tick is an EMPTY circle for
 * exactly the reader who has not yet decided to trust the shop. A character is
 * drawn by the font and cannot be blocked.
 *
 * `&#10003;` (CHECK MARK) and `&#10007;` (BALLOT X) are chosen over the heavier
 * `&#10004;`/`&#10005;` because the heavy pair is emoji-presented by default on
 * iOS — which turns a white tick on navy into a full-colour green tick that
 * ignores the palette entirely.
 */
const TICK = '&#10003;';
const CROSS = '&#10007;';

/** What one step looks like: fill, border, the mark drawn in it. */
function node(state: Step['state']): string {
  const reached = state === 'done' || state === 'now';
  const fill = state === 'stopped' ? BRAND.danger : reached ? BRAND.accent : BRAND.paperInset;
  const line = state === 'stopped' ? BRAND.danger : reached ? BRAND.accent : BRAND.ruleStrong;
  const mark = state === 'stopped' ? CROSS : reached ? TICK : '&nbsp;';
  /* The class is what the dark-mode block repaints: navy on near-black is the
   * dark-on-dark failure this repo fixed on its own screens in PR #48, so a
   * reached node has to become the LIGHTENED navy there, not stay the brand hex. */
  const cls = state === 'stopped' ? 'b-node-stop' : reached ? 'b-node-on' : 'b-node-off';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
            <td class="${cls}" width="${NODE}" height="${NODE}" align="center" valign="middle"
                style="width:${NODE}px;height:${NODE}px;background:${fill};border:1px solid ${line};border-radius:999px;font-family:${FONT_UI};font-size:13px;line-height:${NODE}px;color:${BRAND.accentInk};mso-line-height-rule:exactly">${mark}</td>
          </tr></table>`;
}

/**
 * THE TIMELINE — the component that makes these messages a series rather than
 * several unrelated emails.
 *
 * A customer's real question on opening any of these is "where is my order and
 * what happens next", and answering it costs one row. Every message in the
 * lifecycle carries the same strip with a different position marked, so the shape
 * becomes familiar and the answer is readable before the copy is.
 *
 * ═══ TICKS AND CROSSES RATHER THAN DOTS, JOINED BY A LINE ═══
 * Coloured dots encode the state in HUE ALONE, which asks the reader to work out
 * that green means done — and says nothing at all to the ~8% of men with a
 * red/green deficiency, for whom the accent dot and the danger dot are the same
 * dot. A tick and a cross are read as symbols before they are read as colours,
 * and the connecting rule turns four separate marks into one path with a
 * direction.
 *
 * ═══ THE CONNECTOR IS TWO HALVES INSIDE THE STEP, NOT A CELL BETWEEN STEPS ═══
 *
 * The obvious construction — node cell, connector cell, node cell — is what this
 * component shipped first, and it looked wrong: the line floated in the middle of
 * the gap and touched nothing at either end.
 *
 * The cause is that a step's cell is sized by its LABEL, not by its circle.
 * "Delivered" is about 55px wide and the circle is 24px, so the circle sits in
 * the middle of a 55px cell with ~15px of empty cell on each side of it — and a
 * connector in the NEXT cell along starts after all of that. The line was
 * correct; it simply began 15px away from the thing it was meant to join.
 *
 * So each step now owns its own half-connectors: `[½ line][circle][½ line]`,
 * inside the step's cell, with the halves pinned hard against the circle and
 * running to the cell's edges. Adjacent cells meet exactly at their shared
 * boundary, so the two halves form one unbroken rule regardless of how wide any
 * label happens to be. The first step has no left half and the last has no right
 * half, so the path starts and ends at a circle rather than in mid-air.
 *
 * A half is a `border-top` on a cell — not an `<hr>` (margins nobody agrees on)
 * and not a background image (blocked). `padding-top` of half the node's height
 * lands it on the circle's centre line, which is the only vertical centring worth
 * relying on across these clients.
 *
 * `stopped` IS A DISTINCT STATE FROM `done`. A cancelled or refunded order has
 * not reached the end of the happy path — it left it — so it gets the cross, the
 * danger colour, and a connector in danger colour leading into it. Drawing it as
 * a completed step would tell a customer their refund shipped.
 */

/** The colour of the rule leading INTO `state`, and the class that repaints it. */
function connector(state: Step['state'] | null): { colour: string; cls: string } {
  if (state === null) return { colour: 'transparent', cls: 'b-conn-none' };
  if (state === 'stopped') return { colour: BRAND.danger, cls: 'b-conn-stop' };
  if (state === 'done' || state === 'now') return { colour: BRAND.accent, cls: 'b-conn-on' };
  return { colour: BRAND.ruleStrong, cls: 'b-conn-off' };
}

/** One half of a rule. `null` state means "no line here" — an invisible spacer
 * that keeps the circle centred in its cell rather than shunted to one side. */
function half(state: Step['state'] | null): string {
  const { colour, cls } = connector(state);
  return `<td class="${cls}" valign="top" style="padding:${NODE / 2 - 1}px 0 0 0;border-top:0;font-size:0;line-height:0">
              <div style="border-top:2px solid ${colour};font-size:0;line-height:0;height:0">&nbsp;</div>
            </td>`;
}

export function timeline(steps: Step[]): string {
  const cells = steps
    .map((s, i) => {
      const stopped = s.state === 'stopped';
      const fg = stopped
        ? BRAND.danger
        : s.state === 'now'
          ? BRAND.ink
          : s.state === 'done'
            ? BRAND.ink3
            : BRAND.ink4;
      const weight = s.state === 'now' || stopped ? '700' : '500';
      const cls = s.state === 'next' ? 'b-ink3' : 'b-ink2';

      /*
       * The LEFT half is coloured by THIS step (the rule leading into it); the
       * RIGHT half by the NEXT one. That is what makes two halves either side of
       * a boundary agree, so the colour changes exactly at a circle and never
       * mid-run.
       */
      const left = i === 0 ? null : s.state;
      const right = i === steps.length - 1 ? null : steps[i + 1].state;

      /*
       * DELIBERATELY NOT `b-col`. That class stacks a cell to full width under
       * the mobile media query, which is right for a two-column layout and would
       * break the strip into one step per line — losing the left-to-right sense
       * of a path. Four short labels fit across 320px; the query just shrinks
       * the type instead.
       */
      return `<td align="center" valign="top" style="padding:0;font-family:${FONT_UI}">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
${half(left)}
              <td width="${NODE}" align="center" valign="top" style="width:${NODE}px;padding:0;font-size:0;line-height:0">${node(s.state)}</td>
${half(right)}
            </tr>
          </table>
          <div class="b-tl ${cls}" style="padding:8px 3px 0 3px;font-size:11px;line-height:1.3;font-weight:${weight};letter-spacing:0.01em;color:${fg};white-space:nowrap">${esc(s.label)}</div>
        </td>`;
    })
    .join('\n');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="b-soft" style="margin:2px 0 24px 0;background:${BRAND.paper};border:1px solid ${BRAND.rule};border-radius:10px">
    <tr><td style="padding:18px 10px 16px 10px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout:fixed">
        <tr>
${cells}
        </tr>
      </table>
    </td></tr>
  </table>`;
}

/** An inline link in body copy. */
export function link(label: string, href: string): string {
  return `<a class="b-link" href="${esc(href)}" style="color:${BRAND.accent};text-decoration:underline">${esc(label)}</a>`;
}
