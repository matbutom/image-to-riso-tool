/*
  separation.js — colour → ink coverage.

  auto: every colour is matched to a stack of the chosen inks, predicted the
  way the preview and the riso print it (inks multiplied over paper). Solved
  once per ink set on a 17³ RGB grid and trilinearly interpolated per pixel, so
  coverage is continuous (no 10 % steps) and neighbouring tones get
  neighbouring ink stacks (no jumps between equivalent mixes in the shadows).

  cmyk: per-pixel CMYK with a guard for pure black, and no black generation
  when no layer prints K (otherwise CMY would drop out of the shadows).

  Plain JS, no p5: works in the browser (window.RisoSep) and in node for tests.
*/

(function (root) {
  const LUT_N = 17; // grid nodes per RGB axis
  // Matching weights. Tone wins over hue: few inks can't hit every hue, but the
  // shadows / midtones must keep their lightness so the image reads.
  const L_WEIGHT = 3;
  const C_WEIGHT = 0.5;
  const INK_PENALTY = 6; // ΔE² cost of +100 % ink: among near-equal mixes take the lightest stack
  const SMOOTH = 400; // ΔE² cost of a full-ink jump from the neighbouring grid nodes
  const RELAX_PASSES = 2; // extra passes pulling every node towards its 6 neighbours

  // ── colour ──────────────────────────────────────

  const lin = (v) => {
    v /= 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  // sRGB (0..255, may be fractional) → CIE Lab D65, written into out
  function lab(r, g, b, out) {
    r = lin(r);
    g = lin(g);
    b = lin(b);
    const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
    const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
    const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    out[0] = 116 * y - 16;
    out[1] = 500 * (x - y);
    out[2] = 200 * (y - z);
    return out;
  }

  // ── auto: ink LUT ──────────────────────────────

  // Overprint of `cov` (0..1 per ink) on white, multiplied like the preview/export
  function mixLab(inks, cov, out) {
    let r = 255;
    let g = 255;
    let b = 255;
    for (let i = 0; i < inks.length; i++) {
      const a = cov[i];
      r *= 1 - a + a * inks[i][0];
      g *= 1 - a + a * inks[i][1];
      b *= 1 - a + a * inks[i][2];
    }
    return lab(r, g, b, out);
  }

  function makeCost(inks) {
    const m = [0, 0, 0];
    return function cost(t, cov, prev) {
      mixLab(inks, cov, m);
      const dl = (m[0] - t[0]) * L_WEIGHT;
      const da = (m[1] - t[1]) * C_WEIGHT;
      const db = (m[2] - t[2]) * C_WEIGHT;
      let sum = 0;
      let jump = 0;
      for (let i = 0; i < cov.length; i++) {
        sum += cov[i];
        if (prev) jump += (cov[i] - prev[i]) ** 2;
      }
      return dl * dl + da * da + db * db + INK_PENALTY * sum + SMOOTH * jump;
    };
  }

  // Coarse grid of ink stacks for the first guess
  function candidates(k) {
    const step = k <= 2 ? 0.05 : k === 3 ? 0.1 : 0.125;
    const levels = [];
    for (let v = 0; v <= 1 + 1e-9; v += step) levels.push(Math.min(1, v));
    let combos = [[]];
    for (let i = 0; i < k; i++) combos = combos.flatMap((c) => levels.map((v) => c.concat(v)));
    return combos;
  }

  // Local refinement on continuous coverage (coordinate descent)
  function refine(cost, t, cov, prev) {
    let best = cost(t, cov, prev);
    for (const d of [0.06, 0.03, 0.015, 0.0075, 0.004]) {
      for (let it = 0, moved = true; moved && it < 12; it++) {
        moved = false;
        for (let i = 0; i < cov.length; i++) {
          const keep = cov[i];
          for (const s of [d, -d]) {
            const v = Math.min(1, Math.max(0, keep + s));
            if (v === keep) continue;
            cov[i] = v;
            const c = cost(t, cov, prev);
            if (c < best) {
              best = c;
              moved = true;
              break;
            }
            cov[i] = keep;
          }
          if (moved) break;
        }
      }
    }
    return cov;
  }

  const lutCache = new Map();
  const NEIGHBOURS = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  // inks: [[r,g,b] 0..255]. Returns { k, data: Float32Array(N³·k) } indexed [((r·N+g)·N+b)·k + ink]
  function buildLUT(inksRgb) {
    const key = inksRgb.map((c) => c.join(",")).join("|");
    if (lutCache.has(key)) return lutCache.get(key);

    const k = inksRgb.length;
    const inks = inksRgb.map((c) => c.map((v) => v / 255));
    const cost = makeCost(inks);
    const N = LUT_N;
    const data = new Float32Array(N * N * N * k);

    // Black point compensation: the image's black maps to the darkest stack
    // these inks can print (all inks at 100 %), paper stays paper.
    const full = new Array(k).fill(1);
    const Lmin = mixLab(inks, full, [0, 0, 0])[0];

    const combos = candidates(k);
    const comboLab = combos.map((c) => mixLab(inks, c, [0, 0, 0]));
    const comboSum = combos.map((c) => c.reduce((s, v) => s + v, 0));

    const t = [0, 0, 0];
    const at = (r, g, b) => ((r * N + g) * N + b) * k;
    for (let r = 0; r < N; r++) {
      for (let g = 0; g < N; g++) {
        let prev = null; // previous node along b, to keep stacks continuous
        for (let b = 0; b < N; b++) {
          const s = 255 / (N - 1);
          lab(r * s, g * s, b * s, t);
          t[0] = Lmin + (t[0] * (100 - Lmin)) / 100;

          // Neighbour solutions already solved (along r and g) also pull towards continuity
          const anchor = prev ? prev.slice() : null;
          if (anchor) {
            const nb = [];
            if (r > 0) nb.push(at(r - 1, g, b));
            if (g > 0) nb.push(at(r, g - 1, b));
            for (const o of nb) for (let i = 0; i < k; i++) anchor[i] += data[o + i];
            for (let i = 0; i < k; i++) anchor[i] /= nb.length + 1;
          }

          let bi = 0;
          let bc = Infinity;
          for (let c = 0; c < combos.length; c++) {
            const m = comboLab[c];
            const dl = (m[0] - t[0]) * L_WEIGHT;
            const da = (m[1] - t[1]) * C_WEIGHT;
            const db = (m[2] - t[2]) * C_WEIGHT;
            let v = dl * dl + da * da + db * db + INK_PENALTY * comboSum[c];
            if (anchor) {
              let j = 0;
              for (let i = 0; i < k; i++) j += (combos[c][i] - anchor[i]) ** 2;
              v += SMOOTH * j;
            }
            if (v < bc) {
              bc = v;
              bi = c;
            }
          }

          const cov = refine(cost, t, combos[bi].slice(), anchor);
          data.set(cov, at(r, g, b));
          prev = cov;
        }
      }
    }

    // Relaxation: re-solve each node from where it is, anchored to the mean of
    // its 6 neighbours, so stacks change gradually across the whole cube
    const anchor = new Array(k);
    for (let pass = 0; pass < RELAX_PASSES; pass++) {
      for (let r = 0; r < N; r++) {
        for (let g = 0; g < N; g++) {
          for (let b = 0; b < N; b++) {
            const s = 255 / (N - 1);
            lab(r * s, g * s, b * s, t);
            t[0] = Lmin + (t[0] * (100 - Lmin)) / 100;
            anchor.fill(0);
            let nb = 0;
            for (const [dr, dg, db] of NEIGHBOURS) {
              const rr = r + dr;
              const gg = g + dg;
              const bb = b + db;
              if (rr < 0 || gg < 0 || bb < 0 || rr >= N || gg >= N || bb >= N) continue;
              const o = at(rr, gg, bb);
              for (let i = 0; i < k; i++) anchor[i] += data[o + i];
              nb++;
            }
            for (let i = 0; i < k; i++) anchor[i] /= nb;
            const o = at(r, g, b);
            const cov = refine(cost, t, Array.from(data.subarray(o, o + k)), anchor);
            data.set(cov, o);
          }
        }
      }
    }

    const lut = { k, data, Lmin };
    lutCache.set(key, lut);
    return lut;
  }

  // RGBA pixels → one Uint8ClampedArray per ink (255 = full ink), trilinear on the LUT.
  // wanted(i) = false leaves that ink's map null (export of hidden layers).
  function autoInkMaps(px, n, inksRgb, wanted = () => true) {
    const { k, data } = buildLUT(inksRgb);
    return lutInkMaps(px, n, data, k, LUT_N, wanted);
  }

  // Trilinear lookup of an N³ RGB grid holding k coverages per node (0..1)
  function lutInkMaps(px, n, data, k, N, wanted) {
    const S = (N - 1) / 255;
    const maps = [];
    const idx = [];
    for (let i = 0; i < k; i++) {
      if (wanted(i)) {
        maps[i] = new Uint8ClampedArray(n);
        idx.push(i);
      } else maps[i] = null;
    }
    const sR = N * N * k;
    const sG = N * k;
    const sB = k;
    for (let q = 0, p = 0; q < n; q++, p += 4) {
      const fr = px[p] * S;
      const fg = px[p + 1] * S;
      const fb = px[p + 2] * S;
      const r0 = Math.min(N - 2, fr | 0);
      const g0 = Math.min(N - 2, fg | 0);
      const b0 = Math.min(N - 2, fb | 0);
      const dr = fr - r0;
      const dg = fg - g0;
      const db = fb - b0;
      const base = r0 * sR + g0 * sG + b0 * sB;
      for (const i of idx) {
        const o = base + i;
        const c00 = data[o] + (data[o + sB] - data[o]) * db;
        const c01 = data[o + sG] + (data[o + sG + sB] - data[o + sG]) * db;
        const c10 = data[o + sR] + (data[o + sR + sB] - data[o + sR]) * db;
        const c11 = data[o + sR + sG] + (data[o + sR + sG + sB] - data[o + sR + sG]) * db;
        const c0 = c00 + (c01 - c00) * dg;
        const c1 = c10 + (c11 - c10) * dg;
        maps[i][q] = (c0 + (c1 - c0) * dr) * 255 + 0.5;
      }
    }
    return maps;
  }

  // ── auto · reassign: image colours → chosen inks ──

  /*
    Instead of approximating every colour with a mix, the image's main colours
    are each sent to ONE ink. Colours that clearly match an ink stay on it;
    the rest go to the inks that are left, lightest colour to lightest ink.
    Every pixel then prints its colour's ink at a strength given by how dark
    it is relative to that colour (the pure colour = 100 %).
  */
  const REMAP_MATCH_DE = 30; // a colour this close to an ink keeps that ink
  const REMAP_FREE_BONUS = 12; // lightness (L*) advantage of an ink no colour uses yet (greys, blacks)
  const REMAP_NEUTRAL_C = 15; // chroma under this = grey / black / brown-ish neutral
  const REMAP_SIGMA = 16; // softness of the blend between neighbouring colours (ΔE)
  const REMAP_PAPER_SIGMA = 6; // the paper only pulls near-white pixels (no halos at colour edges)
  const REMAP_MIN_SHARE = 0.01; // colours under 1 % of the inked area (paper excluded) are merged away
  const REMAP_LUT_N = 33;
  const PAPER_LAB = [100, 0, 0];

  const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const isPaper = (c) => c[0] > 92 && Math.hypot(c[1], c[2]) < 10;

  // Main colours of an image: k-means in Lab on a sample, near-white left out.
  // Returns [{ lab, rgb, share }] sorted from light to dark.
  function extractPalette(px, n, maxColors) {
    const step = Math.max(1, Math.floor(n / 20000));
    const pts = [];
    const rgbs = [];
    let paper = 0;
    for (let q = 0; q < n; q += step) {
      const p = q * 4;
      const c = lab(px[p], px[p + 1], px[p + 2], [0, 0, 0]);
      if (isPaper(c)) {
        paper++;
        continue;
      }
      pts.push(c);
      rgbs.push([px[p], px[p + 1], px[p + 2]]);
    }
    // shares are measured on what carries ink: a sheet that is mostly paper
    // (flipbooks, zines) must not hide a small but important colour
    const total = pts.length;
    if (!pts.length) return [];

    // deterministic farthest-point seeds, starting from the darkest sample
    const K = Math.min(maxColors, pts.length);
    let first = 0;
    pts.forEach((c, i) => {
      if (c[0] < pts[first][0]) first = i;
    });
    const centers = [pts[first].slice()];
    const dmin = pts.map((c) => dE(c, centers[0]));
    while (centers.length < K) {
      let far = 0;
      for (let i = 1; i < pts.length; i++) if (dmin[i] > dmin[far]) far = i;
      if (dmin[far] < 6) break; // no more distinct colours
      centers.push(pts[far].slice());
      for (let i = 0; i < pts.length; i++) dmin[i] = Math.min(dmin[i], dE(pts[i], pts[far]));
    }

    const assign = new Int32Array(pts.length);
    for (let it = 0; it < 12; it++) {
      const sum = centers.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < pts.length; i++) {
        let best = 0;
        let bd = Infinity;
        for (let c = 0; c < centers.length; c++) {
          const d = dE(pts[i], centers[c]);
          if (d < bd) {
            bd = d;
            best = c;
          }
        }
        assign[i] = best;
        const s = sum[best];
        s[0] += pts[i][0];
        s[1] += pts[i][1];
        s[2] += pts[i][2];
        s[3]++;
      }
      centers.forEach((c, i) => {
        if (sum[i][3]) for (let j = 0; j < 3; j++) c[j] = sum[i][j] / sum[i][3];
      });
    }

    // representative sRGB of each colour + share; drop tiny ones
    const out = centers.map((c) => ({ lab: c, rgbSum: [0, 0, 0], count: 0 }));
    for (let i = 0; i < pts.length; i++) {
      const o = out[assign[i]];
      o.count++;
      for (let j = 0; j < 3; j++) o.rgbSum[j] += rgbs[i][j];
    }
    return out
      .filter((o) => o.count / total >= REMAP_MIN_SHARE && !isPaper(o.lab))
      .map((o) => ({
        lab: o.lab,
        rgb: o.rgbSum.map((v) => Math.round(v / o.count)),
        share: o.count / total,
      }))
      .sort((a, b) => b.lab[0] - a.lab[0]);
  }

  // Which ink each palette colour goes to: [{ ink (index into inksRgb), matched }]
  function planRemap(palette, inksRgb) {
    const inkLab = inksRgb.map((c) => lab(c[0], c[1], c[2], [0, 0, 0]));
    const plan = palette.map(() => ({ ink: -1, matched: false }));
    const used = new Set();

    // 1. colours that clearly match an ink keep it
    palette.forEach((c, i) => {
      let best = -1;
      let bd = Infinity;
      inkLab.forEach((l, j) => {
        const d = dE(c.lab, l);
        if (d < bd) {
          bd = d;
          best = j;
        }
      });
      if (best >= 0 && bd < REMAP_MATCH_DE) {
        plan[i] = { ink: best, matched: true };
        used.add(best);
      }
    });

    // 2. the rest, biggest first, go to the ink closest in lightness (light
    //    colours → light inks, dark → dark), preferring inks nobody uses yet:
    //    a yellow with no yellow ink lands on the lightest free ink. Colourful
    //    leftovers always take a free ink first, so different colours of the
    //    image stay on different inks (a light blue next to a pink doesn't
    //    collapse onto the pink); greys and blacks just follow lightness.
    const rest = palette
      .map((c, i) => i)
      .filter((i) => plan[i].ink < 0)
      .sort((a, b) => palette[b].share - palette[a].share);
    rest.forEach((i) => {
      let best = 0;
      let bc = Infinity;
      inkLab.forEach((l, j) => {
        const colourful = Math.hypot(palette[i].lab[1], palette[i].lab[2]) >= REMAP_NEUTRAL_C;
        const bonus = used.has(j) ? 0 : colourful ? 100 : REMAP_FREE_BONUS;
        const cost = Math.abs(l[0] - palette[i].lab[0]) - bonus;
        if (cost < bc) {
          bc = cost;
          best = j;
        }
      });
      plan[i] = { ink: best, matched: false };
      used.add(best);
    });
    return plan;
  }

  const remapCache = new Map();

  function buildRemapLUT(inksRgb, palette, plan) {
    const key = JSON.stringify([inksRgb, palette.map((c) => c.lab.map((v) => v.toFixed(1))), plan]);
    if (remapCache.has(key)) return remapCache.get(key);
    const k = inksRgb.length;
    const N = REMAP_LUT_N;
    const data = new Float32Array(N * N * N * k);
    // Strength reference: a matched colour prints 100 % at its own tone;
    // re-assigned colours sharing an ink are graded so the darkest of them
    // is 100 % and lighter ones lighter (yellow and blue on one pink stay
    // apart). A colour alone on its ink also prints 100 %.
    const refL = palette.map((c, i) => {
      if (plan[i].matched) return c.lab[0];
      let L = c.lab[0];
      palette.forEach((o, j) => {
        if (!plan[j].matched && plan[j].ink === plan[i].ink) L = Math.min(L, o.lab[0]);
      });
      return L;
    });
    // anchors: every palette colour plus the paper, which prints no ink
    const anchors = palette.map((c, i) => ({ lab: c.lab, ink: plan[i].ink, refL: refL[i] }));
    anchors.push({ lab: PAPER_LAB, ink: -1, refL: 100, sigma: REMAP_PAPER_SIGMA });
    const t = [0, 0, 0];
    const s = 255 / (N - 1);
    const w = new Float64Array(anchors.length);
    for (let r = 0; r < N; r++) {
      for (let g = 0; g < N; g++) {
        for (let b = 0; b < N; b++) {
          lab(r * s, g * s, b * s, t);
          let wsum = 0;
          anchors.forEach((a, i) => {
            const d = dE(t, a.lab);
            const sg = a.sigma || REMAP_SIGMA;
            w[i] = Math.exp(-(d * d) / (2 * sg * sg)) + 1e-12;
            wsum += w[i];
          });
          const o = ((r * N + g) * N + b) * k;
          anchors.forEach((a, i) => {
            if (a.ink < 0) return;
            // strength: how dark this pixel is relative to its colour's reference
            const strength = Math.min(1, Math.max(0, (100 - t[0]) / Math.max(4, 100 - a.refL)));
            data[o + a.ink] += (w[i] / wsum) * strength;
          });
          for (let i = 0; i < k; i++) data[o + i] = Math.min(1, data[o + i]);
        }
      }
    }
    const lut = { k, data };
    if (remapCache.size > 8) remapCache.clear();
    remapCache.set(key, lut);
    return lut;
  }

  function remapInkMaps(px, n, inksRgb, palette, plan, wanted = () => true) {
    const { k, data } = buildRemapLUT(inksRgb, palette, plan);
    return lutInkMaps(px, n, data, k, REMAP_LUT_N, wanted);
  }

  // ── cmyk ───────────────────────────────────────

  // channel: 0 c, 1 m, 2 y, 3 k. useK = false skips black generation.
  function cmykInkMap(px, n, channel, useK) {
    const out = new Uint8ClampedArray(n);
    for (let q = 0, p = 0; q < n; q++, p += 4) {
      const r = px[p] / 255;
      const g = px[p + 1] / 255;
      const b = px[p + 2] / 255;
      let v;
      if (!useK) {
        v = channel === 0 ? 1 - r : channel === 1 ? 1 - g : channel === 2 ? 1 - b : 0;
      } else {
        const k = 1 - Math.max(r, g, b);
        if (channel === 3) v = k;
        else if (k >= 1) v = 0; // pure black: K only
        else v = (1 - (channel === 0 ? r : channel === 1 ? g : b) - k) / (1 - k);
      }
      out[q] = v * 255 + 0.5;
    }
    return out;
  }

  root.RisoSep = { buildLUT, autoInkMaps, cmykInkMap, lab, mixLab, LUT_N, extractPalette, planRemap, remapInkMaps };
})(typeof window !== "undefined" ? window : globalThis);
