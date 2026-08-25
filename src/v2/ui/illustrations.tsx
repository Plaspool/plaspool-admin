/**
 * Empty-state illustrations.
 *
 * Drawn here as inline SVG rather than downloaded, for three reasons that
 * compound: they weigh nothing against a PNG, they inherit no licence, and
 * they are drawn IN the system's own palette — the indigo family plus one
 * amber accent — so an empty screen still looks like this product and not
 * like a stock-art interlude.
 *
 * One construction shared by all five, which is what makes them a set:
 * a soft indigo disc for atmosphere, a ground shadow, white objects with a
 * 2px indigo ink line, and at most one amber element per scene. The line
 * weight matches the UI's icon weight, so the drawings sit beside lucide
 * glyphs without a style break.
 *
 * They appear ONLY on a screen's true first-run state. A filter that matched
 * nothing keeps the plain icon ring — "no rows match" happens forty times a
 * day and a picture that fires forty times a day stops being warm.
 */

const INK = '#3d3a75';
const SOFT = '#eeedf5';
const SOFT_2 = '#dcd9ec';
const LINE = '#c3c0dc';
const AMBER = '#ffd6a4';
const AMBER_INK = '#d9a514';

const common = {
  fill: 'none',
  stroke: INK,
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Stage({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 220 160" role="img" aria-hidden="true" focusable="false">
      <circle cx="110" cy="74" r="62" fill={SOFT} />
      <ellipse cx="110" cy="142" rx="64" ry="7" fill={INK} opacity="0.07" />
      {children}
    </svg>
  );
}

function Sparkle({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <path
      d={`M${x} ${y - 5 * s} L${x + 1.6 * s} ${y - 1.6 * s} L${x + 5 * s} ${y} L${x + 1.6 * s} ${y + 1.6 * s} L${x} ${y + 5 * s} L${x - 1.6 * s} ${y + 1.6 * s} L${x - 5 * s} ${y} L${x - 1.6 * s} ${y - 1.6 * s} Z`}
      fill={AMBER_INK}
      stroke="none"
      opacity="0.85"
    />
  );
}

/** Orders — a till receipt with a paid seal. */
export function ReceiptArt() {
  return (
    <Stage>
      {/* the receipt, zigzag hem */}
      <path
        d="M78 34 h64 v88 l-8 -6 -8 6 -8 -6 -8 6 -8 -6 -8 6 -8 -6 -8 6 Z"
        fill="#ffffff"
        stroke={INK}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <line x1="90" y1="52" x2="130" y2="52" {...common} stroke={LINE} />
      <line x1="90" y1="64" x2="122" y2="64" {...common} stroke={LINE} />
      <line x1="90" y1="76" x2="130" y2="76" {...common} stroke={LINE} />
      <line x1="90" y1="88" x2="114" y2="88" {...common} stroke={LINE} />
      {/* total row in ink */}
      <line x1="90" y1="102" x2="102" y2="102" {...common} />
      <line x1="118" y1="102" x2="130" y2="102" {...common} />
      {/* the paid seal, amber */}
      <circle cx="146" cy="106" r="17" fill={AMBER} stroke={INK} strokeWidth="2" />
      <path d="M139 106 l5 5 9 -10" {...common} />
      <Sparkle x={64} y={46} />
      <Sparkle x={158} y={58} s={0.7} />
    </Stage>
  );
}

/** Discounts — a ticket with punched notches and a percent face. */
export function CouponArt() {
  return (
    <Stage>
      <g transform="rotate(-8 110 82)">
        {/* body */}
        <path
          d="M52 62 h116 a8 8 0 0 1 8 8 v6 a9 9 0 0 0 0 18 v6 a8 8 0 0 1 -8 8 h-116 a8 8 0 0 1 -8 -8 v-6 a9 9 0 0 0 0 -18 v-6 a8 8 0 0 1 8 -8 Z"
          fill="#ffffff"
          stroke={INK}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* perforation */}
        <line x1="132" y1="66" x2="132" y2="104" {...common} stroke={LINE} strokeDasharray="3 5" />
        {/* percent face */}
        <circle cx="82" cy="76" r="7" {...common} />
        <circle cx="106" cy="94" r="7" {...common} />
        <line x1="108" y1="70" x2="80" y2="100" {...common} />
        {/* stub bars */}
        <line x1="144" y1="78" x2="158" y2="78" {...common} stroke={SOFT_2} />
        <line x1="144" y1="90" x2="154" y2="90" {...common} stroke={SOFT_2} />
      </g>
      {/* amber tag riding the corner */}
      <circle cx="164" cy="52" r="12" fill={AMBER} stroke={INK} strokeWidth="2" />
      <circle cx="164" cy="52" r="3" fill="#ffffff" stroke={INK} strokeWidth="1.5" />
      <Sparkle x={52} y={44} />
      <Sparkle x={172} y={112} s={0.8} />
    </Stage>
  );
}

/** Products — an open carton with a filament spool peeking out. PlaSpool
 *  sells spools; the box should hold what the shop holds. */
export function BoxArt() {
  return (
    <Stage>
      {/* the spool, sitting IN the box (drawn first, clipped by the front) */}
      <circle cx="110" cy="66" r="24" fill="#ffffff" stroke={INK} strokeWidth="2" />
      <circle cx="110" cy="66" r="16" fill={SOFT_2} stroke={INK} strokeWidth="2" />
      <circle cx="110" cy="66" r="6" fill="#ffffff" stroke={INK} strokeWidth="2" />
      {/* winding */}
      <path d="M96 56 a18 18 0 0 1 28 0" {...common} stroke={LINE} />
      <path d="M94 62 a20 16 0 0 1 32 0" {...common} stroke={LINE} />
      {/* carton front */}
      <path d="M62 84 L110 96 L158 84 L158 122 L110 134 L62 122 Z" fill="#ffffff" stroke={INK} strokeWidth="2" />
      <line x1="110" y1="96" x2="110" y2="134" {...common} />
      {/* open flaps */}
      <path d="M62 84 L48 70 L96 60 L110 96 Z" fill={SOFT_2} stroke={INK} strokeWidth="2" />
      <path d="M158 84 L172 70 L124 60 L110 96 Z" fill="#ffffff" stroke={INK} strokeWidth="2" />
      {/* amber cube beside */}
      <rect x="164" y="106" width="20" height="20" rx="3" fill={AMBER} stroke={INK} strokeWidth="2" />
      <Sparkle x={54} y={48} />
    </Stage>
  );
}

/** Customers — two people, one starred. */
export function PeopleArt() {
  return (
    <Stage>
      {/* back figure */}
      <circle cx="88" cy="62" r="15" fill={SOFT_2} stroke={INK} strokeWidth="2" />
      <path d="M60 116 a28 26 0 0 1 56 0" fill={SOFT_2} stroke={INK} strokeWidth="2" />
      {/* front figure */}
      <circle cx="128" cy="70" r="17" fill="#ffffff" stroke={INK} strokeWidth="2" />
      <path d="M98 128 a30 28 0 0 1 60 0" fill="#ffffff" stroke={INK} strokeWidth="2" />
      {/* star badge */}
      <circle cx="152" cy="98" r="13" fill={AMBER} stroke={INK} strokeWidth="2" />
      <path
        d="M152 91.5 l1.9 3.9 4.3 0.6 -3.1 3 0.7 4.3 -3.8 -2 -3.8 2 0.7 -4.3 -3.1 -3 4.3 -0.6 Z"
        fill="#ffffff"
        stroke={INK}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <Sparkle x={60} y={50} />
      <Sparkle x={166} y={52} s={0.8} />
    </Stage>
  );
}

/** Blog — a page mid-sentence, pencil still on it. */
export function PageArt() {
  return (
    <Stage>
      <rect x="72" y="34" width="76" height="94" rx="6" fill="#ffffff" stroke={INK} strokeWidth="2" />
      <line x1="84" y1="54" x2="126" y2="54" {...common} />
      <line x1="84" y1="68" x2="136" y2="68" {...common} stroke={LINE} />
      <line x1="84" y1="80" x2="136" y2="80" {...common} stroke={LINE} />
      <line x1="84" y1="92" x2="118" y2="92" {...common} stroke={LINE} />
      {/* the pencil, amber shaft */}
      <g transform="rotate(38 148 96)">
        <rect x="140" y="58" width="14" height="56" rx="2" fill={AMBER} stroke={INK} strokeWidth="2" />
        <path d="M140 114 h14 l-7 14 Z" fill="#ffffff" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        <rect x="140" y="52" width="14" height="8" rx="2" fill={SOFT_2} stroke={INK} strokeWidth="2" />
      </g>
      <Sparkle x={58} y={56} />
    </Stage>
  );
}

/** A category shelf — used where a grouping has nothing in it yet. */
export function ShelfArt() {
  return (
    <Stage>
      <rect x="60" y="44" width="100" height="80" rx="8" fill="#ffffff" stroke={INK} strokeWidth="2" />
      <line x1="60" y1="84" x2="160" y2="84" {...common} />
      {/* items on the top shelf */}
      <rect x="72" y="60" width="18" height="24" rx="2" fill={SOFT_2} stroke={INK} strokeWidth="2" />
      <rect x="96" y="54" width="16" height="30" rx="2" fill={AMBER} stroke={INK} strokeWidth="2" />
      <circle cx="134" cy="72" r="12" fill={SOFT_2} stroke={INK} strokeWidth="2" />
      {/* the empty lower shelf is the point */}
      <line x1="76" y1="106" x2="106" y2="106" {...common} stroke={LINE} strokeDasharray="2 6" />
      <Sparkle x={172} y={60} s={0.8} />
    </Stage>
  );
}

/**
 * The 2×2 product-picture shelf for the products first-run state — the
 * reference shows four product photos in soft tiles; ours shows four spool
 * colourways, because spools are the product. Each tile is one spool seen
 * face-on, wound in a different colour, on the shared soft ground.
 */
function SpoolFace({ wind, deep }: { wind: string; deep: string }) {
  return (
    <svg viewBox="0 0 96 96" role="img" aria-hidden="true" focusable="false">
      <circle cx="48" cy="50" r="30" fill="#ffffff" stroke={INK} strokeWidth="2" />
      <circle cx="48" cy="50" r="21" fill={wind} stroke={INK} strokeWidth="2" />
      {/* winding grooves */}
      <path d="M31 42 a24 20 0 0 1 34 0" fill="none" stroke={deep} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M29 50 a26 22 0 0 1 38 0" fill="none" stroke={deep} strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
      <path d="M31 58 a24 20 0 0 0 34 0" fill="none" stroke={deep} strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
      <circle cx="48" cy="50" r="8" fill="#ffffff" stroke={INK} strokeWidth="2" />
      <circle cx="48" cy="50" r="3" fill={SOFT_2} stroke={INK} strokeWidth="1.5" />
      {/* loose filament end */}
      <path d="M69 42 q10 -8 16 -2" fill="none" stroke={deep} strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="48" cy="84" rx="26" ry="4" fill={INK} opacity="0.06" />
    </svg>
  );
}

export function SpoolTiles() {
  const ways: [string, string][] = [
    ['#8d88c7', '#4a45a1'], // violet
    ['#f2c078', '#b98900'], // amber
    ['#9fd4b4', '#3e8f63'], // sage
    ['#eba3a3', '#a84848'], // rose
  ];
  return (
    <>
      {ways.map(([wind, deep]) => (
        <span className="splitempty__tile" key={wind}>
          <SpoolFace wind={wind} deep={deep} />
        </span>
      ))}
    </>
  );
}
