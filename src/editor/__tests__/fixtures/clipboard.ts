/**
 * Clipboard payloads, as the real sources actually write them.
 *
 * Every string here was shaped to match what the named application puts on the
 * clipboard, not what would be convenient to assert on: Google Docs really does
 * wrap the whole payload in a `<b>` that disclaims its own boldness, Word really
 * does emit `<o:p>` and a `mso-` declaration per paragraph, and a hostile page
 * really can put a `data:text/html` URL in an `href`. Simplifying the fixtures
 * would move the test off the thing it is meant to guard.
 *
 * Kept in their own module so `paste.test.tsx` reads as a matrix of assertions
 * rather than a wall of escaped markup, and so a second suite can reuse them.
 */

// ------------------------------------------------------------- 1. Google Docs

/**
 * The `<b style="font-weight:normal" id="docs-internal-guid-…">` wrapper is the
 * signature of a Docs copy. Bold and italic are `<span>` styles, never `<b>` or
 * `<i>`, and every span carries font/colour/spacing noise that describes Docs'
 * canvas rather than the writing.
 */
export const GOOGLE_DOCS = `<meta charset='utf-8'><b style="font-weight:normal" id="docs-internal-guid-9f2c1a4e-7fff-0d1b-2c3d"><h1 dir="ltr" style="line-height:1.38;margin-top:20pt;margin-bottom:6pt;"><span style="font-size:20pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre-wrap;">Quarterly Notes</span></h1><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;vertical-align:baseline;white-space:pre-wrap;">Revenue grew, and the reason was </span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:700;font-style:normal;vertical-align:baseline;white-space:pre-wrap;">retention</span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:400;font-style:normal;vertical-align:baseline;white-space:pre-wrap;"> rather than </span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#333333;font-weight:400;font-style:italic;vertical-align:baseline;white-space:pre-wrap;">acquisition</span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:400;font-style:normal;vertical-align:baseline;white-space:pre-wrap;">.</span></p></b>`;

// ------------------------------------------------------ 2. Microsoft Word

/**
 * Word and Outlook. `<o:p>` closes every block, `MsoNormal` hangs off every
 * paragraph, `mso-*` declarations sit beside real ones in the same `style`, and
 * list items are bracketed by downlevel-hidden conditional comments.
 *
 * The smart quotes and the em dash are the payload, not the noise: Word is where
 * “ ” ’ — come from, and a repair that normalises them away would be vandalism.
 */
export const WORD = `<meta charset="utf-8"><h1 class="MsoNormal" style="margin:0cm;mso-fareast-font-family:&quot;Times New Roman&quot;;mso-outline-level:1"><span style="font-family:&quot;Calibri&quot;,sans-serif;mso-ascii-theme-font:minor-latin">The “Quarterly” Report</span><o:p></o:p></h1><p class="MsoNormal" style="margin:0cm;mso-fareast-font-family:&quot;Times New Roman&quot;;line-height:107%"><span style="font-family:&quot;Calibri&quot;,sans-serif;mso-fareast-font-family:&quot;Times New Roman&quot;;font-weight:bold">Margins held</span><span style="font-family:&quot;Calibri&quot;,sans-serif;mso-bidi-font-family:Calibri"> — that’s the whole story.</span><o:p></o:p></p><h2 class="MsoNormal" style="margin:0cm;mso-outline-level:2"><span style="font-family:&quot;Calibri&quot;,sans-serif">Outlook for next quarter</span><o:p></o:p></h2><!--[if !supportLists]--><p class="MsoListParagraph" style="margin-left:36.0pt;mso-add-space:auto;text-indent:-18.0pt;mso-list:l0 level1 lfo1"><span style="font-family:Symbol;mso-fareast-font-family:Symbol">·<span style="font:7.0pt &quot;Times New Roman&quot;">&nbsp;&nbsp;&nbsp; </span></span>Hiring stays frozen<o:p></o:p></p><!--[endif]-->`;

// ------------------------------------------------------------------ 3. Notion

/** Three levels of mixed list, a checklist, and a fenced code block. */
export const NOTION = `<ul><li>Ship the migration<ol><li>Freeze writes<ul><li>Announce in advance</li></ul></li><li>Backfill rows</li></ol></li></ul><ul><li><input type="checkbox" checked>Draft the announcement</li><li><input type="checkbox">Schedule the window</li></ul><pre><code class="language-javascript">const ready = await freeze();
if (!ready) throw new Error('aborted');</code></pre>`;

// -------------------------------------------------------- 4. VS Code/terminal

/**
 * Real tabs and real newlines. The point of this fixture is that every one of
 * those characters is content — a repair that trims or collapses them has
 * rewritten the writer's code.
 */
export const CODE_TEXT = `function retry(fn, times) {
\tfor (let i = 0; i < times; i += 1) {
\t\ttry {
\t\t\treturn fn();
\t\t} catch (err) {
\t\t\tif (i === times - 1) throw err;
\t\t}
\t}
}`;

/** VS Code puts a styled `<pre>` on the clipboard alongside the plain text. */
export const CODE_HTML = `<pre style="font-family:Consolas,monospace;font-size:14px;color:#d4d4d4;background-color:#1e1e1e;line-height:19px;white-space:pre;"><div>${CODE_TEXT.replace(/</g, '&lt;').replace(/\n/g, '</div><div>')}</div></pre>`;

/** A `<pre>` with no inner `<div>` scaffolding — what most terminals emit. */
export const CODE_PRE = `<pre style="color:#d4d4d4;background-color:#1e1e1e">${CODE_TEXT.replace(/</g, '&lt;')}</pre>`;

/** A terminal session: `text/plain` only, no markup at all. */
export const TERMINAL_TEXT = `$ npm run build
\tvite v8.2.0 building for production...
\t\t✓ 412 modules transformed.
$ echo done`;

// ------------------------------------------------------------- 5. Web article

/** Figure + caption, a pull quote with attribution, and a footnote anchor. */
export const ARTICLE = `<figure><img src="https://cdn.example.com/photo.jpg" alt="A harbour at dawn"><figcaption>Dawn over the harbour, taken in March</figcaption></figure><blockquote><p>Nothing about this was inevitable</p><cite>Marta Alvarez</cite></blockquote><p>The estimate has been disputed<a href="#fn1">1</a> more than once.</p>`;

/**
 * A caption past the 200-character cap the image node's `title` carries (the
 * same limit the caption input enforces). `ENDSHERE` sits well beyond the cut,
 * so it is the one word in this whole file that is *expected* to be lost.
 */
export const LONG_CAPTION_TAIL = 'ENDSHERE';
export const LONG_CAPTION_FIGURE = `<figure><img src="https://cdn.example.com/wide.jpg" alt="Wide"><figcaption>A very long caption ${'that keeps going and going '.repeat(9)}${LONG_CAPTION_TAIL}</figcaption></figure>`;

// --------------------------------------------------- 6. Plain text (markdown)

/**
 * `text/plain`, and it stays literal. The editor's input rules turn `## ` into a
 * heading *as you type*; paste is the opposite promise — a log file or a config
 * dump has to arrive exactly as it left.
 */
export const PLAIN_MARKDOWN = `## Heading
- item
---`;

// ------------------------------------------------------------- 7. Hostile HTML

/**
 * Nine separate attempts, all in one payload. Each one is a shape a real page
 * can put on the clipboard, and each has visible text that must survive the
 * removal of the attack — stripping a `javascript:` href must cost the reader
 * the link, not the sentence.
 */
export const HOSTILE = [
  '<script>alert(1)</script>',
  '<style>.doc::after{content:"stolen"}</style>',
  '<iframe src="https://evil.example/frame"></iframe>',
  '<img src=x onerror="alert(1)">',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="data:text/html,<script>x</script>">payload</a>',
  '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
  '<svg onload="alert(1)"></svg>',
  '<div onclick="steal()">text</div>',
  '<a href="vbscript:msgbox">legacy</a>',
  // The two classic encodings. The HTML parser decodes both before anything
  // sees the attribute, so the guard must reject the *decoded* value — an
  // allow-list that pattern-matched the raw string would wave these through.
  '<a href="&#106;avascript:alert(1)">entity</a>',
  '<a href="java&#9;script:alert(1)">tabbed</a>',
].join('');

/** The control: links the allow-list *does* accept have to come through intact. */
export const SAFE_LINKS = `<p>Read <a href="https://example.com/docs">the docs</a>, then <a href="mailto:team@example.com">mail the team</a>, or <a href="tel:+15550100">call us</a>.</p>`;

// ---------------------------------------------------------- 8. Pasted images

/**
 * One of each src the app can meet: remote, already-stored, inline base64, and
 * an `<img>` with no src at all. The surrounding words are load-bearing — they
 * are what proves that dropping an image does not drop the prose around it.
 */
export const IMAGES = `<p>Before the figure</p><img src="https://cdn.example.com/chart.png" alt="Chart"><img src="idb:abc123" alt="Stored"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="Inline"><img alt="Broken"><p>After the figure</p>`;

// --------------------------------------------------------- 9. Nested lists

/** `ul` → `ol` → `ul`, three levels, with siblings at every level. */
export const NESTED_LISTS = `<ul><li>Groceries<ol><li>Produce<ul><li>Apples</li><li>Spinach</li></ul></li><li>Dairy</li></ol></li><li>Hardware</li></ul>`;

// ----------------------------------------------------- 10. Nested blockquotes

/** Five levels — a quote of a quote of a quote, as mailing-list threads produce. */
export const DEEP_QUOTES = `<blockquote><p>Level one said</p><blockquote><p>Level two said</p><blockquote><p>Level three said</p><blockquote><p>Level four said</p><blockquote><p>Level five said it first</p></blockquote></blockquote></blockquote></blockquote></blockquote>`;

// ------------------------------------------------------------------ 11. Tables

/** `thead`/`tbody`, a `colspan`, and a layout table nested inside a cell. */
export const TABLE = `<table><thead><tr><th>Region</th><th colspan="2">Revenue and growth</th></tr></thead><tbody><tr><td>North</td><td>1200</td><td><table><tbody><tr><td>inner left</td><td>inner right</td></tr></tbody></table></td></tr><tr><td>South</td><td>900</td><td>flat</td></tr></tbody></table>`;

// ---------------------------------------------------------------- 12. Headings

/** All six levels, each with distinct words so a lost one is visible. */
export const HEADINGS = `<h1>Alpha</h1><h2>Bravo</h2><h3>Charlie</h3><h4>Delta</h4><h5>Echo</h5><h6>Foxtrot</h6>`;
