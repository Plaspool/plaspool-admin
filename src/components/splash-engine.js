/*
 * PORTED FROM `splash.local/splash.js` — DO NOT EDIT THIS COPY BY HAND.
 *
 * `splash.local/` is the review harness: it has the scrub rig, the forced-
 * fallback page, and `checks.html`, which asserts every bug this engine was
 * built to stop regressing (seek(NaN) wedging the splash on screen forever, an
 * OS reduced-motion setting being overridable downward, onDone firing twice,
 * a surface reporting `renderer: "webgl"` while drawing nothing). None of that
 * can run against a bundled module, so the harness keeps the classic-script
 * original and this file is generated from it by
 * `node_modules/.cache/splash-port.cjs`.
 *
 * Editing here silently un-tests the engine. Change `splash.local/splash.js`,
 * re-run the checks, then re-run the port.
 *
 * The port is three mechanical edits and nothing else: the IIFE is bound to a
 * const, its `window.PlaSpoolSplash =` becomes a `return`, and a default
 * export is appended. No reformatting, so `diff` against the harness copy
 * stays readable.
 */
/**
 * PlaSpool opening sequence — the mark fabricates itself, then catches the light.
 *
 * Classic script, no modules, no fetch, no dependencies. It has to run from a
 * `file://` page (the review harness) and it has to drop into the app's
 * `index.html` as one `<script>` before the bundle, so anything that needs a
 * server is off the table. The path data is inlined below for the same reason.
 *
 * WHY WEBGL AND NOT A MASKED GRADIENT
 * The usual "metallic logo" is a linear gradient sliding across a flat alpha
 * mask. It always reads as grey paint on a silhouette, and the reason is that a
 * flat mask has no normal — every pixel of the stroke faces the viewer, so the
 * highlight can only translate, never *track the form*. Here the stroke is
 * tessellated into a real ribbon and the fragment shader synthesises the normal
 * of a half-round extruded bead. The highlight then lands where the surface
 * actually faces the light, which means it crawls non-linearly around the bends
 * and stretches along the extrusion direction. That difference is the entire
 * point of the file; everything else is bookkeeping.
 *
 * WHAT DRIVES THE CHOREOGRAPHY
 * The mark is two closed loops that are tangent at (405.5, 655) — they touch,
 * they never cross. The outer loop's own arc-length parameterisation says that
 * contact happens at 65.0% of its run. So the bowl does not start on a tuned
 * delay; it starts when the head *arrives*, by sharing one arc-length clock with
 * the outer loop and being offset along it by the measured tangency distance.
 * Retrace the logo and the handoff moves with it. See TANGENCY below.
 *
 * DETERMINISM
 * `render(t)` is a pure function of `t`. No accumulators, no `Date.now()` below
 * the timeline layer. Two calls to `seek(900)` produce byte-identical pixels,
 * which is what makes `frameHash()` worth anything and what lets a reviewer
 * freeze a frame and argue about it.
 */
const PlaSpoolSplash = (function () {
  'use strict';

  /* ================================================================
     1. THE MARK
     ================================================================ */

  /**
   * Traced from `public/brand/logomark-light.png` and verified at IoU 0.98332
   * against the source mask (max deviation 2.0px, and 98% of the mismatched
   * pixels lie within 1px of the other shape — i.e. threshold jitter on the
   * PNG's antialiased edge, not shape error). Do not "improve" these curves;
   * they are fitted cubics, not circles, and the fit has been measured.
   *
   * Both sub-paths are CLOSED, so the mark has no free stroke terminals and
   * `linecap` never renders. The only cap this animation ever draws is the
   * moving nozzle tip, which is a straight cut across the bead — which is what a
   * real deposited bead looks like mid-run, so that is a feature.
   */
  var MARK = {
    viewBox: 1080,
    strokeWidth: 52,
    /** The two loops touch here. Measured, not eyeballed — see TANGENCY. */
    tangency: [405.5, 655],
    loops: [
      {
        name: 'outer',
        d: 'M523.13 256.05C536.38 254.86 549.82 255.37 563.07 256.33C652.7 262.83 726.01 307.66 771.23 385.67C819.11 468.25 829.48 582.92 792.41 671.32C761.38 745.31 689.57 810.73 607.99 821.27C592.01 823.34 576.19 823.5 560.1 823.5C480.81 823.5 418.5 797.91 407.77 711.1C406.08 697.39 407.93 675.63 401.78 663.77C396.08 652.77 385.89 648.72 375.19 643.99C278.93 601.36 239.61 491.11 279.86 395.1C311.15 320.44 385.42 278.68 461.62 263.17C482.05 259.01 502.45 257.9 523.13 256.05Z',
      },
      {
        name: 'bowl',
        d: 'M412.46 649.53C409.23 645.3 407.03 640.25 406.14 635.01C402.91 616.18 405.77 546.81 409.91 527.4C418.74 486.08 444.46 447.74 486.74 435.7C525.43 424.68 573.79 436.13 600.71 466.69C628.17 497.86 634.51 544.52 622.35 583.5C609.31 625.31 573.62 652.68 531.79 662.14C505.68 668.04 430.01 672.48 412.46 649.53Z',
      },
    ],
  };

  /**
   * Flattening tolerance in mark units (the 1080 box). 0.15 gives 146 stations
   * on the outer loop and 89 on the bowl — 235 total, which is nothing — and
   * caps the turn between consecutive segments at 9.7°. That number is the whole
   * reason the join strategy below is allowed to be simple.
   */
  var FLATTEN_TOL = 0.15;

  /**
   * Longest run a flattened segment may take before it is split anyway. Without
   * this, the near-straight stretch down the left of the outer loop collapses to
   * two or three very long segments, and the shader's per-vertex tangent and
   * curvature then interpolate over 200 units — the highlight visibly kinks
   * where it should glide. Cheap insurance: it costs a handful of vertices.
   */
  var MAX_SEG = 26;

  /* ================================================================
     2. GEOMETRY — parse, flatten, measure
     ================================================================ */

  /** Parses the `M x y (C ...)+ Z` subset these two paths actually use. */
  function parsePath(d) {
    var nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi).map(Number);
    var i = 0;
    var start = [nums[i++], nums[i++]];
    var cur = start;
    var segs = [];
    while (i + 5 < nums.length) {
      var c1 = [nums[i++], nums[i++]];
      var c2 = [nums[i++], nums[i++]];
      var p = [nums[i++], nums[i++]];
      segs.push([cur, c1, c2, p]);
      cur = p;
    }
    return { start: start, segs: segs, end: cur };
  }

  function cubicAt(s, t) {
    var p0 = s[0], p1 = s[1], p2 = s[2], p3 = s[3];
    var u = 1 - t;
    var a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
    return [
      a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1],
    ];
  }

  /**
   * Recursive flattening on the midpoint-to-chord distance. The `len > MAX_SEG`
   * clause is not a flatness test — see MAX_SEG.
   */
  function flattenCubic(seg, out, t0, t1, depth) {
    var p0 = cubicAt(seg, t0);
    var p3 = cubicAt(seg, t1);
    var tm = (t0 + t1) * 0.5;
    var pm = cubicAt(seg, tm);
    var dx = p3[0] - p0[0], dy = p3[1] - p0[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    var err;
    if (len < 1e-9) {
      err = Math.sqrt((pm[0] - p0[0]) * (pm[0] - p0[0]) + (pm[1] - p0[1]) * (pm[1] - p0[1]));
    } else {
      err = Math.abs((pm[0] - p0[0]) * dy - (pm[1] - p0[1]) * dx) / len;
    }
    if (depth > 20 || (err <= FLATTEN_TOL && len <= MAX_SEG)) {
      out.push(p3);
      return;
    }
    flattenCubic(seg, out, t0, tm, depth + 1);
    flattenCubic(seg, out, tm, t1, depth + 1);
  }

  /**
   * Closed polyline for one loop, plus per-station arc length, unit tangent,
   * mitered normal and signed curvature.
   *
   * JOINS. A ribbon built by offsetting each station along the *segment* normal
   * tears open on the outside of a bend and folds over on the inside. The fix is
   * to offset along the angle bisector and lengthen the offset by 1/cos(θ/2) so
   * the two segment edges still meet — a miter. Miters blow up as θ→180°, so the
   * factor is clamped; past the clamp the corner bevels slightly instead of
   * spiking. On this mark the worst case is θ = 9.7°, giving a factor of 1.0036,
   * so the clamp never engages and the corner treatment is academic. It stays in
   * because the file is meant to survive someone re-tracing the logo.
   */
  function buildLoop(loop) {
    var parsed = parsePath(loop.d);
    var pts = [parsed.start.slice()];
    for (var s = 0; s < parsed.segs.length; s++) {
      flattenCubic(parsed.segs[s], pts, 0, 1, 0);
    }
    // The final cubic lands back on the start point (these paths close
    // exactly, gap < 1e-6), so drop the duplicate — the loop wraps implicitly.
    var lastP = pts[pts.length - 1];
    if (Math.abs(lastP[0] - pts[0][0]) < 1e-4 && Math.abs(lastP[1] - pts[0][1]) < 1e-4) pts.pop();

    // Coincident stations produce a zero-length tangent and a NaN normal, which
    // in WebGL is a silently invisible triangle rather than an error.
    var clean = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var q = clean[clean.length - 1];
      if (Math.abs(pts[i][0] - q[0]) > 1e-6 || Math.abs(pts[i][1] - q[1]) > 1e-6) clean.push(pts[i]);
    }
    pts = clean;

    var n = pts.length;
    var arc = new Float64Array(n + 1);
    var segLen = new Float64Array(n);
    for (var j = 0; j < n; j++) {
      var a = pts[j], b = pts[(j + 1) % n];
      segLen[j] = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
      arc[j + 1] = arc[j] + segLen[j];
    }
    var total = arc[n];

    var tan = new Float64Array(n * 2);
    var nrm = new Float64Array(n * 2);
    var curv = new Float64Array(n);
    var MITER_LIMIT = 2.4;
    var maxMiter = 1;
    var maxTurn = 0;

    for (var k = 0; k < n; k++) {
      var prev = pts[(k - 1 + n) % n], here = pts[k], next = pts[(k + 1) % n];
      var lp = segLen[(k - 1 + n) % n] || 1e-9;
      var ln = segLen[k] || 1e-9;
      var t1x = (here[0] - prev[0]) / lp, t1y = (here[1] - prev[1]) / lp;
      var t2x = (next[0] - here[0]) / ln, t2y = (next[1] - here[1]) / ln;

      var tax = t1x + t2x, tay = t1y + t2y;
      var tal = Math.sqrt(tax * tax + tay * tay);
      if (tal < 1e-6) {
        // A 180° reversal (a cusp). Impossible on this mark, but a bisector is
        // undefined here, so fall back to the outgoing segment's own normal.
        tax = t2x; tay = t2y; tal = 1;
      }
      tax /= tal; tay /= tal;

      // Screen-space left normal. y runs downward in the mark's coordinates, so
      // this is (-ty, tx); which side is "+1 across" does not matter as long as
      // it never flips, and a bisector cannot flip on a G1 path.
      var nax = -tay, nay = tax;
      var miter = 1 / Math.max(nax * -t2y + nay * t2x, 1e-3);
      if (miter > MITER_LIMIT) miter = MITER_LIMIT;
      if (miter > maxMiter) maxMiter = miter;

      tan[k * 2] = tax; tan[k * 2 + 1] = tay;
      nrm[k * 2] = nax * miter; nrm[k * 2 + 1] = nay * miter;

      // Signed turn, positive when the path bends toward the +normal side.
      var cross = t1x * t2y - t1y * t2x;
      var dot = Math.max(-1, Math.min(1, t1x * t2x + t1y * t2y));
      var turn = Math.atan2(cross, dot);
      if (Math.abs(turn) > maxTurn) maxTurn = Math.abs(turn);
      curv[k] = turn / ((lp + ln) * 0.5);
    }

    return {
      name: loop.name,
      pts: pts,
      arc: arc,
      total: total,
      tan: tan,
      nrm: nrm,
      curv: curv,
      stations: n,
      maxMiter: maxMiter,
      maxTurnDeg: (maxTurn * 180) / Math.PI,
    };
  }

  /**
   * Arc position on `loop` of the point nearest `target`, projected onto the
   * segments rather than snapped to a station.
   */
  function projectArc(loop, target) {
    var best = Infinity, bestArc = 0, bestPt = null;
    var n = loop.stations;
    for (var i = 0; i < n; i++) {
      var a = loop.pts[i], b = loop.pts[(i + 1) % n];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var L2 = dx * dx + dy * dy;
      var t = L2 > 0 ? ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var px = a[0] + t * dx, py = a[1] + t * dy;
      var d = Math.sqrt((px - target[0]) * (px - target[0]) + (py - target[1]) * (py - target[1]));
      if (d < best) {
        best = d;
        bestArc = loop.arc[i] + t * Math.sqrt(L2);
        bestPt = [px, py];
      }
    }
    return { dist: best, arc: bestArc, pt: bestPt };
  }

  /* ---------------------------------------------------------------
     TANGENCY — where the filament splits.

     The bowl must begin extruding at the instant the outer loop's head reaches
     the point they touch, or the two loops read as two separate strokes instead
     of one continuous bead. That instant is not a time; it is an arc length.

     `handoffArc` is the distance the head has travelled along the OUTER loop
     when it arrives at the junction. Both loops are then driven by one shared
     arc clock, and the bowl's clock is simply offset by that number. There is no
     delay constant anywhere in this file.

     THE NUMBER. The shipped code measures s/L = 0.649765, by projecting the
     bowl's start point onto the outer loop's render polyline. That probe is
     used because it stays meaningful if the mark is re-traced — it asks "where
     does the bowl begin?" rather than depending on a hand-noted coordinate.

     An earlier version of this comment claimed three independent measurements
     agreeing to four decimals. They were not independent. All three ran through
     `projectArc`, which clamps to a polyline vertex, and at a convex corner a
     whole wedge of query points clamps to the SAME vertex — so the trace's
     tangency and the bowl's start returned bit-identical values. A check that
     cannot disagree is not a check, and in a file that sells "measured, not
     eyeballed" that was the one comment a maintainer had to be able to
     re-derive.

     `verifyHandoff()` is the honest version: it re-derives the same quantity
     from a dense resample of the CUBICS (400 samples per segment, no polyline,
     no clamping), which is a genuinely different discretisation and can
     therefore genuinely disagree. Current agreement is 3.1e-4 — the two routes
     differ only by the render polyline's 0.15px flattening tolerance. If a
     retrace ever moved the junction, the two would diverge and say so.

     One nuance worth knowing before someone "fixes" it. The two centrelines are
     16.7px apart at their closest, and the bead is 52px wide, so the deposited
     material of the two loops first touches at s/L = 0.622 — about 28ms of head
     travel BEFORE the formal handoff. The join therefore looks fused slightly
     before the split fires, which is exactly the read we want and is why the
     handoff never shows a seam.
     --------------------------------------------------------------- */

  var GEOM = (function () {
    var loops = MARK.loops.map(buildLoop);
    var outer = loops[0], bowl = loops[1];
    var byBowlStart = projectArc(outer, bowl.pts[0]);
    var byTangency = projectArc(outer, MARK.tangency);
    var handoffArc = byBowlStart.arc;

    // One head, one speed. The outer runs from 0; the bowl runs from the
    // junction. Whichever finishes last defines the extrude phase's length.
    var budget = Math.max(outer.total, handoffArc + bowl.total);

    return {
      loops: loops,
      outer: outer,
      bowl: bowl,
      handoffArc: handoffArc,
      handoffFrac: handoffArc / outer.total,
      handoffFracOfBudget: handoffArc / budget,
      outerCloseFrac: outer.total / budget,
      budget: budget,
      halfWidth: MARK.strokeWidth / 2,
      /** Kept for the review page's readout; nothing in the render reads them. */
      diagnostics: {
        outerLength: outer.total,
        bowlLength: bowl.total,
        outerStations: outer.stations,
        bowlStations: bowl.stations,
        maxTurnDeg: Math.max(outer.maxTurnDeg, bowl.maxTurnDeg),
        maxMiter: Math.max(outer.maxMiter, bowl.maxMiter),
        handoff: byBowlStart.arc / outer.total,
        handoffArc: byBowlStart.arc,
        // Distance from the probe point to the polyline it was projected onto.
        // Both probes clamp to the same corner vertex, which is exactly why the
        // old "three independent measurements" claim was hollow — kept visible
        // so the collapse is legible rather than hidden.
        probeDistBowlStart: byBowlStart.dist,
        probeDistTangency: byTangency.dist,
      },
    };
  })();

  /**
   * Re-derive the handoff from the cubics directly, bypassing the render
   * polyline entirely: uniform resampling at 400 points per segment, exact
   * nearest-sample search, no clamping to shared vertices. This is the
   * independent route the header comment refers to, and unlike the projection
   * it is free to disagree.
   *
   * Lazy and uncached-by-design cost: ~4400 point evaluations, a few
   * milliseconds. Nothing in the render path calls it; it exists so a check can
   * fail.
   */
  function verifyHandoff(samplesPerSeg) {
    var per = num(samplesPerSeg, 400);
    function dense(d) {
      var parsed = parsePath(d);
      var pts = [parsed.start.slice()];
      for (var s = 0; s < parsed.segs.length; s++) {
        for (var k = 1; k <= per; k++) pts.push(cubicAt(parsed.segs[s], k / per));
      }
      pts.pop(); // the last sample lands on the start point; the loop wraps
      var arc = [0];
      for (var i = 0; i < pts.length; i++) {
        var a = pts[i], b = pts[(i + 1) % pts.length];
        arc.push(arc[i] + Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1])));
      }
      return { pts: pts, arc: arc, total: arc[pts.length] };
    }
    var O = dense(MARK.loops[0].d);
    var B = dense(MARK.loops[1].d);
    var target = B.pts[0];
    var bi = 0, bd = Infinity;
    for (var i = 0; i < O.pts.length; i++) {
      var dx = O.pts[i][0] - target[0], dy = O.pts[i][1] - target[1];
      var d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; bi = i; }
    }
    var denseFrac = O.arc[bi] / O.total;
    var shippedFrac = GEOM.handoffFrac;
    return {
      shipped: shippedFrac,
      denseCubic: denseFrac,
      delta: Math.abs(denseFrac - shippedFrac),
      outerLengthShipped: GEOM.outer.total,
      outerLengthDense: O.total,
      bowlLengthShipped: GEOM.bowl.total,
      bowlLengthDense: B.total,
      samplesPerSeg: per,
    };
  }

  /* ================================================================
     3. RIBBON MESH
     ================================================================ */

  /**
   * Three vertices per station: across = −1, 0, +1.
   *
   * The middle row exists for the DEPTH BUFFER, not for shading. Where the two
   * loops overlap near the junction, one bead's grazing rim lands on top of the
   * other bead's crown — and a grazing rim is where the fresnel term is
   * brightest, so without arbitration you get a bright hairline drawn straight
   * across the other stroke. Giving each vertex a z of −beadHeight and letting
   * the depth test pick the winner resolves it the way two real beads resolve
   * it: the taller one is the one you see. A two-row ribbon can only interpolate
   * a flat z, so the centre row is what makes that possible.
   *
   * The last station is DUPLICATED with arc = total rather than wrapping the
   * index buffer back to station 0. Wrapping is tempting and wrong: the quad
   * that bridges the seam would interpolate `aArc` from ~1770 back down to 0, so
   * the draw-on test runs backwards across it and a thin wedge of the finished
   * mark appears at the start point on frame one. The duplicate shares the
   * position, normal and tangent of station 0 — computed with wrapped
   * neighbours, so it is G1-continuous — and differs only in arc. No notch.
   */
  function buildRibbon(loop) {
    var n = loop.stations;
    var stations = n + 1; // + the seam duplicate
    var verts = stations * 3;
    // 9 floats per vertex: pos.xy | nrm.xy | tan.xy | across | arc | curv.
    // Kept in one place; the attribute pointers read it back from `stride`.
    var STRIDE_FLOATS = 9;
    var data = new Float32Array(verts * STRIDE_FLOATS);
    var w = 0;

    for (var si = 0; si < stations; si++) {
      var i = si % n;
      var arc = si === n ? loop.total : loop.arc[i];
      for (var r = 0; r < 3; r++) {
        var across = r - 1; // −1, 0, +1
        data[w++] = loop.pts[i][0];
        data[w++] = loop.pts[i][1];
        data[w++] = loop.nrm[i * 2];
        data[w++] = loop.nrm[i * 2 + 1];
        data[w++] = loop.tan[i * 2];
        data[w++] = loop.tan[i * 2 + 1];
        data[w++] = across;
        data[w++] = arc;
        data[w++] = loop.curv[i];
      }
    }

    // Two quads per station pair (rim→crown, crown→rim), four triangles.
    var idx = [];
    for (var s = 0; s < n; s++) {
      var A = s * 3, B = (s + 1) * 3;
      idx.push(A + 0, A + 1, B + 0, A + 1, B + 1, B + 0);
      idx.push(A + 1, A + 2, B + 1, A + 2, B + 2, B + 1);
    }
    var Index = verts > 65535 ? Uint32Array : Uint16Array;
    return {
      data: data,
      index: new Index(idx),
      count: idx.length,
      stride: STRIDE_FLOATS * 4,
    };
  }

  /* ================================================================
     4. TIMELINE — a pure function of t
     ================================================================ */

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function span(t, a, b) { return b <= a ? (t >= b ? 1 : 0) : clamp01((t - a) / (b - a)); }
  function smoothstep(x) { x = clamp01(x); return x * x * (3 - 2 * x); }
  function easeOutCubic(x) { x = clamp01(x); var u = 1 - x; return 1 - u * u * u; }
  function easeOutQuint(x) { x = clamp01(x); var u = 1 - x; return 1 - u * u * u * u * u; }
  function easeInOutCubic(x) {
    x = clamp01(x);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  /**
   * Nozzle feed profile: the fraction of the arc budget laid down by normalised
   * time `x`.
   *
   * Deliberately NOT an ease-in-out. An ease-in-out has no constant-rate
   * section, so the bead visibly slows through the middle of the mark — the one
   * place a real extruder holds a steady feed. This is a trapezoidal *velocity*
   * profile integrated in closed form: a smoothstep ramp up over `rin`, a
   * genuinely constant rate through the middle, a smoothstep ramp down over
   * `rout`. Each smoothstep ramp contributes half its width to the distance,
   * which is where the /2 terms come from.
   */
  function feed(x, rin, rout) {
    x = clamp01(x);
    var norm = 1 - rin / 2 - rout / 2;
    var p;
    if (x <= rin) {
      var t = rin > 0 ? x / rin : 1;
      p = rin * (t * t * t - (t * t * t * t) / 2);
    } else if (x <= 1 - rout) {
      p = rin / 2 + (x - rin);
    } else {
      var u = rout > 0 ? (x - (1 - rout)) / rout : 1;
      p = rin / 2 + (1 - rout - rin) + rout * (u - u * u * u + (u * u * u * u) / 2);
    }
    return clamp01(p / norm);
  }

  /** Inverse of `feed`, by bisection. Only the review readout calls this. */
  function feedInverse(target, rin, rout) {
    var lo = 0, hi = 1;
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      if (feed(mid, rin, rout) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * The three presets are one code path with three parameter sets. `forge` is
   * the hero; `glimmer` is the restrained one for people who find a build
   * animation twee; `extrude` is the sober one that never claims to be metal.
   *
   * `duration` is the animated run. Every preset also gets `OUT_MS` of exit on
   * top, so the ceiling to watch is duration + OUT_MS.
   */
  var OUT_MS = 180;

  var PRESETS = {
    forge: {
      label: 'forge',
      note: 'extrude · cure to metal · specular rake · settle',
      duration: 1560,
      phases: {
        fade: [0, 70],
        extrude: [70, 990],
        cure: [900, 1250],
        rake: [1080, 1480],
        settle: [1440, 1560],
      },
      feedIn: 0.1,
      feedOut: 0.16,
      heat: 1,
      metal: 1,
      /** One full turn of the key light, so it leaves where it arrived. */
      rakeTurns: 1,
      settleScale: 1.006,
    },
    glimmer: {
      label: 'glimmer',
      note: 'the mark is already there; the light does the work',
      duration: 880,
      phases: {
        fade: [0, 140],
        extrude: [0, 0], // already complete at t = 0
        cure: [0, 0],
        rake: [120, 700],
        settle: [680, 880],
      },
      feedIn: 0.1,
      feedOut: 0.16,
      heat: 0,
      metal: 1,
      rakeTurns: 1,
      settleScale: 1.004,
    },
    extrude: {
      label: 'extrude',
      note: 'the print reveal, flat brand navy, no metal',
      duration: 1080,
      phases: {
        fade: [0, 60],
        extrude: [60, 930],
        cure: [0, 0], // never cures: this preset is not pretending to be metal
        rake: [0, 0],
        settle: [930, 1080],
      },
      feedIn: 0.12,
      feedOut: 0.18,
      /** A live nozzle, not molten lava. Just enough to say the tip is working. */
      heat: 0.3,
      metal: 0,
      rakeTurns: 0,
      settleScale: 1.003,
    },
  };

  /** Key light at rest: upper-left, the angle every product shot uses. */
  var REST_ANGLE = -2.36;

  /**
   * The frame state at `t`. Pure: same `t`, same object, always.
   * Callers must not mutate the result.
   */
  function evaluate(preset, t) {
    var P = PRESETS[preset];
    var ph = P.phases;

    var extrudeX = span(t, ph.extrude[0], ph.extrude[1]);
    // A zero-length extrude phase means "already built" (glimmer), which `span`
    // already returns as 1 — but only for t >= b, and t = 0 must count too.
    if (ph.extrude[1] <= ph.extrude[0]) extrudeX = 1;
    var head = feed(extrudeX, P.feedIn, P.feedOut) * GEOM.budget;

    // A preset with no cure phase is already at its final material: `glimmer`
    // opens on polished metal, `extrude` never becomes metal at all.
    var cure = ph.cure[1] > ph.cure[0]
      ? easeOutCubic(span(t, ph.cure[0], ph.cure[1])) * P.metal
      : P.metal;

    var rakeX = ph.rake[1] > ph.rake[0] ? span(t, ph.rake[0], ph.rake[1]) : 0;
    var rakeEased = easeInOutCubic(rakeX);
    var lightAngle = REST_ANGLE + rakeEased * P.rakeTurns * Math.PI * 2;
    // Dropping the light's elevation mid-sweep grazes the bead, which lengthens
    // the anisotropic streak exactly when the eye is following it.
    var graze = Math.sin(Math.PI * rakeX);

    var settleX = ph.settle[1] > ph.settle[0] ? span(t, ph.settle[0], ph.settle[1]) : 1;
    var scale = 1 + (P.settleScale - 1) * (1 - easeOutQuint(settleX));

    // Heat is measured as how much arc the head has travelled since this point
    // was laid — which stops advancing the moment the head stops, leaving the
    // final centimetre of bead glowing forever. It was doing exactly that: at
    // t = 1560 the end of the bowl was still molten orange. So once the head
    // parks, keep ageing the whole trail at the rate it was last travelling.
    // Still a pure function of t; it just has two regimes.
    var extrudeMs = ph.extrude[1] - ph.extrude[0];
    var feedRate = extrudeMs > 0 ? GEOM.budget / extrudeMs : 0;
    var ageBias = Math.max(0, t - ph.extrude[1]) * feedRate;

    return {
      t: t,
      head: head,
      headFrac: head / GEOM.budget,
      cure: cure,
      lightAngle: lightAngle,
      graze: graze,
      heat: P.heat,
      ageBias: ageBias,
      opacity: smoothstep(span(t, ph.fade[0], ph.fade[1])),
      scale: scale,
      phase:
        t < ph.fade[1] ? 'fade'
          : extrudeX < 1 ? 'extrude'
            : rakeX > 0 && rakeX < 1 ? 'rake'
              : cure > 0 && cure < 1 ? 'cure'
                : settleX < 1 ? 'settle' : 'hold',
    };
  }

  /** Timing landmarks, derived from the geometry rather than written down. */
  function describe(preset) {
    var P = PRESETS[hasPreset(preset) ? preset : 'forge'];
    var e0 = P.phases.extrude[0], e1 = P.phases.extrude[1], dur = e1 - e0;
    function at(frac) {
      return dur <= 0 ? 0 : e0 + feedInverse(frac, P.feedIn, P.feedOut) * dur;
    }
    return {
      name: preset,
      label: P.label,
      note: P.note,
      duration: P.duration,
      out: OUT_MS,
      total: P.duration + OUT_MS,
      phases: P.phases,
      marks: dur <= 0 ? [] : [
        { id: 'split', t: at(GEOM.handoffFracOfBudget), label: 'bowl starts' },
        { id: 'outer', t: at(GEOM.outerCloseFrac), label: 'outer closes' },
        { id: 'bowl', t: e1, label: 'bowl closes' },
      ],
      /** The boot screen's landmarks on the same clock. See §8b. */
      chrome: chromeClock(P.duration),
      tipMs: CH.tipMs,
      geometry: GEOM.diagnostics,
    };
  }

  /* ================================================================
     5. MATERIAL — tuned per theme, because one tuning cannot serve both
     ================================================================ */

  function hex(h) {
    var v = parseInt(h.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  function mul(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }

  /**
   * Two materials, not one with a flipped background.
   *
   * A highlight tuned on near-black vanishes on near-white, and the reason is
   * that the two themes have their contrast headroom in opposite places. On the
   * light paper the body is dark navy, so there is a full stop of headroom above
   * it and the specular can be hot; but the SILHOUETTE is at risk, because a
   * bright fresnel rim dissolves the mark's outline into the paper. On the dark
   * paper the body has to be light enough to read, which spends most of the
   * headroom before the specular gets any — and there the rim is what saves the
   * form, because a bright edge against near-black draws the shape.
   *
   * So the fresnel term is INVERTED between the two: dark rim on light paper,
   * bright rim on dark paper. That single decision is what makes the same shader
   * look like the same metal on both grounds.
   *
   * Accent values come from `src/brand.ts` (light #231c50, dark #9b93d4). The
   * dark base is that accent scaled down to 0.60, because the env and sheen
   * terms add roughly 0.4 back — the LIT result lands on the brand value, which
   * is where the brand value belongs. Using #9b93d4 as the unlit base instead
   * left nowhere for a highlight to go and the mark read as flat lilac.
   */
  var THEMES = {
    light: {
      paper: '#fbfaf7',
      accent: '#231c50',
      base: hex('#231c50'),
      // Amber rather than the near-white heat the dark theme uses. On white
      // paper a pale hot colour has nothing to be brighter THAN, so it just
      // desaturates the navy — the first pass turned a third of the mark tan.
      hot: hex('#f0b06a'),
      specTint: hex('#fff8ee'),
      // Dark rim: on white paper the edges of a polished dark object are the
      // darkest part of it, because they reflect the shadow it sits in.
      fresTint: hex('#0a0718'),
      // The environment stops are NAVY, not room-coloured. A metal tints its
      // own reflections by its base colour, and skipping that step is what
      // washed the first pass out to a pale lilac rope — around 3:1 on the
      // paper when the brand navy is 14.87:1. The mark has to still read as
      // PlaSpool's navy, so the sky it reflects is a navy sky.
      sky: hex('#5f5793'),
      ground: hex('#150f33'),
      specPow: 150,
      specAmp: 1.05,
      sheenAmp: 0.16,
      anisoPow: 44,
      // Raised to compensate for the new ndh² shoulder on the aniso term.
      anisoAmp: 0.62,
      // A wide, dark grazing band. rimPow 3.4 puts the half-value point around
      // |across| 0.81 — roughly 5px in from the edge of a 26px half-width,
      // which is a band you can actually see.
      rimPow: 3.4,
      fresAmp: 0.46,
      envAmp: 0.45,
      // The knee starts high on light: the body is dark navy, so almost
      // nothing but the specular core ever reaches it.
      knee: 0.78,
      // Molten: warm and wet, no polish.
      wetTint: hex('#ffd9a8'),
      wetAmp: 0.30,
      ao: 0.34,
      weldRadius: 74,
      // A tighter horizon than dark: the light room's reflection is the main
      // thing modelling the bead here, so its edge has to be crisp to read.
      horizon: 0.07,
      grainAmp: 0.16,
      bulge: 1.05,
      bank: 0.22,
      matteShade: 0.07,
      lightZ: 0.62,
      grazeZ: 0.26,
      // Additive halo on near-white paper just clips to white and reads as a
      // smudge, so on light the heat is carried almost entirely INSIDE the bead
      // — where warm-on-navy is strongly visible — and the halo is a whisper.
      glowAmp: 0.55,
      glowSpread: 3.8,
      // Arc units over which the bead cools to 1/e. At the forge feed rate
      // (2.06 u/ms) this is a trail about 45ms long — a nozzle that has just
      // passed, not a river of lava. 150 read as a lava flow.
      heatLen: 92,
      svgSheen: '#b9b1e4',
      /**
       * The boot-screen chrome's palette. Surfaces and the ink ramp are lifted
       * from `src/styles/tokens.css` rather than invented, so the splash and
       * the app it covers are the same paper; the accent is the brand's, from
       * `src/brand.ts`.
       *
       * Measured on this card (#f0eee7, the gradient's darker end, which is
       * the worst case): body ink 10.2:1, accent 13.5:1, title 17:1. The card
       * has to be legible first and decorative second, so the sheen never
       * touches those values — it is a gradient over the top at low alpha, and
       * at its peak it LIFTS the ground, which only widens the ratio.
       */
      ui: {
        paper: '#fbfaf7',
        ink: '#16150f',
        ink2: '#3a372d',
        ink3: '#5c584a',
        accent: '#231c50',
        cardA: '#fefdfb',
        cardB: '#f0eee7',
        edge: '#e2ded2',
        lip: 'rgba(255,255,255,0.92)',
        grain: 'rgba(22,21,15,0.028)',
        // 0.72, not 0.95. At full white the peak stopped being a sheen on
        // paper-coloured metal and became a lit rectangle sitting on the card
        // — it read louder than the mark, which is the one thing the panel is
        // not allowed to do.
        sheen1: 'rgba(255,255,255,0.72)',
        // The flanks DARKEN. A band that only brightens reads as a glow; a
        // band flanked by relative shadow reads as a light crossing a solid.
        sheen2: 'rgba(35,28,80,0.05)',
        shadow: '0 1px 2px rgba(22,21,15,0.05),0 14px 34px -18px rgba(22,21,15,0.24)',
        rail: 'rgba(35,28,80,0.13)',
      },
    },
    dark: {
      paper: '#14140f',
      accent: '#9b93d4',
      // 0.48 of the brand accent, not the accent itself. The env and sheen add
      // roughly half of it back, so the LIT bead lands on the brand value —
      // which is where a brand value belongs. Using #9b93d4 as the unlit base
      // left no headroom above it and the mark read as one flat lilac tube.
      base: mul(hex('#9b93d4'), 0.48),
      hot: hex('#ffcf94'),
      specTint: hex('#fffdf8'),
      // Bright rim: on near-black the edge is the only thing separating the
      // form from the ground. This is the exact inverse of the light theme,
      // and it is the single decision that lets one shader read as one metal
      // on two opposite grounds.
      fresTint: hex('#d7d1f6'),
      sky: hex('#6d67a4'),
      ground: hex('#08070c'),
      // Tighter core than light — the body is already bright, so the light
      // theme's specular amplitude blooms the whole mark to white here.
      specPow: 195,
      // 0.42, down from 0.95. Measured at 900x900, glimmer/dark, t=320, in the
      // pixel column at 0.55*W: the old value produced 13 consecutive pure
      // (255,255,255) samples starting at the FIRST surface pixel — an
      // unshaded white band running into the silhouette, with no core and no
      // falloff. The knee bounds it now, but a term that needs the knee to
      // stay in range is over-driven, so the amplitude comes down as well:
      // reduce the drive, don't just compress the result.
      specAmp: 0.42,
      sheenAmp: 0.16,
      anisoPow: 56,
      anisoAmp: 0.60,
      // A bright, narrower rim than light's dark one — on near-black the edge
      // is what draws the form, but it must not swallow the whole bead.
      rimPow: 4.2,
      fresAmp: 0.44,
      envAmp: 0.5,
      // Lower knee than light: the body already sits high, so the roll-off has
      // to start earlier or the sum lands in the compressed region anyway.
      knee: 0.62,
      wetTint: hex('#ffd2a0'),
      wetAmp: 0.34,
      ao: 0.44,
      weldRadius: 74,
      // Softer than light: a dark room has a diffuse horizon, and a hard
      // reflection edge against near-black reads as a banding artefact.
      horizon: 0.11,
      grainAmp: 0.2,
      bulge: 1.02,
      bank: 0.22,
      matteShade: 0.1,
      lightZ: 0.55,
      grazeZ: 0.22,
      glowAmp: 2.1,
      glowSpread: 4.2,
      // Only a shade longer than light. The additive halo carries most of the
      // heat on a dark ground, so the in-bead trail can stay short; at 112 the
      // two stacked and a third of the mark went tan.
      heatLen: 95,
      svgSheen: '#efeaff',
      /**
       * Same sources as light: surfaces and ink from `tokens.css`'s dark
       * block, accent from `brand.ts`. Measured on the card's darker end
       * (#181812): body ink 12.5:1, accent 6.3:1, title 15:1.
       *
       * The sheen is a THIRD of light's alpha. On near-black a bright band at
       * light's strength stops being a sheen and becomes a light source, and
       * the card starts competing with the mark — which is the one thing the
       * brief says it must not do.
       */
      ui: {
        paper: '#14140f',
        ink: '#f4f1e6',
        ink2: '#ddd8c8',
        ink3: '#b3ad9b',
        accent: '#9b93d4',
        cardA: '#20201a',
        cardB: '#181812',
        edge: '#33322a',
        lip: 'rgba(215,209,246,0.10)',
        grain: 'rgba(244,241,230,0.022)',
        sheen1: 'rgba(226,221,255,0.16)',
        sheen2: 'rgba(0,0,0,0.10)',
        shadow: '0 1px 2px rgba(0,0,0,0.4),0 16px 38px -20px rgba(0,0,0,0.7)',
        rail: 'rgba(155,147,212,0.17)',
      },
    },
  };

  /* ================================================================
     6. SHADERS
     ================================================================ */

  var VERT = [
    'precision highp float;',
    'attribute vec2 aPos;',
    'attribute vec2 aNrm;',
    'attribute vec2 aTan;',
    'attribute float aAcross;',
    'attribute float aArc;',
    'attribute float aCurv;',
    'uniform vec2 uScale;',
    'uniform vec2 uOffset;',
    'uniform vec2 uCenter;',
    'uniform float uHalfW;',
    'uniform float uAcrossScale;',
    'uniform float uMarkScale;',
    'uniform float uArcOffset;',
    'varying float vArc;',
    'varying float vAcross;',
    'varying vec2 vTan;',
    'varying vec2 vNrm;',
    'varying float vCurv;',
    'varying vec2 vPos;',
    'void main() {',
    '  vec2 p = aPos + aNrm * (aAcross * uHalfW);',
    '  p = uCenter + (p - uCenter) * uMarkScale;',
    // Mark-space position, so the fragment stage can shade the weld from
    // geometry both ribbons agree on rather than from per-ribbon attributes.
    '  vPos = p;',
    // Depth carries the bead's height so overlapping beads resolve by which one
    // is taller. Negative z is nearer under the default LEQUAL depth test.
    '  float at = clamp(aAcross * uAcrossScale, -1.0, 1.0);',
    '  float h = sqrt(max(0.0, 1.0 - at * at));',
    '  vArc = aArc + uArcOffset;',
    '  vAcross = aAcross;',
    '  vTan = aTan;',
    '  vNrm = aNrm;',
    '  vCurv = aCurv;',
    '  gl_Position = vec4(p * uScale + uOffset, -h * 0.85, 1.0);',
    '}',
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    'varying float vArc;',
    'varying float vAcross;',
    'varying vec2 vTan;',
    'varying vec2 vNrm;',
    'varying float vCurv;',
    'uniform float uHead, uEdgeSoft, uHeatLen, uHeatAmp, uAgeBias;',
    'uniform float uHalfW, uPxUnit, uAcrossScale;',
    'uniform vec3 uBase, uSpecTint, uFresTint, uSky, uGround, uHot;',
    'uniform float uSpecPow, uSpecAmp, uSheenAmp, uAnisoPow, uAnisoAmp;',
    'uniform float uFresAmp, uEnvAmp, uGrainAmp, uHorizon, uRimPow;',
    'uniform vec3 uLight, uWetTint;',
    'uniform float uCure, uBulge, uBank, uMatteShade, uAlpha;',
    'uniform float uWetAmp, uKnee, uAo;',
    'uniform vec3 uWeld;',      // xy = tangency in mark space, z = blend radius
    'varying vec2 vPos;',

    // A 1D hash rather than a texture: this file has to run from file:// with no
    // fetch, and the grain only needs to be stable, not statistically pretty.
    'float hash11(float p) {',
    '  p = fract(p * 0.1031);',
    '  p *= p + 33.33;',
    '  p *= p + p;',
    '  return fract(p);',
    '}',

    // Soft knee. Below `k` this is the identity; above it, an exponential roll
    // that approaches 1 without ever reaching it, so the result is STRICTLY
    // monotonic and can never form a flat plateau.
    //
    // Two bugs died here. The dark theme's specular clipped to a pure-white
    // band 13 pixels wide that ran straight into the silhouette — no core, no
    // falloff, the edge of the form dissolved. And because the three channels
    // clipped at different inputs (blue first, it being the largest in a navy),
    // the shoulder passed through a saturated violet on its way to white.
    // Compressing per channel fixes both: the largest channel compresses most,
    // so the hue walks toward the light colour monotonically.
    'float knee(float x) {',
    '  float k = uKnee;',
    '  float over = max(x - k, 0.0);',
    '  return min(x, k) + (1.0 - k) * (1.0 - exp(-over / max(1.0 - k, 1e-4)));',
    '}',
    'vec3 knee3(vec3 c) { return vec3(knee(c.r), knee(c.g), knee(c.b)); }',

    'void main() {',
    '  if (vArc > uHead) discard;',

    // The geometry is built a little wider than the real bead so the edge can be
    // resolved analytically instead of by MSAA; uAcrossScale maps the padded
    // coordinate back onto the true −1..1 of the bead's cross-section.
    '  float a = clamp(vAcross * uAcrossScale, -1.0, 1.0);',

    // THE WELD. The two loops are TANGENT, not crossing — the trace found their
    // centrelines collinear along x~406 for y 646-666, and the deposited beads
    // touch a full 28ms of head travel before the formal handoff. They are one
    // fused lump of plastic, so depth arbitration was the wrong model: it drew
    // them as two stacked decals meeting along a razor-straight diagonal with a
    // visible value step and no contact shading at all.
    //
    // Inside this radius the shading stops depending on WHICH ribbon is being
    // drawn — the cross-section flattens, the frame rotates toward straight up,
    // and the anisotropy (the only strongly tangent-dependent term, and the one
    // that produced a hard white starburst where curvature spiked) fades out.
    // Both ribbons then compute nearly the same colour there, so the depth
    // boundary has nothing left to reveal.
    '  float weldD = distance(vPos, uWeld.xy) / max(uWeld.z, 1.0);',
    '  float weld = 1.0 - smoothstep(0.0, 1.0, clamp(weldD, 0.0, 1.0));',

    // Flatten the cross-section through the weld: two fused beads make one wide
    // low ridge, not two half-cylinders.
    '  float aEff = a * mix(1.0, 0.45, weld);',
    '  float h = sqrt(max(0.0, 1.0 - aEff * aEff));',

    // THE NORMAL. This is the whole reason for the WebGL path: treat the stroke
    // as a half-round bead lying on the bed, so the surface actually curves and
    // the highlight has somewhere to travel. `bank` tips the normal slightly
    // along the tangent where the path bends — not strictly what a swept tube
    // does, but it is what a bead laid down through a turn looks like.
    //
    // The bank term is CLAMPED. Curvature is estimated from the discrete turn
    // over the mean neighbouring segment length, so a short segment at a tight
    // bend sends it to infinity; unclamped, that swung the normal hard enough
    // to make the specular go singular and radiate spokes at the junction.
    '  vec3 T = normalize(vec3(vTan, 0.0));',
    '  vec3 B = normalize(vec3(vNrm, 0.0));',
    '  vec3 Z = vec3(0.0, 0.0, 1.0);',
    '  float bank = clamp(vCurv * 26.0, -1.2, 1.2) * aEff * uBank;',
    '  vec3 n = normalize(B * (aEff * uBulge) + Z * h + T * bank);',
    '  n = normalize(mix(n, Z, weld * 0.6));',

    '  vec3 L = normalize(uLight);',
    '  vec3 V = Z;',
    '  vec3 H = normalize(L + V);',
    '  float ndl = max(dot(n, L), 0.0);',
    '  float ndv = max(dot(n, V), 0.0);',
    '  float ndh = max(dot(n, H), 0.0);',

    '  float spec = pow(ndh, uSpecPow);',
    '  float sheen = pow(ndh, max(uSpecPow * 0.06, 1.0));',

    // Kajiya-Kay: the highlight of a fibre elongates PERPENDICULAR to the fibre
    // axis in angle space, which on screen means it smears ALONG the extrusion.
    // Anisotropy that does not follow the extrusion direction is just a blurry
    // specular and gives the game away immediately.
    '  float tdh = dot(T, H);',
    '  float aniso = pow(sqrt(max(0.0, 1.0 - tdh * tdh)), uAnisoPow);',
    // Give the streak a cross-sectional shoulder. On its own the Kajiya-Kay
    // term depends only on T and H, so it painted a band of CONSTANT value all
    // the way across the bead — which is why the outer 45% of the falloff
    // measured as noise around a constant with no downward trend.
    '  aniso *= ndh * ndh;',
    '  aniso *= 1.0 - weld * 0.85;',

    // Brush grain varies across the bead and holds along the arc, so the
    // streaks run with the extrusion. Value noise with a smoothstep blend
    // between samples, NOT floor() of a scaled coordinate: quantising `across`
    // into 37 hard steps terraced the specular falloff into visible concentric
    // arcs.
    '  float ga = a * 96.0;',
    '  float gi = floor(ga);',
    '  float gf = fract(ga);',
    '  gf = gf * gf * (3.0 - 2.0 * gf);',
    '  float grainN = mix(hash11(gi + 0.5), hash11(gi + 1.5), gf);',
    '  float grain = 1.0 + (grainN - 0.5) * uGrainAmp',
    '                    + sin(vArc * 0.085) * uGrainAmp * 0.2;',

    // The grazing band, driven from |across| rather than from (1-ndv)^5.
    // Orthographic view means ndv IS the bead height, so the physical fresnel
    // only lifted the outermost 0.5% of the half-width — about 0.12px on a
    // 52px stroke, which the 1.1px alpha feather then ate whole. Measured on
    // the light theme it was completely absent: eight surface pixels at a flat
    // 65 and nine at a flat 37. |across| is a monotonic proxy for the grazing
    // angle on a half-round section, and it can be given a width you can see.
    '  float fres = pow(abs(a), uRimPow);',

    // Procedural environment, sampled by the reflected view vector. Two stops,
    // but NOT a smooth ramp between them: a polished surface reflects a
    // HORIZON, and that hard sky/ground boundary sweeping around the bead is
    // the single strongest cue separating metal from glossy plastic. The first
    // version ramped smoothly and the mark read as a lacquered rope.
    '  vec3 r = reflect(-V, n);',
    '  float envT = clamp(r.y * -0.5 + 0.5, 0.0, 1.0);',
    '  float horizon = smoothstep(0.5 - uHorizon, 0.5 + uHorizon, envT);',
    '  vec3 env = mix(uGround, uSky, mix(envT, horizon, 0.78));',

    // Metals have essentially no diffuse lobe; their colour arrives through the
    // tinted reflection. The base term is kept only wide enough to hold the
    // brand navy at readable contrast on paper — leaning on it any harder is
    // what makes a "metal" shader look like painted plastic.
    '  vec3 metal = uBase * (0.70 + 0.30 * ndl)',
    '             + env * uEnvAmp',
    '             + uSpecTint * (spec * uSpecAmp)',
    '             + uSpecTint * (sheen * uSheenAmp)',
    '             + uSpecTint * (aniso * uAnisoAmp * grain);',

    // THE PRE-CURE MATERIAL. Molten plastic is not "the finished thing, dimmer"
    // — it is its own material, and forge spent its first ~700ms with none at
    // all: a flat navy band with no cross-section, so the extrusion read as a
    // 2D stroke being drawn until the cure arrived and a bead appeared. It has
    // to be a bead from the first frame, so the cure is a change OF material
    // rather than the arrival of one.
    //
    // Wrap lighting for the soft, slightly translucent falloff of hot plastic,
    // a broad low sheen for the wet look, and a fraction of the environment so
    // the crown still picks something up. Deliberately no hard specular: a
    // molten bead has no polish yet, and that absence is what the cure buys.
    '  float wrap = ndl * 0.5 + 0.5;',
    '  float wet = pow(ndh, 5.0) * uWetAmp;',
    '  vec3 molten = uBase * (0.46 + 0.54 * wrap * (1.0 - uMatteShade * 0.0))',
    '              + uWetTint * wet',
    '              + env * (uEnvAmp * 0.22)',
    '              + uBase * (uMatteShade * ndl);',

    '  vec3 col = mix(molten, metal, uCure);',

    // The grazing band LERPS toward the rim colour; it does not add it. Adding
    // was the reason the light theme had no measurable rim at all: its rim
    // colour is near-black (#0a0718), and adding near-black to anything is
    // arithmetically almost nothing. Light needs the edge to go DARKER than the
    // body and dark needs it to go brighter, and only a mix can do both from
    // one expression. Slightly gentler before the cure — molten plastic has a
    // softer edge than polished metal.
    '  col = mix(col, uFresTint, clamp(fres * uFresAmp * mix(0.55, 1.0, uCure), 0.0, 1.0));',

    // Contact shading at the weld. Two fused beads leave a valley where they
    // meet; without it the junction read as two flat decals laid over each
    // other. Driven by position and |across| only — never by which ribbon is
    // being drawn — so BOTH sides darken identically and the depth boundary
    // stays invisible.
    '  col *= 1.0 - uAo * weld * (0.28 + 0.72 * abs(a));',

    // Heat is a function of how long ago this point was laid, not of global
    // time, so the trail cools continuously behind a moving head instead of the
    // whole mark brightening and dimming together.
    '  float age = max(uHead - vArc, 0.0) + uAgeBias;',
    '  float heat = exp(-age / uHeatLen) * uHeatAmp;',
    '  col = mix(col, uHot, clamp(heat, 0.0, 1.0));',

    // Everything above sums freely; this is the only place values are bounded,
    // and it bounds them smoothly. See knee().
    '  col = knee3(max(col, 0.0));',

    '  float edgePx = (1.0 - abs(a)) * uHalfW * uPxUnit / max(uAcrossScale, 1.0);',
    '  float sideA = clamp(edgePx / 1.1, 0.0, 1.0);',
    // Inside the weld the two beads are one lump of plastic and the silhouettes
    // BETWEEN them are not real edges. Feathering both of them meant two ~50%
    // rims over-blending to ~75% at the cusp where they converge, so the paper
    // showed through the middle of the mark as a bright wedge. Measured against
    // a Canvas2D stroke of the same paths, that cusp was the only place the
    // render disagreed with the geometry.
    '  sideA = mix(sideA, 1.0, weld * 0.85);',
    '  float leadA = clamp(age / uEdgeSoft, 0.0, 1.0);',
    '  float alpha = sideA * leadA * uAlpha;',
    '  gl_FragColor = vec4(col * alpha, alpha);',
    '}',
  ].join('\n');

  /** Additive halo around the hot tip. Same mesh, wider, drawn first. */
  var GLOW_FRAG = [
    'precision highp float;',
    'varying float vArc;',
    'varying float vAcross;',
    'varying vec2 vTan;',
    'varying vec2 vNrm;',
    'varying float vCurv;',
    'uniform float uHead, uEdgeSoft, uHeatLen, uHeatAmp, uAlpha, uAgeBias;',
    'uniform vec3 uHot;',
    'void main() {',
    '  if (vArc > uHead) discard;',
    '  float age = max(uHead - vArc, 0.0) + uAgeBias;',
    '  float heat = exp(-age / uHeatLen);',
    // The halo ribbon is three vertices wide, so `1 - |across|` interpolates as
    // a straight-sided tent and the halo showed its own polygon — a hard tan
    // arrowhead sitting on the nozzle. A 5th-power falloff pins the edge to
    // zero long before the geometry ends, which hides the silhouette; the
    // ribbon is correspondingly wider and dimmer so the visible part is all
    // interior.
    '  float radial = 1.0 - abs(vAcross);',
    '  radial = radial * radial; radial = radial * radial * (1.0 - abs(vAcross));',
    // The halo's leading edge needs a far longer ramp than the bead's. Sharing
    // the bead's 14-unit cut sliced the wide glow ribbon off square, and the
    // result read as a hard angular arrowhead sitting on the nozzle rather than
    // as light. Smoothstep, not a linear clamp, so there is no visible corner
    // where the ramp begins.
    '  float lead = smoothstep(0.0, uEdgeSoft * 7.0, age);',
    '  float k = radial * heat * uHeatAmp * lead * uAlpha;',
    // Additive: premultiplied colour with zero alpha, blended ONE / ONE.
    '  gl_FragColor = vec4(uHot * k, 0.0);',
    '}',
  ].join('\n');

  /* ================================================================
     7. WEBGL RENDERER
     ================================================================ */

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader: ' + log);
    }
    return sh;
  }

  function link(gl, vsSrc, fsSrc) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    // The shaders are owned by the program once attached; deleting the handles
    // now means `destroy()` only has to delete the program.
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('link: ' + log);
    }
    return p;
  }

  function uniforms(gl, prog, names) {
    var u = {};
    for (var i = 0; i < names.length; i++) u[names[i]] = gl.getUniformLocation(prog, names[i]);
    return u;
  }

  var U_MAIN = [
    'uScale', 'uOffset', 'uCenter', 'uHalfW', 'uAcrossScale', 'uMarkScale', 'uArcOffset',
    'uHead', 'uEdgeSoft', 'uHeatLen', 'uHeatAmp', 'uAgeBias', 'uPxUnit',
    'uBase', 'uSpecTint', 'uFresTint', 'uSky', 'uGround', 'uHot',
    'uSpecPow', 'uSpecAmp', 'uSheenAmp', 'uAnisoPow', 'uAnisoAmp',
    'uFresAmp', 'uEnvAmp', 'uGrainAmp', 'uHorizon', 'uLight', 'uRimPow',
    'uCure', 'uBulge', 'uBank', 'uMatteShade', 'uAlpha',
    'uWetTint', 'uWetAmp', 'uKnee', 'uAo', 'uWeld',
  ];
  var U_GLOW = [
    'uScale', 'uOffset', 'uCenter', 'uHalfW', 'uAcrossScale', 'uMarkScale', 'uArcOffset',
    'uHead', 'uEdgeSoft', 'uHeatLen', 'uHeatAmp', 'uAgeBias', 'uAlpha', 'uHot',
  ];

  function createGL(host, opts) {
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';

    var attrs = {
      alpha: true,
      depth: true,
      stencil: false,
      // The side edges are feathered analytically (see uAcrossScale), so MSAA
      // would only soften them a second time and cost fill rate for nothing.
      antialias: false,
      premultipliedAlpha: true,
      /* TRUE, and not as a debugging convenience — this is the fix for the
         "scroll it out of view and back and the stage is blank forever" bug.

         Without it the drawing buffer is emptied the instant the frame is
         composited. That is invisible while the timeline is running, because
         rAF refills it 60 times a second. It stops being invisible the moment
         the splash STOPS drawing — held at the end, paused on a scrub, or the
         single static frame reduced motion leaves up. From then on the mark on
         screen is only the compositor's cached texture, and the canvas itself
         holds nothing. Anything that makes the compositor re-raster that layer
         — scrolling it off-screen and back, a tab switch, a promotion change —
         re-samples the now-empty buffer, and the mark is gone for good, because
         nothing in here schedules another draw once the timeline is over.

         Measured, on a settled instance that still looked perfectly correct on
         screen: 0 lit pixels read back from its own drawing buffer, against 278
         immediately after a forced redraw. The surface was already blank; the
         screen just had not caught up yet.

         The cost is a buffer copy per composited frame, on a canvas that lives
         about two seconds. It lands in compositing, not in render(), so
         frameMs() cannot see it at all — measured end to end instead, the
         sequence still runs at 61fps (mean frame 16.5ms, p95 18.8ms) with the
         flag on. A splash nobody can see is worth a good deal less than one
         buffer copy per frame. */
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false,
    };
    var gl = null;
    try {
      gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    } catch (e) {
      gl = null;
    }
    if (!gl) return null;

    // A software rasteriser will happily hand back a context and then spend
    // 30ms a frame on it — during app boot, which is the one moment this must
    // not cost anything. The SVG path is genuinely better there, so check
    // before the first frame rather than swapping renderers mid-animation.
    // The extension is restricted in newer browsers; when it is absent the
    // generic RENDERER string tells us nothing and we proceed, which is right.
    try {
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      var rname = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      if (/swiftshader|llvmpipe|software|basic render/i.test(rname)) return null;
    } catch (e) { /* nothing to learn; carry on */ }

    var progMain, progGlow, meshes = [], vbos = [], ibos = [];
    try {
      progMain = link(gl, VERT, FRAG);
      progGlow = link(gl, VERT, GLOW_FRAG);
    } catch (e) {
      // A driver that reports a context but cannot compile a loop-free shader is
      // not a context we want to debug at boot. Fall through to SVG.
      if (typeof console !== 'undefined' && console.warn) console.warn('[splash]', e.message);
      return null;
    }

    var uMain = uniforms(gl, progMain, U_MAIN);
    var uGlow = uniforms(gl, progGlow, U_GLOW);

    var attribs = ['aPos', 'aNrm', 'aTan', 'aAcross', 'aArc', 'aCurv'];
    var locMain = {}, locGlow = {};
    attribs.forEach(function (a) {
      locMain[a] = gl.getAttribLocation(progMain, a);
      locGlow[a] = gl.getAttribLocation(progGlow, a);
    });

    // One mesh per loop; the arc offset that implements the handoff is a
    // uniform, so both loops share the same vertex layout and the same shader.
    var arcOffsets = [0, GEOM.handoffArc];
    GEOM.loops.forEach(function (loop) {
      var m = buildRibbon(loop);
      var vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.STATIC_DRAW);
      var ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.index, gl.STATIC_DRAW);
      meshes.push(m);
      vbos.push(vbo);
      ibos.push(ibo);
    });
    var idxType = meshes[0].index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    gl.disable(gl.CULL_FACE);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    var view = { w: 1, h: 1, fit: 1, pxUnit: 1, dpr: 1 };
    // A non-finite or non-positive zoom would push NaN through every vertex,
    // which WebGL renders as nothing at all rather than as an error.
    var zoom = Math.max(0.05, num(opts.zoom, 1.22));

    // pos.xy | nrm.xy | tan.xy | across | arc | curv  = 9 floats, stride 36.
    var LAYOUT = [
      ['aPos', 2, 0], ['aNrm', 2, 8], ['aTan', 2, 16],
      ['aAcross', 1, 24], ['aArc', 1, 28], ['aCurv', 1, 32],
    ];

    function bindMesh(loc, i) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbos[i]);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibos[i]);
      var st = meshes[i].stride;
      for (var a = 0; a < LAYOUT.length; a++) {
        var L = LAYOUT[a], at = loc[L[0]];
        // The glow shader never reads the tangent or the curvature, so the GLSL
        // compiler is entitled to eliminate those attributes and hand back -1.
        // Passing -1 to vertexAttribPointer raises INVALID_VALUE and, on some
        // drivers, poisons every draw call after it.
        if (at < 0) continue;
        gl.enableVertexAttribArray(at);
        gl.vertexAttribPointer(at, L[1], gl.FLOAT, false, st, L[2]);
      }
    }
    function unbindMesh(loc) {
      for (var a = 0; a < LAYOUT.length; a++) {
        var at = loc[LAYOUT[a][0]];
        if (at >= 0) gl.disableVertexAttribArray(at);
      }
    }

    function resize() {
      var rect = host.getBoundingClientRect();
      var cssW = Math.max(1, Math.round(rect.width));
      var cssH = Math.max(1, Math.round(rect.height));
      // Capped at 2: beyond that the fill cost doubles again for a bead whose
      // features are already sub-pixel, and this runs during app boot.
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      view.w = w; view.h = h; view.dpr = dpr;
      view.fit = Math.min(w, h) * zoom;
      view.pxUnit = view.fit / MARK.viewBox;
      gl.viewport(0, 0, w, h);
    }

    function setCommon(u, state, theme) {
      gl.uniform2f(u.uScale, (2 * view.fit) / MARK.viewBox / view.w, (-2 * view.fit) / MARK.viewBox / view.h);
      gl.uniform2f(u.uOffset, -(view.fit / view.w), view.fit / view.h);
      gl.uniform2f(u.uCenter, MARK.viewBox / 2, MARK.viewBox / 2);
      gl.uniform1f(u.uMarkScale, state.scale);
      gl.uniform1f(u.uHead, state.head);
      gl.uniform1f(u.uEdgeSoft, 14);
      gl.uniform1f(u.uHeatLen, theme.heatLen);
      gl.uniform1f(u.uAgeBias, state.ageBias);
      gl.uniform1f(u.uAlpha, state.opacity);
    }

    function render(state, theme) {
      // The mark is centred at (540, 540) in its own box, so the offset above
      // already centres it; no per-theme framing to get wrong.
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      // A masked depth buffer cannot be cleared. The glow pass leaves the mask
      // closed, so re-opening it here is not belt-and-braces — skip it and the
      // second frame onwards renders against stale depth.
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      var heatAmp = state.heat;
      var halfW = GEOM.halfWidth;
      // Pad the ribbon by ~1.2 device px so the analytic feather has room to
      // land on the true edge rather than inside it.
      var pad = view.pxUnit > 0 ? 1.2 / view.pxUnit : 1.5;
      var padHalf = halfW + pad;
      var acrossScale = padHalf / halfW;

      gl.enable(gl.BLEND);

      // --- glow pass: additive, no depth involvement at all.
      if (heatAmp > 0.001) {
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(progGlow);
        setCommon(uGlow, state, theme);
        gl.uniform1f(uGlow.uHalfW, halfW * theme.glowSpread);
        gl.uniform1f(uGlow.uAcrossScale, 1);
        gl.uniform1f(uGlow.uHeatAmp, heatAmp * theme.glowAmp);
        gl.uniform3fv(uGlow.uHot, theme.hot);
        for (var g = 0; g < meshes.length; g++) {
          gl.uniform1f(uGlow.uArcOffset, arcOffsets[g]);
          bindMesh(locGlow, g);
          gl.drawElements(gl.TRIANGLES, meshes[g].count, idxType, 0);
          unbindMesh(locGlow);
        }
      }

      // --- metal pass: depth-arbitrated so overlapping beads resolve by height.
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(progMain);
      setCommon(uMain, state, theme);
      gl.uniform1f(uMain.uHalfW, padHalf);
      gl.uniform1f(uMain.uAcrossScale, acrossScale);
      gl.uniform1f(uMain.uPxUnit, view.pxUnit);
      gl.uniform1f(uMain.uHeatAmp, heatAmp);
      gl.uniform3fv(uMain.uBase, theme.base);
      gl.uniform3fv(uMain.uSpecTint, theme.specTint);
      gl.uniform3fv(uMain.uFresTint, theme.fresTint);
      gl.uniform3fv(uMain.uSky, theme.sky);
      gl.uniform3fv(uMain.uGround, theme.ground);
      gl.uniform3fv(uMain.uHot, theme.hot);
      gl.uniform1f(uMain.uSpecPow, theme.specPow);
      gl.uniform1f(uMain.uSpecAmp, theme.specAmp);
      gl.uniform1f(uMain.uSheenAmp, theme.sheenAmp);
      gl.uniform1f(uMain.uAnisoPow, theme.anisoPow);
      gl.uniform1f(uMain.uAnisoAmp, theme.anisoAmp);
      gl.uniform1f(uMain.uFresAmp, theme.fresAmp);
      gl.uniform1f(uMain.uEnvAmp, theme.envAmp);
      gl.uniform1f(uMain.uGrainAmp, theme.grainAmp);
      gl.uniform1f(uMain.uHorizon, theme.horizon);
      gl.uniform1f(uMain.uRimPow, theme.rimPow);
      gl.uniform3fv(uMain.uWetTint, theme.wetTint);
      gl.uniform1f(uMain.uWetAmp, theme.wetAmp);
      gl.uniform1f(uMain.uKnee, theme.knee);
      gl.uniform1f(uMain.uAo, theme.ao);
      // The weld radius is a little over one stroke width, which is the scale
      // on which two 52px beads 16.7px apart actually merge.
      gl.uniform3f(uMain.uWeld, MARK.tangency[0], MARK.tangency[1], theme.weldRadius);
      gl.uniform1f(uMain.uCure, state.cure);
      gl.uniform1f(uMain.uBulge, theme.bulge);
      gl.uniform1f(uMain.uBank, theme.bank);
      gl.uniform1f(uMain.uMatteShade, theme.matteShade);
      var lz = theme.lightZ - (theme.lightZ - theme.grazeZ) * state.graze;
      gl.uniform3f(uMain.uLight, Math.cos(state.lightAngle), Math.sin(state.lightAngle), lz);
      for (var m = 0; m < meshes.length; m++) {
        gl.uniform1f(uMain.uArcOffset, arcOffsets[m]);
        bindMesh(locMain, m);
        gl.drawElements(gl.TRIANGLES, meshes[m].count, idxType, 0);
        unbindMesh(locMain);
      }
      gl.disable(gl.DEPTH_TEST);
    }

    var hashBuf = null;
    function readHash() {
      var w = view.w, h = view.h;
      var need = w * h * 4;
      if (!hashBuf || hashBuf.length !== need) hashBuf = new Uint8Array(need);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, hashBuf);
      // FNV-1a over a strided sample. The stride is prime so it does not
      // resonate with the ribbon's own periodicity.
      var hsh = 0x811c9dc5;
      for (var i = 0; i < need; i += 61) {
        hsh ^= hashBuf[i];
        hsh = (hsh * 0x01000193) >>> 0;
      }
      return hsh >>> 0;
    }

    /**
     * How many sampled pixels are actually lit RIGHT NOW, without redrawing
     * first. The "without redrawing" is the entire point: this is the probe
     * that would have caught the blank-after-recomposite bug, and every
     * existing readout missed it precisely because they all either redraw
     * first (frameHash) or never look at the surface at all (renderer, kind).
     *
     * Strided by a prime for the same reason as readHash — a stride that
     * resonated with the ribbon's periodicity could sample only background.
     */
    function litCount() {
      var w = view.w, h = view.h;
      var need = w * h * 4;
      if (!hashBuf || hashBuf.length !== need) hashBuf = new Uint8Array(need);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, hashBuf);
      var n = 0;
      for (var i = 3; i < need; i += 4 * 97) if (hashBuf[i] > 8) n++;
      return n;
    }

    function destroy() {
      for (var i = 0; i < vbos.length; i++) {
        gl.deleteBuffer(vbos[i]);
        gl.deleteBuffer(ibos[i]);
      }
      gl.deleteProgram(progMain);
      gl.deleteProgram(progGlow);
      // Contexts are a scarce global resource — browsers cap them at ~16 and
      // silently kill the OLDEST when you exceed it, which shows up as an
      // unrelated canvas elsewhere in the app going blank. Mounting and
      // unmounting a splash 20 times must not spend that budget.
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      hashBuf = null;
    }

    return {
      kind: 'webgl',
      canvas: canvas,
      gl: gl,
      resize: resize,
      render: render,
      readHash: readHash,
      litCount: litCount,
      destroy: destroy,
    };
  }

  /* ================================================================
     8. SVG FALLBACK
     ================================================================ */

  /**
   * No WebGL, or a context that died mid-run. The fallback is deliberately NOT a
   * degraded copy of the metal — an approximation of a specular highlight
   * without a normal is exactly the grey-gradient-on-a-silhouette look this
   * whole file exists to avoid, and it would look broken next to the real thing.
   *
   * So it does one thing well instead: the same draw-on, in flat brand navy,
   * with a single soft sheen wiping across at the end. Quieter, obviously
   * deliberate, and driven by the same timeline — so it seeks and scrubs too.
   */
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function createSVG(host, opts) {
    var uid = 'plsp' + Math.random().toString(36).slice(2, 8);
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1080 1080');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.cssText = 'display:block;width:100%;height:100%;overflow:visible;';

    var defs = document.createElementNS(SVG_NS, 'defs');
    var grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', uid + '-sheen');
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('y1', '0');
    grad.setAttribute('y2', '1080');
    var stops = [];
    [
      ['0%', 0],
      ['38%', 0],
      ['50%', 1],
      ['62%', 0],
      ['100%', 0],
    ].forEach(function (s) {
      var st = document.createElementNS(SVG_NS, 'stop');
      st.setAttribute('offset', s[0]);
      st.setAttribute('stop-opacity', String(s[1]));
      stops.push(st);
      grad.appendChild(st);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);

    // A non-finite or non-positive zoom would push NaN through every vertex,
    // which WebGL renders as nothing at all rather than as an error.
    var zoom = Math.max(0.05, num(opts.zoom, 1.22));
    var g = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(g);

    function makeGroup(stroke, extra) {
      var grp = document.createElementNS(SVG_NS, 'g');
      grp.setAttribute('fill', 'none');
      grp.setAttribute('stroke', stroke);
      grp.setAttribute('stroke-width', String(MARK.strokeWidth));
      grp.setAttribute('stroke-linecap', 'round');
      grp.setAttribute('stroke-linejoin', 'round');
      if (extra) for (var k in extra) grp.setAttribute(k, extra[k]);
      var paths = MARK.loops.map(function (loop) {
        var p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', loop.d);
        grp.appendChild(p);
        return p;
      });
      g.appendChild(grp);
      return { group: grp, paths: paths };
    }

    var body = makeGroup('#231c50');
    var sheen = makeGroup('url(#' + uid + '-sheen)', { 'stroke-width': String(MARK.strokeWidth) });

    // Dash lengths come from the same measured polylines the WebGL path uses,
    // not from getTotalLength(), so the two renderers agree on where the head is
    // to within the flattening tolerance.
    var lens = [GEOM.outer.total, GEOM.bowl.total];
    var arcOffsets = [0, GEOM.handoffArc];
    [body, sheen].forEach(function (grp) {
      grp.paths.forEach(function (p, i) {
        p.setAttribute('stroke-dasharray', lens[i] + ' ' + (lens[i] + 2));
      });
    });

    function resize() { /* SVG scales itself; nothing to recompute. */ }

    function render(state, th) {
      body.group.setAttribute('stroke', th.accent);
      var k = MARK.viewBox / 2;
      g.setAttribute('transform', 'translate(' + k + ' ' + k + ') scale(' + (zoom * state.scale) + ') translate(' + -k + ' ' + -k + ')');
      svg.style.opacity = String(state.opacity);

      for (var i = 0; i < 2; i++) {
        var drawn = Math.max(0, Math.min(lens[i], state.head - arcOffsets[i]));
        var off = lens[i] - drawn;
        body.paths[i].setAttribute('stroke-dashoffset', String(off));
        sheen.paths[i].setAttribute('stroke-dashoffset', String(off));
      }

      // The sheen is a band travelling down the mark, revealed only during the
      // rake. One pass, no loop: a repeating shimmer on a boot screen is a tic.
      var rake = state.graze;
      sheen.group.setAttribute('stroke', 'url(#' + uid + '-sheen)');
      sheen.group.setAttribute('opacity', String(0.85 * rake * state.cure));
      var travel = (state.lightAngle - REST_ANGLE) / (Math.PI * 2);
      var y = -400 + travel * 1900;
      grad.setAttribute('x1', '0');
      grad.setAttribute('x2', '0');
      grad.setAttribute('y1', String(y));
      grad.setAttribute('y2', String(y + 900));
      stops.forEach(function (st) { st.setAttribute('stop-color', th.svgSheen); });
    }

    function readHash() {
      // No pixels to read. Hashing the attributes that actually drive the frame
      // proves the same property the WebGL hash proves — that seek(t) puts the
      // renderer in one and only one state — without pretending to be a
      // framebuffer read.
      var parts = [
        svg.style.opacity,
        g.getAttribute('transform'),
        sheen.group.getAttribute('opacity'),
        grad.getAttribute('y1'),
        body.group.getAttribute('stroke'),
      ];
      for (var i = 0; i < 2; i++) parts.push(body.paths[i].getAttribute('stroke-dashoffset'));
      var str = parts.join('|');
      var hsh = 0x811c9dc5;
      for (var c = 0; c < str.length; c++) {
        hsh ^= str.charCodeAt(c);
        hsh = (hsh * 0x01000193) >>> 0;
      }
      return hsh >>> 0;
    }

    function destroy() {
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    }

    /**
     * The SVG fallback is retained-mode: the browser owns the raster and
     * re-paints it from the DOM whenever it needs to, so it has no volatile
     * drawing buffer to lose and cannot exhibit the blank-after-recomposite
     * bug at all. Reporting a real number here would mean rasterising the SVG
     * just to answer, so it reports "not applicable" and `painted()` treats
     * that as healthy — an honest -1 rather than a made-up pixel count.
     */
    function litCount() { return -1; }

    return {
      kind: 'svg',
      canvas: svg,
      resize: resize,
      render: render,
      readHash: readHash,
      litCount: litCount,
      destroy: destroy,
    };
  }

  /* ================================================================
     8b. THE BOOT SCREEN — what fills the wait
     ================================================================

     The mark is ~1.7s of animation; a cold start is not. Everything in this
     section decorates time the host is ALREADY spending, and is not permitted
     to create any of its own: the intro runs its course, the splash then sits
     in a holding state cycling tips for exactly as long as it stays mounted,
     and `finish()` leaves from wherever it happens to be. App ready at 400ms
     and the user sees a glimpse; a nine-second cold start and they read all
     three tips. Neither one is made longer by this file.

     The one number below that is a promise rather than a taste is the hold
     ceiling. An unbounded hold plus a host that forgets to call `finish()` is
     the same failure the wall-clock ceiling was added for — a full-screen
     layer the user cannot get past — so the hold gets a ceiling of its own.

     EVERYTHING HERE IS STILL A PURE FUNCTION OF `t`. Which tip is up, how far
     the sheen has travelled, where the progress bar sits: all derived from the
     cursor, none accumulated. That is what keeps `seek()` reproducible, and
     `seek()` is what makes checks.html worth running. The two exceptions are
     named where they occur: the starting tip index (one Math.random() at
     construction, never in paint) and the reduced-motion cycle (which has no
     clock to be a function of).
  */

  /**
   * Defaults for the two brand strings. They are read from `opts.brand` at
   * mount and never referenced from the render path, because `src/brand.ts`'s
   * entire contract is that one file re-brands the app — a splash that spells
   * "PlaSpool" into the DOM breaks that promise on the first screen the new
   * owner sees.
   */
  var BRAND = { name: 'PlaSpool', tagline: 'Ecommerce platform' };

  /**
   * Encouragement for someone running a shop, not fortune cookies: each one is
   * a specific, checkable claim about what actually moves a small storefront.
   * Exposed as the `tips` option so the copy can be rewritten without anyone
   * opening the layout code.
   */
  var TIPS = [
    {
      title: 'Slow days are not the verdict',
      body: 'Most shops have more quiet mornings than busy ones. The ones that grow are simply the ones still here next season, still listing, still replying.',
    },
    {
      title: 'The next sale is easier than the first',
      body: 'Someone who already bought from you costs a fraction of a stranger to reach. One honest follow-up is worth a week of chasing new faces.',
    },
    {
      title: 'Reshoot one photo today',
      body: 'A better first image lifts a tired listing more than a discount will — and unlike a discount, you only pay for it once.',
    },
  ];

  /**
   * Chrome timing, in ms, on the same clock as the mark.
   *
   * `lead` is the only interesting one. The name starts `lead` ms before the
   * mark's own timeline ends, which on `forge` puts it at t=1180 — inside the
   * cure phase [900, 1250] and finishing at 1520, just under the settle. That
   * is deliberate: start it after the cure and the two read as two sequences
   * with a gap in the middle, start it before and the name competes with the
   * extrusion. It has to overlap the tail of the cure to read as one arrival.
   *
   * `stagger` is 120ms, which is about the shortest offset that still reads as
   * an order rather than as a sloppy simultaneous entrance.
   */
  var CH = {
    lead: 380,
    riseMs: 340,
    stagger: 120,
    cardLag: 280,
    cardMs: 400,
    /**
     * One tip per 2.1s, and the number is derived rather than chosen.
     *
     * The boot screen is specified to run 6s and to show at least TWO tips. The
     * card lands at `cardAt` (1460 on forge) and the exit takes `OUT_MS`, so the
     * budget for tips is 6000 − 180 − 1460 = 4360, and two of them means 2180
     * each. 2100 leaves a little slack so the second tip is fully up — not
     * mid-crossfade — when the exit starts.
     *
     * This is why the tip copy is one short line. At 2.1s with a 420ms
     * crossfade there is about 1.7s of clean reading, which is a headline plus
     * roughly a dozen words. Longer copy here does not get read; it gets
     * glimpsed. Change one and you have to change the other.
     */
    tipMs: 2100,
    crossMs: 420,
    sheenMs: 900,
    sheenLag: 140,
    nameRise: 12,
    tagRise: 10,
    cardRise: 14,
    /** Asymptote constant. See `progressAt` — we do not know real progress. */
    progressTau: 1800,
    progressCap: 0.9,
  };

  /** The chrome's landmarks, derived from the preset's own duration. */
  function chromeClock(duration) {
    var n0 = Math.max(0, duration - CH.lead);
    var c0 = n0 + CH.cardLag;
    return {
      nameIn: [n0, n0 + CH.riseMs],
      tagIn: [n0 + CH.stagger, n0 + CH.stagger + CH.riseMs],
      cardIn: [c0, c0 + CH.cardMs],
      cardAt: c0,
      /** Everything has arrived by here; from here on it is only the hold. */
      introEnd: c0 + CH.cardMs + 40,
    };
  }

  /**
   * Honest indeterminate progress. We do not know how far along the host is,
   * so the bar approaches 90% and never claims to have arrived; `finish()`
   * completes it. Deliberately no percentage NUMBER anywhere — a number is a
   * measurement, and this is not one.
   */
  function progressAt(t) {
    return CH.progressCap * (1 - Math.exp(-Math.max(0, t) / CH.progressTau));
  }

  /* The webfonts are @fontsource packages the standalone lab cannot load, and
     the app itself renders this screen BEFORE its own CSS has necessarily
     arrived — so the fallbacks are not a nicety, they are the common case.
     Segoe UI / system-ui carry the UI sans.

     THE LOCKUP IS MONO: both the wordmark and the tagline. There is no display
     serif here any more — `FONT_DISPLAY` was removed with it rather than left
     as an unused constant for someone to wire back up by mistake.

     `ui-monospace` sits ahead of the named fallbacks so a machine without the
     webfont gets SF Mono / Cascadia rather than Courier, which is what bare
     `monospace` resolves to on Windows and reads as a broken page. */
  var FONT_UI = "'Inter Variable',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif";
  var FONT_MONO = "'Roboto Mono Variable','Roboto Mono',ui-monospace,'JetBrains Mono Variable','SF Mono',Menlo,Consolas,monospace";

  var CHROME_CSS_ID = 'plaspool-splash-chrome';

  /**
   * One stylesheet for every instance, parameterised entirely by custom
   * properties set on each layer — which is the only way to reach `::before`
   * and `::after` from JavaScript, and the sheen needs one of those.
   *
   * THE SHEEN IS CSS, NOT A SECOND WEBGL CONTEXT. Contexts are capped at ~16
   * per document and the browser silently kills the oldest when you exceed it;
   * the mark already owns one, and spending a second on a decorative highlight
   * during app boot — on the weakest machine, at the worst moment — is not a
   * trade worth making. A masked gradient sweep is the correct tool here for
   * the same reason it was the WRONG tool for the mark: the card is FLAT, so a
   * translating gradient is a physically honest model of a light moving across
   * a flat brushed panel. The mark is not flat, which is the whole argument in
   * this file's header.
   *
   * Three layers make the metal, and only one of them moves:
   *   1. a shallow 163° base gradient — the panel is lit from above;
   *   2. a static 101° hairline grain at ~2.8% alpha — the brushing;
   *   3. one gradient band that sweeps across once and settles.
   * Restraint is the brief: "a brushed aluminium panel in a well-lit room, not
   * chrome". The band's flanks darken slightly rather than brightening, which
   * is what stops it reading as a glow.
   */
  var CHROME_CSS = [
    '.plsp-l{display:flex;align-items:center;justify-content:center;background:var(--plsp-paper);}',
    '.plsp-col{display:flex;flex-direction:column;align-items:center;box-sizing:border-box;',
    'width:100%;max-width:var(--plsp-colw);padding:var(--plsp-pad);text-align:center;}',
    '.plsp-mark{position:relative;flex:0 0 auto;width:var(--plsp-mark);height:var(--plsp-mark);}',
    '.plsp-name{margin:var(--plsp-gap-name) 0 0;font-family:var(--plsp-mono);',
    /* 0.86em because a monospace face sets every glyph on the same advance:
       "PlaSpool" measures about 20% wider in Roboto Mono than in the serif it
       replaced, which pushed the wordmark towards the edges at 320px. The
       tracking goes from -.015em to -.02em for the opposite reason — mono
       already carries its own air between letters, so a display size needs
       slightly MORE pulling in, not less, to read as one word. */
    'font-size:calc(var(--plsp-name)*.86);line-height:1.12;font-weight:500;letter-spacing:-.02em;',
    'color:var(--plsp-ink);}',
    /* Mono, and the two overrides under it are consequences rather than taste.
       Roboto Mono runs wider and optically larger than Inter at the same px, so
       the tagline was out-measuring the name it sits under; 0.94em pulls it
       back. And a monospace face already separates its glyphs, so the +.005em
       tracking that opened up Inter here reads as a gap in this one — the
       letter-spacing is dropped to 0 rather than inherited. */
    '.plsp-tag{margin:7px 0 0;font-family:var(--plsp-mono);font-size:calc(var(--plsp-tagsz)*.94);',
    'line-height:1.4;font-weight:400;letter-spacing:0;color:var(--plsp-ink3);}',
    '.plsp-card{position:relative;box-sizing:border-box;overflow:hidden;width:100%;',
    'margin-top:var(--plsp-gap-card);padding:var(--plsp-cardpad);text-align:left;',
    'border:1px solid var(--plsp-edge);border-radius:14px;',
    'background:repeating-linear-gradient(101deg,var(--plsp-grain) 0 1px,rgba(0,0,0,0) 1px 4px),',
    'linear-gradient(163deg,var(--plsp-card-a) 0%,var(--plsp-card-b) 100%);',
    'box-shadow:var(--plsp-shadow);}',
    // The lit top edge of a panel. One pixel, and it is most of the "metal".
    '.plsp-card::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;',
    'background:var(--plsp-lip);}',
    // Stops at 24/39/50/61/76 rather than a tighter band: at 31/42/50/58/69 the
    // sweep read as a highlight STREAK laid on the card — a hard-edged shape
    // travelling over a surface rather than a light travelling across it. A
    // brushed panel's response is broad and soft-shouldered; the width is what
    // separates "well-lit room" from "torch".
    '.plsp-card::after{content:"";position:absolute;top:-25%;bottom:-25%;left:0;right:0;',
    'pointer-events:none;background:linear-gradient(104deg,rgba(0,0,0,0) 24%,',
    'var(--plsp-sheen-2) 39%,var(--plsp-sheen-1) 50%,var(--plsp-sheen-2) 61%,',
    'rgba(0,0,0,0) 76%);transform:translate3d(var(--plsp-sheen-x),0,0);',
    'opacity:var(--plsp-sheen-o);}',
    // The sheen is a sibling that paints AFTER these, so without a stacking
    // context of their own the sweep crossed the copy and took the body text
    // from 10.2:1 down to ~4:1 for a third of a second. A brushed panel's
    // highlight lands on the panel, not on what is printed on it — "legible
    // first, decorative second" is a paint order before it is an opacity.
    '.plsp-label,.plsp-slots{position:relative;z-index:1;}',
    '.plsp-label{display:flex;align-items:center;gap:7px;font-family:var(--plsp-sans);',
    'font-size:var(--plsp-lblsz);font-weight:600;letter-spacing:.16em;text-transform:uppercase;',
    'color:var(--plsp-accent);}',
    '.plsp-dia{display:block;width:8px;height:8px;flex:0 0 auto;transform:rotate(45deg);',
    'border:1.5px solid var(--plsp-accent);border-radius:2px;}',
    // Both tip blocks are absolutely stacked so they can cross-fade. That
    // leaves the wrapper with no intrinsic height, so `measure()` gives it one
    // — the tallest of the three tips at the current width. Sizing it from the
    // CURRENT tip instead made the card resize under the cross-fade, and a
    // panel that changes height while its text changes reads as a glitch.
    '.plsp-slots{margin-top:10px;height:0;}',
    '.plsp-slot{position:absolute;left:0;right:0;top:0;}',
    '.plsp-title{margin:0;font-family:var(--plsp-sans);font-size:var(--plsp-titlesz);',
    'line-height:1.25;font-weight:600;letter-spacing:-.005em;color:var(--plsp-ink);}',
    '.plsp-body{margin:6px 0 0;font-family:var(--plsp-sans);font-size:var(--plsp-bodysz);',
    'line-height:1.58;font-weight:400;color:var(--plsp-ink2);}',
    '.plsp-rail{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--plsp-rail);}',
    '.plsp-fill{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:0 50%;',
    'transform:scaleX(0);background:var(--plsp-accent);}',
  ].join('');

  /**
   * Injected once per document and deliberately NEVER removed. Two splashes
   * can be alive at the same time (the review rig runs four), so tearing the
   * sheet down on one instance's `destroy()` would strip the others bare. It
   * is inert without a `.plsp-l` in the tree, and it is one node.
   */
  function ensureChromeCss() {
    if (document.getElementById(CHROME_CSS_ID)) return;
    var st = document.createElement('style');
    st.id = CHROME_CSS_ID;
    st.textContent = CHROME_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /** Host-supplied tips, rejected item by item rather than all or nothing. */
  function normaliseTips(raw) {
    if (!raw || typeof raw.length !== 'number') return TIPS;
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      if (it && typeof it.title === 'string' && typeof it.body === 'string' && it.title) {
        out.push({ title: it.title, body: it.body });
      }
    }
    return out.length ? out : TIPS;
  }

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  /**
   * Build the boot-screen layout around `stage` (which holds the mark) and
   * return the handful of calls `mount()` needs. Nothing here is focusable and
   * nothing here is announced — the whole layer is `aria-hidden`; see the live
   * region in `mount()` for why that is the right call.
   */
  function createChrome(layer, stage, opts, duration, themeName, reduced) {
    ensureChromeCss();

    var brandOpt = opts.brand || {};
    var brandName = typeof brandOpt.name === 'string' && brandOpt.name ? brandOpt.name : BRAND.name;
    var brandTag = typeof brandOpt.tagline === 'string' ? brandOpt.tagline : BRAND.tagline;
    var tipLabel = typeof opts.tipLabel === 'string' ? opts.tipLabel : 'TIP';
    var tips = normaliseTips(opts.tips);
    var clock = chromeClock(duration);

    /* ONE call to Math.random(), here, at construction — never inside paint().
       Someone opening the app five times a day should not read the same tip
       five times, but a random number anywhere below the timeline layer makes
       `seek(t)` non-reproducible, and every determinism assertion in
       checks.html quietly stops meaning anything. `tipStart` pins it for the
       rig and for the checks. */
    var startIndex = 0;
    if (tips.length) {
      startIndex = num(opts.tipStart, -1) >= 0
        ? Math.floor(num(opts.tipStart, 0)) % tips.length
        : Math.floor(Math.random() * tips.length) % tips.length;
    }

    var col = el('div', 'plsp-col');
    var nameEl = el('div', 'plsp-name');
    nameEl.textContent = brandName;
    var tagEl = el('div', 'plsp-tag');
    tagEl.textContent = brandTag;

    var card = el('div', 'plsp-card');
    var label = el('div', 'plsp-label');
    label.appendChild(el('i', 'plsp-dia'));
    var labelText = el('span', '');
    labelText.textContent = tipLabel;
    label.appendChild(labelText);

    var slots = el('div', 'plsp-slots');
    var blocks = [];
    for (var b = 0; b < 2; b++) {
      var root = el('div', 'plsp-slot');
      var title = el('p', 'plsp-title');
      var body = el('p', 'plsp-body');
      root.appendChild(title);
      root.appendChild(body);
      slots.appendChild(root);
      blocks.push({ root: root, title: title, body: body, tip: -1 });
    }

    var rail = el('div', 'plsp-rail');
    var fill = el('div', 'plsp-fill');
    rail.appendChild(fill);

    // The mark stops being an inset:0 backdrop and becomes the first item in a
    // centred column. Its own renderer sizes itself from this box, so the whole
    // of the boot layout falls out of one CSS variable.
    layer.className = layer.className ? layer.className + ' plsp-l' : 'plsp-l';
    stage.style.cssText = '';
    stage.className = 'plsp-mark';
    card.appendChild(label);
    card.appendChild(slots);
    col.appendChild(stage);
    col.appendChild(nameEl);
    col.appendChild(tagEl);
    col.appendChild(card);
    layer.appendChild(col);
    layer.appendChild(rail);

    /* ---- theme --------------------------------------------------- */
    function applyTheme(tn) {
      var u = (THEMES[tn] || THEMES.light).ui;
      var s = layer.style;
      s.setProperty('--plsp-sans', FONT_UI);
      s.setProperty('--plsp-mono', FONT_MONO);
      s.setProperty('--plsp-paper', u.paper);
      s.setProperty('--plsp-ink', u.ink);
      s.setProperty('--plsp-ink2', u.ink2);
      s.setProperty('--plsp-ink3', u.ink3);
      s.setProperty('--plsp-accent', u.accent);
      s.setProperty('--plsp-card-a', u.cardA);
      s.setProperty('--plsp-card-b', u.cardB);
      s.setProperty('--plsp-edge', u.edge);
      s.setProperty('--plsp-lip', u.lip);
      s.setProperty('--plsp-grain', u.grain);
      s.setProperty('--plsp-sheen-1', u.sheen1);
      s.setProperty('--plsp-sheen-2', u.sheen2);
      s.setProperty('--plsp-shadow', u.shadow);
      s.setProperty('--plsp-rail', u.rail);
    }

    /* ---- layout ---------------------------------------------------
       Sized in JavaScript rather than in `vh`/`vw`, because the host is not
       always the viewport: in the review rig the whole boot screen lives in a
       500px panel beside a readout, and viewport units there produced a mark
       twice the height of its own box. One measurement of the host, one set of
       custom properties, recomputed by the same ResizeObserver the renderer
       already uses. */
    var lastW = -1, lastH = -1, slotsH = 0;
    function layout(force) {
      var r = layer.getBoundingClientRect();
      var w = Math.round(Math.max(1, r.width));
      var h = Math.round(Math.max(1, r.height));
      if (!force && w === lastW && h === lastH) return;
      lastW = w; lastH = h;

      // The mark is sized off BOTH axes. Width alone gave a 104px mark at
      // 400x680 and pushed the tip card's last line under the progress rail;
      // a boot screen that clips its own copy on a phone is not a boot screen.
      var mark = Math.round(Math.max(48, Math.min(112, Math.min(w * 0.26, h * 0.155))));
      var narrow = w < 460;
      var tight = h < 560;
      var s = layer.style;
      s.setProperty('--plsp-mark', mark + 'px');
      s.setProperty('--plsp-colw', Math.min(452, Math.max(200, w - 24)) + 'px');
      s.setProperty('--plsp-pad', (narrow ? 18 : 24) + 'px');
      s.setProperty('--plsp-gap-name', (tight ? 12 : 18) + 'px');
      s.setProperty('--plsp-gap-card', (tight ? 18 : narrow ? 24 : 30) + 'px');
      s.setProperty('--plsp-name', Math.round(Math.max(23, Math.min(38, w * 0.082))) + 'px');
      s.setProperty('--plsp-tagsz', (narrow ? 12.5 : 13.5) + 'px');
      s.setProperty('--plsp-cardpad', narrow ? '15px 16px 17px' : '18px 20px 20px');
      s.setProperty('--plsp-lblsz', '10px');
      s.setProperty('--plsp-titlesz', (narrow ? 15 : 16.5) + 'px');
      s.setProperty('--plsp-bodysz', (narrow ? 13 : 14) + 'px');
      measure();
    }

    /**
     * Give `.plsp-slots` the height of the TALLEST tip at this width, once,
     * rather than letting the card resize under every cross-fade. Costs three
     * forced layouts per resize on a wrapper whose width does not depend on
     * its own height, so it cannot feed back into the ResizeObserver.
     */
    function measure() {
      if (!tips.length) return;
      var probe = blocks[1];
      var keepT = probe.title.textContent, keepB = probe.body.textContent;
      var keepO = probe.root.style.opacity;
      probe.root.style.opacity = '0';
      var max = 0;
      for (var i = 0; i < tips.length; i++) {
        probe.title.textContent = tips[i].title;
        probe.body.textContent = tips[i].body;
        var hh = probe.root.offsetHeight;
        if (hh > max) max = hh;
      }
      probe.title.textContent = keepT;
      probe.body.textContent = keepB;
      probe.root.style.opacity = keepO;
      probe.tip = -1; // the probe scribbled over it; force a rewrite
      // A detached or display:none host measures 0. Keeping the last good
      // height beats collapsing the card to nothing and never recovering.
      if (max > 0) { slotsH = max; slots.style.height = max + 'px'; }
    }

    /* ---- which tip, and when ------------------------------------- */
    function slotOf(t) {
      var u = t - clock.cardAt;
      return u < 0 ? -1 : Math.floor(u / CH.tipMs);
    }
    function indexOf(slot) {
      var n = tips.length;
      if (!n) return -1;
      var k = (startIndex + slot) % n;
      return k < 0 ? k + n : k;
    }

    /* Reduced motion has no clock to be a function of — nothing is animating,
       so nothing is advancing `t`. The tips are CONTENT, and the brief is that
       content still rotates; so this is the one accumulator in the file, and
       it is deliberately outside the render path. Swaps are instant. */
    var reducedSlot = 0;
    var reducedTimer = 0;
    function startReducedCycle() {
      if (reducedTimer || tips.length < 2) return;
      reducedTimer = window.setInterval(function () {
        reducedSlot++;
        writeBlock(blocks[0], indexOf(reducedSlot));
        blocks[0].root.style.opacity = '1';
        blocks[1].root.style.opacity = '0';
      }, CH.tipMs);
    }

    function writeBlock(blk, idx) {
      if (blk.tip === idx) return;
      blk.tip = idx;
      var tip = idx >= 0 && idx < tips.length ? tips[idx] : null;
      blk.title.textContent = tip ? tip.title : '';
      blk.body.textContent = tip ? tip.body : '';
    }

    /* ---- paint ----------------------------------------------------
       Every style write is memoised. Not a micro-optimisation: this runs on
       the boot thread at 60fps for as long as the host is slow, and an
       unconditional write of the same string still dirties style on every
       element it touches. */
    var memo = {};
    function put(node, key, prop, value) {
      if (memo[key] === value) return;
      memo[key] = value;
      node.style[prop] = value;
    }
    function setV(key, name, value) {
      if (memo[key] === value) return;
      memo[key] = value;
      layer.style.setProperty(name, value);
    }
    function rise(px) { return px === 0 ? 'none' : 'translate3d(0,' + px.toFixed(2) + 'px,0)'; }

    var exitLatched = false;

    function paint(t, exiting) {
      // --- entrances. Reduced motion means ABSENT, not slower: everything is
      // already at its resting place on the first paint, no stagger, no rise.
      var nameE = reduced ? 1 : easeOutCubic(span(t, clock.nameIn[0], clock.nameIn[1]));
      var tagE = reduced ? 1 : easeOutCubic(span(t, clock.tagIn[0], clock.tagIn[1]));
      var cardE = reduced ? 1 : easeOutCubic(span(t, clock.cardIn[0], clock.cardIn[1]));
      put(nameEl, 'no', 'opacity', nameE.toFixed(3));
      put(nameEl, 'nt', 'transform', rise((1 - nameE) * CH.nameRise));
      put(tagEl, 'go', 'opacity', tagE.toFixed(3));
      put(tagEl, 'gt', 'transform', rise((1 - tagE) * CH.tagRise));
      put(card, 'co', 'opacity', cardE.toFixed(3));
      put(card, 'ct', 'transform', rise((1 - cardE) * CH.cardRise));

      // --- which tip, and the cross-fade between two of them.
      var slot = reduced ? reducedSlot : slotOf(t);
      if (slot < 0) {
        writeBlock(blocks[0], indexOf(0));
        put(blocks[0].root, 'b0o', 'opacity', '1');
        put(blocks[1].root, 'b1o', 'opacity', '0');
      } else {
        var cur = blocks[slot % 2];
        var prev = blocks[(slot + 1) % 2];
        writeBlock(cur, indexOf(slot));
        // Slot 0 has no predecessor — the card's own entrance is its fade, so
        // cross-fading from an empty block there would double the animation.
        var e = reduced || slot === 0
          ? 1
          : smoothstep(span(t - clock.cardAt - slot * CH.tipMs, 0, CH.crossMs));
        if (slot > 0) writeBlock(prev, indexOf(slot - 1));
        else writeBlock(prev, -1);
        put(cur.root, slot % 2 === 0 ? 'b0o' : 'b1o', 'opacity', e.toFixed(3));
        put(prev.root, slot % 2 === 0 ? 'b1o' : 'b0o', 'opacity', (1 - e).toFixed(3));
      }

      // --- the sheen. One pass per card: a half-sine envelope, so it is zero
      // at both ends and cannot leave a residue sitting on the panel. Later
      // cards get 55% of the amplitude — the first arrival is the event, the
      // rest are a glance.
      if (reduced) {
        setV('sx', '--plsp-sheen-x', '0%');
        setV('so', '--plsp-sheen-o', '0');
      } else {
        var s0 = slot <= 0 ? clock.cardAt + CH.sheenLag : clock.cardAt + slot * CH.tipMs;
        var sp = span(t, s0, s0 + CH.sheenMs);
        var amp = slot <= 0 ? 1 : 0.55;
        setV('sx', '--plsp-sheen-x', (-100 + 200 * sp).toFixed(1) + '%');
        setV('so', '--plsp-sheen-o', (Math.sin(Math.PI * sp) * amp * cardE).toFixed(3));
      }

      // --- progress. Asymptotic while we are guessing; completed, once, when
      // the host says it is ready. The transition is attached at that moment
      // rather than kept on the element, so the per-frame writes above are not
      // each chasing a 180ms tween.
      if (exiting && !exitLatched) {
        exitLatched = true;
        if (!reduced) {
          fill.style.transition = 'transform ' + OUT_MS + 'ms cubic-bezier(0.16,1,0.3,1)';
        }
        memo.pf = null;
      }
      // Under reduced motion the bar is a state, not an animation: it is
      // written once at the value the asymptote would have reached by the end
      // of the intro and then left alone. A bar whose only content is movement
      // IS movement, and "no motion" has to mean that.
      var p = exitLatched ? 1 : reduced ? progressAt(clock.introEnd) : progressAt(t);
      if (!reduced || !memo.pf || exitLatched) {
        put(fill, 'pf', 'transform', 'scaleX(' + p.toFixed(4) + ')');
      }
    }

    function refresh(t) {
      blocks[0].tip = -1;
      blocks[1].tip = -1;
      memo = {};
      paint(t, exitLatched);
    }

    function destroy() {
      if (reducedTimer) { clearInterval(reducedTimer); reducedTimer = 0; }
    }

    applyTheme(themeName);
    layout(true);
    if (reduced) startReducedCycle();

    return {
      tips: tips,
      paint: paint,
      layout: layout,
      applyTheme: applyTheme,
      destroy: destroy,
      /**
       * `setPreset` changes the mark's duration, and every landmark here is
       * derived from it — so the clock is rebuilt rather than left pointing at
       * the timings of a preset that is no longer playing. Getters, not
       * captured values, for the same reason.
       */
      setDuration: function (d) { clock = chromeClock(d); },
      introEnd: function () { return clock.introEnd; },
      /** Full span of one loop through every tip — what `seek()` may reach. */
      spanMs: function () { return clock.cardAt + tips.length * CH.tipMs + CH.crossMs; },
      currentSlot: function (t) { return reduced ? reducedSlot : Math.max(0, slotOf(t)); },
      tipIndex: function (t) { return indexOf(reduced ? reducedSlot : Math.max(0, slotOf(t))); },
      nextTip: function (t) {
        if (!tips.length) return -1;
        startIndex = (startIndex + 1) % tips.length;
        refresh(t);
        return indexOf(reduced ? reducedSlot : Math.max(0, slotOf(t)));
      },
      showTip: function (i, t) {
        if (!tips.length) return -1;
        var n = tips.length;
        var slot = reduced ? reducedSlot : Math.max(0, slotOf(t));
        startIndex = (((Math.floor(i) - slot) % n) + n) % n;
        refresh(t);
        return indexOf(slot);
      },
      progress: function (t) { return exitLatched ? 1 : reduced ? progressAt(clock.introEnd) : progressAt(t); },
    };
  }

  /* ================================================================
     9. MOUNT
     ================================================================ */

  function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    // The same three sources `BrandLogo.tsx` reasons about, in the same order:
    // an explicit attribute wins, then the OS preference.
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) { /* matchMedia is absent in some embedded webviews */ }
    return 'light';
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  /**
   * A host may force motion-reduction ON. It may never force it OFF.
   *
   * The old shape was a three-way — `true`, `false`, else ask the OS — which
   * meant an explicit `reducedMotion: false` OUTRANKED the operating system.
   * The review rig shipped exactly that on every mount, so with
   * `prefers-reduced-motion: reduce` set at the browser level the mark still
   * fully animated. An accessibility setting that an ordinary prop can switch
   * off is not an accessibility setting.
   */
  function resolveReduced(opt) {
    return prefersReducedMotion() || opt === true;
  }

  /* ---------------------------------------------------------------
     INPUT GUARDS

     Everything below is reachable from the host application, so every one of
     them is a place a `undefined` can arrive from a stale ref or a mistyped
     prop. `Math.max(0, Math.min(d, t))` looks like a clamp but is NaN-
     transparent: min(1560, NaN) is NaN, max(0, NaN) is NaN, and the cursor is
     now NaN forever. Both arms of the exit test then read false, so the overlay
     never fades, never unmounts and never calls onDone — a full-screen layer
     the user cannot get past. Reject non-finite input; do not clamp around it.
     --------------------------------------------------------------- */

  /** Finite numbers only. Anything else (NaN, Infinity, undefined, '12', {}) is refused. */
  function num(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }
  function clampT(t, duration, fallback) {
    var v = num(t, NaN);
    if (!isFinite(v)) return fallback;
    return v < 0 ? 0 : v > duration ? duration : v;
  }
  /**
   * Own-property test. `PRESETS[name]` is truthy for every key on
   * Object.prototype, so `preset: 'toString'` passed validation and then threw
   * on `ph.extrude` deep inside evaluate().
   */
  function hasPreset(name) {
    return typeof name === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, name);
  }

  /* ---------------------------------------------------------------
     "ALREADY SEEN" POLICY

     localStorage, not sessionStorage. sessionStorage is per TAB, and
     cmd-clicking a record into a new tab is routine in an admin app — so a
     per-session splash charged the user again in every tab they opened. A
     timestamp plus a window is the honest model: seen recently enough, skip it.

     Storage can throw outright (Safari private mode, some file:// contexts) and
     can also silently fail, so there is an in-memory tier underneath. That tier
     is per document, which is the best a page with no storage can do.
     --------------------------------------------------------------- */
  var MEMORY_SEEN = {};

  function readStore(key) {
    try {
      var v = window.localStorage.getItem(key);
      if (v !== null) return v;
    } catch (e) { /* fall through */ }
    try {
      var s = window.sessionStorage.getItem(key);
      if (s !== null) return s;
    } catch (e) { /* fall through */ }
    return Object.prototype.hasOwnProperty.call(MEMORY_SEEN, key) ? MEMORY_SEEN[key] : null;
  }
  function writeStore(key, value) {
    MEMORY_SEEN[key] = value;
    try { window.localStorage.setItem(key, value); return; } catch (e) { /* fall through */ }
    try { window.sessionStorage.setItem(key, value); } catch (e) { /* memory only */ }
  }
  function clearStore(key) {
    delete MEMORY_SEEN[key];
    try { window.localStorage.removeItem(key); } catch (e) { }
    try { window.sessionStorage.removeItem(key); } catch (e) { }
  }

  var SEEN_KEY = 'plaspool.splash.seen';
  /** Six hours: long enough to cover a working session, short enough that
   *  tomorrow's first load is still an occasion. Overridable per mount. */
  var SEEN_WINDOW_MS = 6 * 60 * 60 * 1000;

  function wasSeen(key, windowMs) {
    var raw = readStore(key);
    if (raw === null) return false;
    var at = parseInt(raw, 10);
    // A value written by an older build ('1') has no timestamp. Treat it as
    // seen-just-now rather than as never-seen, so an upgrade does not replay
    // the splash for everyone mid-session.
    if (!isFinite(at)) { writeStore(key, String(Date.now())); return true; }
    return (Date.now() - at) < windowMs;
  }
  function markSeen(key) { writeStore(key, String(Date.now())); }

  /**
   * Mount the splash into `host` and return its control surface.
   *
   * PRECONDITION ON `host`: the overlay is `position:absolute; inset:0`, so it
   * needs `host` to be a positioned ancestor. A plain `<div ref={...}/>` from
   * React is `position:static`, and a static host makes the overlay size itself
   * against the nearest positioned ancestor or the viewport instead — a 140×140
   * host produced a 1521×720 canvas, silently. `mount` therefore promotes a
   * static host to `position:relative` itself and puts it back on `destroy()`.
   * If you would rather own that, position the host yourself and nothing is
   * touched.
   *
   * OPTIONS — every one of them, because thirteen undocumented knobs is not a
   * public interface:
   *
   *   preset       'forge' | 'glimmer' | 'extrude'      default 'forge'
   *                Unknown or non-own-property names fall back to 'forge'.
   *   theme        'auto' | 'light' | 'dark'            default 'auto'
   *                'auto' reads [data-theme] then the OS preference.
   *   autoplay     boolean                              default true
   *   skippable    boolean                              default true
   *                Any pointerdown / keydown / touchstart / wheel exits early.
   *   once         boolean                              default true
   *                Skip entirely if shown within `seenWindowMs`.
   *   seenKey      string   storage key                 default 'plaspool.splash.seen'
   *   seenWindowMs number   how long "seen" lasts       default 6h
   *   maxMs        number   HARD wall-clock ceiling     default 1800
   *                Measured from mount to onDone, enforced by a timer, not by
   *                rAF. Ignored when `holdAtEnd` is set — that opts out by
   *                definition. Passing it EXPLICITLY caps the holding state
   *                too: "I want out by then" outranks "wait for me".
   *   chrome       boolean  the boot-screen layout      default true
   *                Name, tagline, tip card and progress rail around the mark.
   *                `false` is the bare mark on a transparent layer, filling
   *                the host exactly as it did before any of this existed —
   *                which is what the material and geometry checks measure.
   *   hold         boolean  wait after the intro        default true
   *                Cycle tips until finish(), destroy() or `maxHoldMs`. The
   *                splash never ADDS wait; this only decorates wait the host
   *                is already spending. `false` restores the pre-boot-screen
   *                contract: the timeline runs out and the splash exits.
   *   maxHoldMs    number   ceiling on the hold         default 30000
   *                Measured from mount. A host that forgets to call finish()
   *                must not be able to strand a user on a boot screen; that
   *                failure is why `maxMs` exists, and the hold needs its own.
   *   tips         [{title,body}, ...]                  default TIPS
   *                Items missing a string title/body are dropped; an empty
   *                result falls back to the defaults rather than to no card.
   *   tipStart     number   pin the first tip           default: random
   *                The index is chosen ONCE at mount, never per frame.
   *   tipLabel     string   the accent label's word     default 'TIP'
   *   brand        {name, tagline}                      default PlaSpool
   *                Read as options and never hardcoded into the render path —
   *                `src/brand.ts` is meant to be the only file a re-brand
   *                touches, and a boot screen is the first thing it must fix.
   *   holdAtEnd    boolean                              default false
   *                Keep the finished mark on screen instead of fading. For
   *                review harnesses; the app wants the default.
   *   reducedMotion true to FORCE reduction             default: the OS setting
   *                A host may force reduction ON. It can never force it OFF —
   *                see `resolveReduced`.
   *   forceFallback boolean                             default false
   *                Take the SVG path even where WebGL is available.
   *   zoom         number   mark scale in its box       default 1.22
   *   debugHandle  boolean  park on window.__splash     default true
   *   onDone       function                             default noop
   *                Fires exactly once, never after destroy().
   */
  function mount(host, opts) {
    if (!host || typeof host.appendChild !== 'function') {
      throw new Error('PlaSpoolSplash.mount(host): host must be a DOM element, got ' +
        (host === null ? 'null' : typeof host));
    }
    opts = opts || {};
    var presetName = hasPreset(opts.preset) ? opts.preset : 'forge';
    var themeName = resolveTheme(opts.theme || 'auto');
    var once = opts.once !== false;
    var seenKey = typeof opts.seenKey === 'string' ? opts.seenKey
      : typeof opts.sessionKey === 'string' ? opts.sessionKey   // pre-1.1 name
        : SEEN_KEY;
    var seenWindowMs = num(opts.seenWindowMs, SEEN_WINDOW_MS);
    var skippable = opts.skippable !== false;
    var onDoneFn = typeof opts.onDone === 'function' ? opts.onDone : function () { };
    var reduced = resolveReduced(opts.reducedMotion);
    var wantChrome = opts.chrome !== false;
    var holding = opts.hold !== false;

    /* TWO CEILINGS, AND WHICH ONE WINS.
       `maxMs` is unchanged in meaning: a hard wall-clock ceiling from mount to
       onDone, enforced by a timer so it survives a dead rAF. What changed is
       that there is now a state it was never written for — a hold that is
       deliberately unbounded — so the DEFAULT ceiling has to follow the state:
       1800ms when there is no hold, `maxHoldMs` when there is.

       An EXPLICIT `maxMs` still caps everything. A host that names a number is
       telling us when it wants its screen back, and that has to outrank a hold
       whose whole justification is "the host is not ready yet". */
    var explicitMax = num(opts.maxMs, 0) > 0;
    var maxMs = Math.max(OUT_MS + 60, num(opts.maxMs, 1800));

    // --- already seen recently: do nothing, cost nothing.
    if (once && wasSeen(seenKey, seenWindowMs)) {
      // The FULL surface with inert implementations, not a subset. `once`
      // defaults to true, so this is the default path for every load after the
      // first — a host that reads `.element` or calls `.frameMs()` would crash
      // on load two while working perfectly on load one, which is the worst
      // possible shape for a bug.
      var noop = {
        kind: 'skipped',
        preset: presetName,
        theme: themeName,
        reducedMotion: reduced,
        duration: 0,
        out: 0,
        element: null,
        play: function () { }, pause: function () { }, seek: function () { },
        finish: function () { }, destroy: function () { },
        setPreset: function () { }, setTheme: function () { },
        frameHash: function () { return 0; },
        state: function () { return null; },
        describe: function () { return describe(presetName); },
        frameMs: function () { return 0; },
        geometry: GEOM.diagnostics,
        renderer: function () { return 'skipped'; },
        // A splash that was never mounted has no surface to be blank, so it
        // reports painted:false rather than claiming health it cannot have.
        painted: function () { return false; },
        litPixels: function () { return 0; },
        // Same rule as the rest of this object: the FULL shape, inert. A host
        // that drives the tip carousel must not crash on the second load of
        // the day just because the splash decided not to appear.
        chrome: false,
        holding: function () { return false; },
        tipCount: 0,
        tipIndex: function () { return -1; },
        nextTip: function () { return -1; },
        showTip: function () { return -1; },
        progress: function () { return 1; },
      };
      // Reported asynchronously so the caller's `onDone` never runs before the
      // caller has finished wiring itself up.
      setTimeout(function () { onDoneFn(); }, 0);
      return noop;
    }

    // The overlay is absolutely positioned, so it needs a positioned ancestor
    // or it escapes the host entirely. Promote a static host and remember that
    // we did, so destroy() can put it back exactly as it was.
    var hostPositionPatched = false;
    try {
      if (window.getComputedStyle(host).position === 'static') {
        host.style.position = 'relative';
        hostPositionPatched = true;
      }
    } catch (e) { /* detached host; the ResizeObserver will sort it out */ }

    var layer = document.createElement('div');
    layer.setAttribute('aria-hidden', 'true');
    // The mark is decoration: the app's own heading says PlaSpool, so announcing
    // it here would just make a screen reader read the brand twice. No focusable
    // node goes in, so focus can never be trapped behind the overlay either.
    layer.style.cssText = [
      'position:absolute;inset:0;',
      'pointer-events:none;',
      'opacity:1;transition:opacity ' + OUT_MS + 'ms cubic-bezier(0.4,0,1,1),',
      'transform ' + OUT_MS + 'ms cubic-bezier(0.16,1,0.3,1);',
      'will-change:opacity,transform;',
    ].join('');

    // Absolute inset, NOT width/height:100% in a centring grid. The SVG
    // fallback has an intrinsic 1:1 ratio from its viewBox, and against an
    // auto-sized grid row a percentage height resolved from that ratio instead
    // of from the host — the fallback rendered square and 33% oversized inside
    // a 4:3 stage while the canvas, which sets explicit pixel dimensions, was
    // fine. An absolutely positioned box is definite, so both agree.
    var stage = document.createElement('div');
    stage.style.cssText = 'position:absolute;inset:0;';
    layer.appendChild(stage);
    host.appendChild(layer);

    var duration = PRESETS[presetName].duration;

    /* The chrome is built BEFORE the renderer, because building it is what
       gives `stage` its final size — it stops being an inset:0 backdrop and
       becomes a fixed box in a centred column. `createGL` measures the stage
       in its constructor, so getting this order wrong sizes the drawing buffer
       to the wrong box and the mark renders at the wrong scale for one frame
       (and forever, if nothing resizes afterwards). */
    var chrome = wantChrome
      ? createChrome(layer, stage, opts, duration, themeName, reduced)
      : null;

    /* ONE polite live region, and it says one thing.
       The visual stack stays aria-hidden — the app's own heading already says
       the brand, so announcing it here reads it twice — but a screen-reader
       user still has to be told the app is loading, so this sits OUTSIDE the
       hidden layer as a sibling.
       It is written once and never updated. Announcing each tip rotation would
       interrupt whatever the user is listening to every 3.4 seconds, forever,
       with content that is decoration by definition: the tips exist to fill a
       wait that a screen-reader user is not looking at. One "loading" is the
       whole message; the rest is noise. */
    var live = null;
    var liveTimer = 0;
    if (wantChrome) {
      live = document.createElement('div');
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      // Clipped, not display:none — a display:none live region is not
      // announced at all in several screen readers, which would make this
      // element a decoration that only looked accessible.
      live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;' +
        'padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);' +
        'white-space:nowrap;border:0;';
      host.appendChild(live);
      // Populated a tick late: a live region that already has its text when it
      // is inserted is frequently not announced, because there was no mutation
      // for the accessibility tree to notice.
      liveTimer = window.setTimeout(function () {
        liveTimer = 0;
        if (!destroyed && live) {
          live.textContent = 'Loading ' +
            ((opts.brand && opts.brand.name) || BRAND.name) + '…';
        }
      }, 60);
    }

    var renderer = null;
    if (!opts.forceFallback) renderer = createGL(stage, opts);
    if (!renderer) renderer = createSVG(stage, opts);
    stage.appendChild(renderer.canvas);
    renderer.resize();

    var theme = THEMES[themeName];

    /* The hold's own ceiling, and the seek range the chrome adds.
       `maxHoldMs` can never be shorter than the intro plus its exit — a host
       passing `maxHoldMs: 100` should get a short hold, not a splash that
       cuts itself off mid-name. */
    var introEnd = chrome ? chrome.introEnd() : duration;
    var maxHoldMs = Math.max(introEnd + OUT_MS + 60, num(opts.maxHoldMs, 30000));
    var ceilingMs = explicitMax ? maxMs : (holding ? maxHoldMs : maxMs);
    var seekMax = chrome && holding ? Math.max(duration, chrome.spanMs()) : duration;

    var raf = 0;
    var playing = false;
    var t0 = 0;           // performance.now() at the start of the current run
    var cursor = 0;       // the last t rendered
    var ending = false;
    var held = false;      // ended, but holding the final frame until released
    var destroyed = false;
    var outStart = 0;     // wall time the exit began
    var outFrom = 0;      // timeline position the exit began from
    var outTo = 0;        // and where it is allowed to end — see beginOut
    var lastFrameMs = 0;
    var holdSettled = false; // the hold's terminal frame is on the surface
    var introAnim = null; // reduced-motion fade-in; must be cancelled to exit

    function draw(t) {
      if (destroyed) return;
      cursor = t;
      // The mark's timeline ends at `duration`; the chrome's does not. Every
      // easing inside `evaluate` clamps, so a cursor out in the hold already
      // returns the terminal frame — this is only saying so out loud, so a
      // reader does not have to prove it.
      var st = evaluate(presetName, t > duration ? duration : t);
      // Any render short of the end means the mark can still move, so the
      // hold's one-shot terminal frame is owed again.
      if (t < duration) holdSettled = false;
      var m0 = performance.now();
      renderer.render(st, theme);
      lastFrameMs = performance.now() - m0;
      if (chrome) chrome.paint(t, ending && !held);
      return st;
    }

    /**
     * The hold's frame: chrome only, no GPU.
     *
     * Past `duration` the mark is at its terminal frame and re-rendering it is
     * pure heat — 60 identical draws a second for as long as the host is slow,
     * which on a nine-second cold start is 540 of them, on the boot thread, on
     * whatever machine was slow enough to need a hold in the first place. The
     * surface keeps what it has (see `preserveDrawingBuffer`), and every
     * recovery path still goes through `draw()`, so nothing here can leave a
     * blank stage behind.
     */
    function holdFrame(t) {
      if (destroyed) return;
      // One terminal render on the way in. rAF lands wherever it lands, so the
      // last TIMED frame is a few milliseconds short of `duration` — and on a
      // preset still easing its settle at the end, that is the frame the user
      // would then be left looking at for the whole of a nine-second boot.
      if (!holdSettled) { holdSettled = true; draw(duration); }
      cursor = t;
      if (chrome) chrome.paint(t, false);
    }

    /**
     * Fires `onDone` exactly once, and never after `destroy()`.
     *
     * It used to be two independent timers — one in the reduced-motion branch,
     * one in beginOut — and under reduced motion a host calling finish() got
     * BOTH, at 197ms and 262ms. finish() is the documented app-is-ready call,
     * so that is the supported integration path: a host revealing the app in
     * onDone revealed it twice. The reduced-motion timer also lacked the
     * destroyed guard its twin already had, so a torn-down splash still fired
     * and still recorded "seen" — suppressing the real one for the rest of the
     * window.
     */
    var settled = false;
    function reportDone() {
      if (settled || destroyed) return;
      settled = true;
      clearCeiling();
      // Release the compositor layer. `will-change` is a promise about the
      // future; once the animation is over it is just a retained texture.
      layer.style.willChange = 'auto';
      if (once) markSeen(seenKey);
      onDoneFn();
    }

    /* --- reduced motion: not a slower version, an absent one. ---
       A static final frame, one short opacity fade, done well inside 200ms.
       Nothing sweeps and nothing draws on. But it still gets the SAME graceful
       exit as the normal path: it ends held, skip stays armed, and finish()
       fades it out over OUT_MS. Reduced motion means less movement, not a worse
       exit — leaving the host with only a hard cut is the one thing the normal
       path spends 180ms avoiding. */
    if (reduced) {
      /* Everything at once: the mark on its final frame and, because the
         chrome's easings are all short-circuited under reduction, the name,
         the tagline and the first tip already at rest. No stagger, no rise, no
         sheen sweep, and a progress rail written once and left alone. The tips
         still ROTATE — the content is the point, and rotating text that swaps
         instantly is not motion — driven by an interval rather than by the
         clock, because under reduction there is no clock. */
      draw(duration);
      // The Web Animations API, not a CSS transition. A transition only fires
      // when the browser observes a CHANGE between two resolved styles, and on
      // a freshly inserted element it kept collapsing: measured computed
      // opacity was already 1.000 at 18ms, both with a double-rAF settle and
      // with a forced reflow. animate() states the keyframes outright and
      // cannot be optimised away. It is a runtime call, not a dependency.
      layer.style.transition = 'none';
      if (typeof layer.animate === 'function') {
        introAnim = layer.animate([{ opacity: 0 }, { opacity: 1 }],
          { duration: 140, easing: 'linear', fill: 'both' });
      }
      layer.style.opacity = '1';
      // Ended and holding: the mark stays up until the host says go, exactly
      // like holdAtEnd, so finish()/skip has something to fade.
      ending = true;
      held = true;
      setTimeout(reportDone, 170);
    }

    /* --- the wall-clock ceiling ---
       `frame()` is the only route to beginOut() and rAF is the only thing that
       schedules it, so on a page whose main thread is contended — or where rAF
       never runs at all — nothing enforced the budget. Measured: 2337ms on a
       busy page, and unbounded with rAF stubbed out. `maxMs` was dead code,
       because every preset's duration already sat under its 1800 default.

       This is a timer, deliberately: it has to be independent of the thing that
       is failing. The promise is that the splash lasts SHORTER when the machine
       is slow, never longer, so the backstop fires early enough that the exit
       still completes inside the budget. */
    var ceilingTimer = 0;
    function clearCeiling() {
      if (ceilingTimer) { clearTimeout(ceilingTimer); ceilingTimer = 0; }
    }
    var ceilingAt = Math.max(0, ceilingMs - OUT_MS - 40);
    if (!reduced && !opts.holdAtEnd) {
      ceilingTimer = setTimeout(function () {
        ceilingTimer = 0;
        if (destroyed || settled) return;
        beginOut(true);
        // -40 for timer slop. setTimeout is a floor, not a promise, and with
        // the main thread contended enough to need this backstop at all it is
        // exactly the moment timers run late. Measured at 1840ms against an
        // 1800 budget without it.
      }, ceilingAt);
    }

    function frame(now) {
      raf = 0;
      if (destroyed) return;

      if (ending) {
        // The exit compresses whatever is left of the timeline into OUT_MS, so
        // calling finish() at t=200 still shows the mark completing rather than
        // cutting to black on a half-drawn stroke. easeOutQuint front-loads it:
        // the remaining travel happens almost at once and then settles, which
        // reads as "done" rather than "fast-forwarded".
        var k = clamp01((now - outStart) / OUT_MS);
        draw(outFrom + (outTo - outFrom) * easeOutQuint(k));
        if (k < 1) raf = requestAnimationFrame(frame);
        return;
      }

      // rAF hands back the timestamp of the frame it belongs to, which can
      // PREDATE the performance.now() that play() used to set t0 — so the first
      // frame after a mount was rendering at t = -14ms. The easings all clamp,
      // so nothing looked wrong, but "render(t) is a pure function of t" is
      // worth less if t can be negative and a future reader is entitled to
      // assume it never is.
      var t = Math.max(0, now - t0);

      /* THE HOLD.
         Past `duration` the mark is finished and the splash simply waits, for
         exactly as long as the host keeps it mounted. It costs no GPU (see
         `holdFrame`) and it adds no wait: it is only here because the host is
         already taking one.

         The ceiling test mirrors the timer rather than replacing it. The timer
         is the authority because it survives a dead rAF, which is the failure
         it was written for; this arm catches the ordinary case a few frames
         earlier and keeps the two from disagreeing about what "over" means. */
      if (holding && t >= duration) {
        if (!opts.holdAtEnd && t >= ceilingAt) {
          draw(t);
          beginOut(true);
          return;
        }
        holdFrame(t);
        raf = requestAnimationFrame(frame);
        return;
      }

      // Backgrounding the tab stops rAF; on return `t` lands past `duration` and
      // the splash finishes immediately, which is the correct behaviour and
      // needs no special case. The ceiling below is for the other failure — a
      // main thread so blocked that the timeline never advances.
      if (t >= duration || t >= maxMs) {
        draw(duration);
        beginOut(true);
        return;
      }
      draw(t);
      raf = requestAnimationFrame(frame);
    }

    /**
     * The exit, driven by the Web Animations API where it exists.
     *
     * Two reasons, both learned the hard way. A fill:'both' intro animation
     * outranks an inline style in the cascade, so setting `opacity = 0` under
     * one silently does nothing — the intro has to be cancelled first. And a
     * CSS transition needs the browser to observe a change between two resolved
     * styles, which is exactly what kept collapsing on a freshly mounted layer.
     * The inline style is still written so it always reflects the resting
     * state, which is what the checks read.
     */
    function fadeOut() {
      if (introAnim) { try { introAnim.cancel(); } catch (e) { } introAnim = null; }
      var from = layer.style.opacity === '' ? 1 : parseFloat(layer.style.opacity);
      if (!isFinite(from)) from = 1;
      layer.style.opacity = '0';
      layer.style.transform = 'scale(1.018)';
      if (typeof layer.animate === 'function') {
        layer.style.transition = 'none';
        layer.animate(
          [{ opacity: from, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.018)' }],
          { duration: OUT_MS, easing: 'cubic-bezier(0.4,0,1,1)', fill: 'both' }
        );
      }
    }

    /**
     * `holdAtEnd` keeps the finished mark on screen when the timeline runs out
     * on its own — the review pages use it, because the product behaviour (fade
     * out and get out of the way) leaves a reviewer scrubbing an empty box.
     *
     * A held splash is still ENDED, so the second call has to be able to
     * release it. Returning early on `ending` for every caller meant finish()
     * did nothing at all once the timeline had run out, which is the one moment
     * a host is most likely to call it.
     */
    function beginOut(natural) {
      if (destroyed) return;
      if (ending) {
        if (held && !natural) { held = false; removeSkipListeners(); releaseOut(); }
        return;
      }
      ending = true;
      playing = false;
      held = !!(natural && opts.holdAtEnd);
      outStart = performance.now();
      /* Where the exit starts, and where it is allowed to travel to.
         `outFrom → outTo` used to be `cursor → duration`, which was right when
         the cursor could only ever be short of the end: finish() at t=200 then
         shows the mark completing rather than cutting off mid-stroke.

         Out in the hold the cursor is PAST `duration`, and that same lerp ran
         backwards — the exit rewound the tip carousel through however many
         cards had already gone by, at speed, on the way out. So the target is
         clamped: the exit may finish the mark, never unwind it. */
      outFrom = natural ? Math.max(duration, cursor) : cursor;
      outTo = Math.max(duration, outFrom);
      // Skip stays armed while held: a hold is "waiting", and any input during
      // a wait still means dismiss.
      if (!held) { removeSkipListeners(); fadeOut(); latchExit(); }
      if (!raf) raf = requestAnimationFrame(frame);
      // A timer, not a rAF callback: the exit has to complete even when rAF is
      // the thing that has stopped running.
      window.setTimeout(reportDone, OUT_MS);
    }

    function releaseOut() {
      outStart = performance.now();
      outFrom = cursor;
      outTo = Math.max(duration, cursor);
      fadeOut();
      latchExit();
      if (!raf) raf = requestAnimationFrame(frame);
    }

    /**
     * Complete the progress rail NOW, not on the next animation frame.
     *
     * `fadeOut()` starts the moment the host calls `finish()`, and the rail
     * has to leave with it: the exit is 180ms, so waiting for rAF spends up to
     * a tenth of it standing still and the bar reads as jumping to full rather
     * than closing. It also makes `progress()` agree with reality the instant
     * it is asked, instead of one frame later.
     */
    function latchExit() {
      if (chrome) chrome.paint(cursor, true);
    }

    /* --- skip on any input --- */
    var skipEvents = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    function onSkip(e) {
      // Modifier-only keypresses are someone reaching for a shortcut, not
      // someone dismissing a splash.
      if (e.type === 'keydown' && (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta')) return;
      beginOut(false);
    }
    function addSkipListeners() {
      // Armed under reduced motion too. The mark is held on screen there, and
      // "any input dismisses it" is not motion — refusing to listen just left
      // the host with no graceful way out.
      if (!skippable) return;
      skipEvents.forEach(function (n) {
        window.addEventListener(n, onSkip, { passive: true, capture: true });
      });
    }
    function removeSkipListeners() {
      skipEvents.forEach(function (n) {
        window.removeEventListener(n, onSkip, { capture: true });
      });
    }

    /* --- a context can die at any moment; swap renderers and keep going --- */
    function onContextLost(e) {
      e.preventDefault();
      if (destroyed) return;
      var wasPlaying = playing;
      try { renderer.destroy(); } catch (err) { /* already gone */ }
      renderer = createSVG(stage, opts);
      stage.appendChild(renderer.canvas);
      renderer.resize();
      draw(cursor);
      if (wasPlaying) play();
    }
    if (renderer.kind === 'webgl') {
      renderer.canvas.addEventListener('webglcontextlost', onContextLost, false);
    }

    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () {
        if (destroyed) return;
        // Order matters: the chrome's layout is what sets the mark box's size,
        // so it has to run before the renderer measures that box. The reverse
        // order left the drawing buffer one resize behind on every change.
        if (chrome) chrome.layout(false);
        renderer.resize();
        draw(cursor);
      });
      ro.observe(stage);
      // With the chrome on, `stage` is a fixed box driven by a custom property
      // — it cannot report a host resize, because it does not have one until
      // `layout()` gives it one. The layer is inset:0 on the host, so it does.
      if (chrome) ro.observe(layer);
    }

    /* --- getting the frame back after the compositor throws it away ---

       `preserveDrawingBuffer:true` (see createGL) is the actual fix for the
       blank-on-scroll-back bug. This is the belt to that pair of braces, and it
       earns its place for the cases the buffer flag cannot cover: a GPU that
       drops the backing store under memory pressure, a bfcache restore, and a
       tab that was hidden for long enough that rAF never delivered the frame
       the timeline was mid-way through.

       Note what these handlers deliberately do NOT do: suspend anything. Every
       one of them is a pure "draw the current cursor again" — there is no path
       here that can stop the animation, because a visibility hook that can
       suspend is how a splash ends up permanently blank in the first place. */
    function repaint() {
      if (destroyed) return;
      draw(cursor);
    }
    function onVisible() {
      if (destroyed) return;
      if (document.visibilityState !== 'hidden') repaint();
    }
    document.addEventListener('visibilitychange', onVisible, false);
    window.addEventListener('pageshow', repaint, false);

    var io = null;
    if (window.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        if (destroyed) return;
        for (var i = 0; i < entries.length; i++) {
          // Re-entry only. Leaving the viewport is not an event this code has
          // any business reacting to.
          if (entries[i].isIntersecting) { repaint(); return; }
        }
      });
      io.observe(stage);
    }

    function play() {
      if (destroyed || ending || reduced) return;
      playing = true;
      t0 = performance.now() - cursor;
      if (!raf) raf = requestAnimationFrame(frame);
    }
    function pause() {
      playing = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }
    /**
     * Non-finite input holds the current cursor rather than poisoning it.
     *
     * seek() repaints UNCONDITIONALLY — hidden tab, paused, ended, held, mid
     * fade-out, it does not matter. It is the documented way for a host to say
     * "put a frame on that surface right now", and during the blank-stage
     * investigation it was the first thing every reviewer reached for. If it
     * ever grows a "nothing to do" early-out, the recovery path goes with it.
     */
    function seek(t) {
      if (destroyed) return;
      pause();
      // Clamped to `seekMax`, not to `duration`: with the chrome on, the
      // timeline genuinely continues past the mark — one full loop of the tip
      // carousel — and a review rig that cannot reach it cannot review it.
      // Without the chrome, `seekMax === duration` and nothing changes.
      draw(clampT(t, seekMax, cursor));
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      clearCeiling();
      if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
      if (chrome) { chrome.destroy(); }
      if (live && live.parentNode) { live.parentNode.removeChild(live); }
      live = null;
      removeSkipListeners();
      if (ro) { ro.disconnect(); ro = null; }
      if (io) { io.disconnect(); io = null; }
      document.removeEventListener('visibilitychange', onVisible, false);
      window.removeEventListener('pageshow', repaint, false);
      if (renderer.kind === 'webgl') {
        renderer.canvas.removeEventListener('webglcontextlost', onContextLost, false);
      }
      try { renderer.destroy(); } catch (e) { /* nothing to clean */ }
      if (layer.parentNode) layer.parentNode.removeChild(layer);
      // Leave the host exactly as we found it.
      if (hostPositionPatched) { host.style.position = ''; hostPositionPatched = false; }
      if (window.__splash === api) delete window.__splash;
    }

    var api = {
      kind: renderer.kind,
      preset: presetName,
      theme: themeName,
      reducedMotion: reduced,
      duration: duration,
      out: OUT_MS,
      element: layer,

      play: play,
      pause: pause,
      seek: seek,
      /** The app calls this when it is ready. Whatever is left is compressed. */
      finish: function () { beginOut(false); },
      destroy: destroy,

      /**
       * Validate BEFORE assigning anything. The old order wrote `presetName`
       * and `duration` and only then threw inside evaluate() on a bad name,
       * leaving the instance permanently corrupted — every later rAF tick,
       * ResizeObserver callback and context-loss redraw threw too.
       */
      setPreset: function (name) {
        if (!hasPreset(name)) return false;
        presetName = name;
        duration = PRESETS[name].duration;
        api.preset = name;
        api.duration = duration;
        if (chrome) {
          chrome.setDuration(duration);
          seekMax = holding ? Math.max(duration, chrome.spanMs()) : duration;
        } else {
          seekMax = duration;
        }
        cursor = clampT(cursor, seekMax, 0);
        draw(cursor);
        return true;
      },
      setTheme: function (name) {
        themeName = resolveTheme(name);
        theme = THEMES[themeName];
        api.theme = themeName;
        if (chrome) chrome.applyTheme(themeName);
        draw(cursor);
      },
      /**
       * Hash of the rendered frame at `t`. On WebGL this is a strided FNV-1a
       * over a readPixels of the drawing buffer.
       *
       * It re-renders immediately before the read, and still does now that the
       * context preserves its drawing buffer — but for a different reason than
       * it used to. It is no longer "the buffer would be empty otherwise"; it
       * is that this call answers "what does frame t look like", which is a
       * question about t and not about whatever happens to be on the surface.
       * That is also exactly why frameHash CANNOT be used as a health probe:
       * it renders first, so it reports a healthy surface even when the live
       * one is blank. painted() is the call that reads without redrawing.
       *
       * Hashes are comparable within one page instance at one size, which is all
       * a seek-determinism proof needs: seek(t) twice, hash twice, compare.
       */
      frameHash: function (t) {
        if (destroyed) return 0;
        draw(clampT(t, duration, cursor));
        return renderer.readHash();
      },
      /** The evaluated timeline state at the current cursor. Read-only. */
      state: function () { return evaluate(presetName, cursor); },
      describe: function () { return describe(presetName); },
      /** Last render's cost in ms, for the review page's readout. */
      frameMs: function () { return lastFrameMs; },
      geometry: GEOM.diagnostics,
      /**
       * Which renderer is installed. This is NOT a health signal, and saying so
       * out loud is part of the fix: for the whole life of the blank-stage bug
       * this returned 'webgl' over a surface that was drawing nothing, and
       * three separate reviewers read that as "the renderer is fine" and looked
       * elsewhere. It was fine. It was also blank. Ask painted() for health.
       */
      renderer: function () { return renderer.kind; },

      /**
       * Does the surface actually have a frame on it at this instant?
       *
       * Deliberately reads the drawing buffer WITHOUT redrawing first, which is
       * the one thing frameHash() cannot do for you — frameHash renders before
       * it reads, so it always reports a healthy-looking surface even when the
       * live one is empty. If this returns false while the splash is supposed
       * to be on screen, the host is looking at a blank stage.
       *
       * SVG is retained-mode and cannot go blank this way, so it answers true.
       */
      painted: function () {
        if (destroyed) return false;
        var n = renderer.litCount();
        return n < 0 || n > 0;
      },
      /** Raw sampled lit-pixel count; -1 where the question does not apply. */
      litPixels: function () { return destroyed ? 0 : renderer.litCount(); },

      /* --- the holding surface -------------------------------------
         All four of these are host-level actions, not per-frame ones: they
         move a single integer offset that `paint()` then reads. Nothing here
         puts state into the render path, so `seek(t)` stays reproducible and
         `frameHash` keeps meaning what it means. */

      /** Is the boot-screen layout present at all? */
      chrome: !!chrome,
      /**
       * Is this instance past its intro and waiting on the host?
       *
       * Reduced motion reaches the same state by a different road: it ends and
       * HOLDS at mount, so `ending` is true there from the first frame while
       * the splash sits on screen waiting for `finish()` exactly like any
       * other hold. Reporting false would tell a host that a splash it can
       * plainly see is not there.
       */
      holding: function () {
        if (destroyed || !holding) return false;
        if (reduced) return held;
        return !ending && cursor >= duration;
      },
      tipCount: chrome ? chrome.tips.length : 0,
      /** Index into `tips` of whatever is on screen right now. */
      tipIndex: function () { return chrome ? chrome.tipIndex(cursor) : -1; },
      /** Advance one tip without waiting out the 3.4s. */
      nextTip: function () { return chrome ? chrome.nextTip(cursor) : -1; },
      /** Put a specific tip up. Out-of-range indices wrap. */
      showTip: function (i) {
        return chrome && isFinite(i) ? chrome.showTip(i, cursor) : -1;
      },
      /** 0..1. Asymptotic while guessing; exactly 1 once finish() has fired. */
      progress: function () { return chrome ? chrome.progress(cursor) : (ending ? 1 : 0); },
    };

    if (opts.debugHandle !== false) window.__splash = api;

    // Armed in BOTH modes. Gating this on `!reduced` was the other half of the
    // reduced-motion exit bug: addSkipListeners had been fixed to allow it and
    // the call site still refused to call it.
    addSkipListeners();
    if (!reduced) {
      draw(0);
      if (opts.autoplay !== false) play();
    }

    return api;
  }

  /* ================================================================
     10. PUBLIC SURFACE
     ================================================================ */

  return {
    version: '1.1.0',
    mount: mount,
    presets: Object.keys(PRESETS),
    describe: describe,
    themes: THEMES,
    /** The default tip copy, so a host can extend it rather than replace it. */
    tips: TIPS,
    brand: BRAND,
    geometry: GEOM.diagnostics,
    seenKey: SEEN_KEY,
    seenWindowMs: SEEN_WINDOW_MS,
    /** The review harness needs to replay; the app never calls this. */
    reset: function (key) { clearStore(typeof key === 'string' ? key : SEEN_KEY); },
    /**
     * Re-derives the handoff a second, genuinely independent way — see the
     * TANGENCY note. Lazy, because it costs a dense resample of the cubics and
     * nothing in the render needs it.
     */
    verifyHandoff: verifyHandoff,
    /**
     * Exposed so the review pages can draw the timeline from the real curve,
     * and so `checks.html` can rasterise the same two paths independently and
     * assert the render covers their union.
     */
    _internals: {
      evaluate: evaluate, feed: feed, feedInverse: feedInverse,
      PRESETS: PRESETS, GEOM: GEOM,
      PATHS: MARK.loops.map(function (l) { return l.d; }),
      MARK: MARK,
    },
  };
})();

export default PlaSpoolSplash;
