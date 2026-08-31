#!/usr/bin/env bash
#
# Export the v2 admin design system into another project.
# See DESIGN-SYSTEM-HANDOFF.md for what each tier is and why.
#
#   Usage: bash export-ds.sh /path/to/target/src/design [--with-richtext]
#
# By default RichText.tsx is NOT part of the working tree — it needs a data
# layer and 11 TipTap packages — so its one specimen is stripped out of the
# exported DesignGallery, which would otherwise fail to compile. Pass
# --with-richtext to keep both (you must then wire its three data imports).
#
set -euo pipefail

SRC="$(git rev-parse --show-toplevel)/src/v2"
DEST="${1:?usage: bash export-ds.sh <dest-dir> [--with-richtext]}"
WITH_RICHTEXT="${2:-}"

mkdir -p "$DEST/styles" "$DEST/ui" "$DEST/routes"

# ── Tier 1 · stylesheets (verbatim, import in this order) ──────────────────
cp "$SRC"/styles/tokens.css "$SRC"/styles/base.css "$SRC"/styles/ui.css \
   "$SRC"/styles/page.css "$SRC"/styles/shell.css "$DEST/styles/"

# ── Tier 1 · the 18 pure components (react / react-router-dom / lucide only)
for f in primitives Page DataTable Field Float Menu Modal Toast TagInput \
         SearchSelect StatusPicker PopEdit SaveBar TableScroll Timeline \
         Card Defs illustrations; do
  cp "$SRC/ui/$f.tsx" "$DEST/ui/"
done

# ── Tier 4 · the living style guide — mount at /design, outside any auth gate
cp "$SRC/routes/DesignGallery.tsx" "$DEST/routes/"

# ── Tier 2 · copied but NOT wired: these import a data layer you must supply
mkdir -p "$DEST/_needs-rewiring"
cp "$SRC"/ui/Img.tsx "$DEST/_needs-rewiring/"

if [ "$WITH_RICHTEXT" = "--with-richtext" ]; then
  cp "$SRC"/ui/RichText.tsx "$DEST/ui/"
  RT_NOTE="RichText.tsx is in ui/ and the gallery still renders it — wire its
     three data imports (shared/doc, data/docguards, data/images) and install
     the 11 @tiptap/* packages, or it will not compile."
else
  cp "$SRC"/ui/RichText.tsx "$DEST/_needs-rewiring/"
  # The gallery imports RichText on one line and renders it in one Section.
  # Both go, or the export does not compile.
  #
  # Done in node, NOT sed: this tree is checked out CRLF, and Git Bash's
  # `sed -i` rewrites every line ending to LF — a four-line edit that lands in
  # the target as a whole-file diff. Node edits the string and leaves every
  # other byte alone.
  #
  # Written to a FILE rather than passed to `node -e`: MSYS/Git Bash rewrites
  # arguments that look like paths, and a JS regex literal starting with `/`
  # looks exactly like one. Inline, the patterns arrive silently corrupted and
  # the strip becomes a no-op that still exits 0.
  STRIP_JS="$(mktemp -t stripRichText.XXXXXX.cjs)"
  cat > "$STRIP_JS" <<'STRIPJS'
const fs = require('fs');
const p = process.argv[2];
const before = fs.readFileSync(p, 'utf8');
const out = before
  .replace(/^import \{ RichText \} from '\.\.\/ui\/RichText';\r?\n/m, '')
  .replace(/[ \t]*<Section title="Rich text[\s\S]*?<\/Section>\r?\n/, '')
  // SAMPLE_DOC fed only that specimen. Left behind it is an unused local,
  // and this project builds with noUnusedLocals — so the orphan is a real
  // compile error, not lint noise.
  .replace(/^const SAMPLE_DOC = \{\r?\n[\s\S]*?^\};\r?\n\r?\n/m, '');
if (out === before || /RichText|SAMPLE_DOC/.test(out)) {
  console.error('ERROR: could not strip the RichText specimen cleanly.');
  process.exit(1);
}
fs.writeFileSync(p, out);
STRIPJS
  node "$STRIP_JS" "$DEST/routes/DesignGallery.tsx"
  rm -f "$STRIP_JS"
  RT_NOTE="RichText.tsx was moved to _needs-rewiring/ and its one specimen was
     stripped from the exported gallery. Re-run with --with-richtext to keep it."
fi

# ── Tier 3 · shell — reference only; rewrite for your app, then delete
mkdir -p "$DEST/_shell-reference"
cp "$SRC"/shell/Shell.tsx "$SRC"/shell/nav.tsx "$SRC"/shell/Gate.tsx \
   "$SRC"/shell/Palette.tsx "$SRC"/shell/Alerts.tsx "$DEST/_shell-reference/"

printf '\nCopied %s files to %s\n\n' \
  "$(find "$DEST" -type f | wc -l | tr -d ' ')" "$DEST"
cat <<'NEXT'
Next:
  1. npm i react react-dom react-router-dom lucide-react \
       @fontsource-variable/inter @fontsource-variable/jetbrains-mono
  2. In your entry file, import the stylesheets IN ORDER:
       ./design/styles/tokens.css
       ./design/styles/base.css
       ./design/styles/ui.css
       ./design/styles/page.css
       ./design/styles/shell.css
  3. Mount routes/DesignGallery.tsx at /design, OUTSIDE the auth gate.
  4. Screenshot it and compare against #/design in plaspool-admin.
  5. Delete _shell-reference/ once your own shell is built.
NEXT
printf '\nNote: %s\n' "$RT_NOTE"
