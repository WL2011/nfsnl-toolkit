/* Exact minimum-cost upgrade route through every PR lock of a special event (2026-11-27).
 *
 * Model (same part / material data as Codex's SECalc):
 *  - each of the six parts climbs its own chain: fill any subset of a level's material slots; a level can only be
 *    rebuilt into the next one after all its slots are filled, the rebuild fee is paid and the star level allows it;
 *  - part value = lo + (hi-lo)*min(1, sum of filled slot weights); axis stat = project(curve of that star, partA+partB);
 *  - a lock is passed when the three axis stats are each >= one safe reference point of the same car card whose PR
 *    (PRTimeCurve of the race's difficulty time) is >= the lock (stats never lower PR, so this is conservative);
 *  - materials received before a lock are free; everything else is bought at the event shop price; material bought
 *    earlier is not refunded, so purchase of material m = max over locks of (needed by then - free by then);
 *  - cost('total') = shop purchases + fit fees + rebuild fees of the final state; cost('shop') = shop purchases only.
 *
 * Exactness: for a part, fix the final state F and the purchase totals B. Then at every lock the best reachable state
 * (highest value, <= F, affordable with free+B, star allowed) is unique up to ties and these states form a valid chain,
 * so every route is dominated by one built this way. We enumerate (F, B) per part, keep the Pareto set over
 * (cost, value at every lock), then pair the two parts of each axis with branch and bound. Axes are independent unless
 * two parts share a material (flagged) or a lock has several reference points (all assignments enumerated).
 */
const SERoute = (() => {
  const AX = ['Speed', 'Acceleration', 'Nitro'];
  const EPS = 1e-9;

  function project(c, x) {
    if (x <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) { const [x1, y1] = c[i], [x0, y0] = c[i - 1]; if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
    return c.at(-1)[1];
  }
  // smallest part sum whose projected stat reaches t (stat stored as an integer target)
  function need(c, t) {
    if (c[0][1] + 1e-7 >= t) return -Infinity;
    if (c.at(-1)[1] + 1e-7 < t) return Infinity;
    for (let i = 1; i < c.length; i++) {
      const [x1, y1] = c[i], [x0, y0] = c[i - 1];
      if (y1 + 1e-7 >= t) return y1 === y0 ? x0 : x0 + (x1 - x0) * Math.max(0, (t - 1e-7 - y0)) / (y1 - y0);
    }
    return Infinity;
  }
  // minimal points (no other point is <= in all three stats); a dominating point always has a smaller or equal sum
  const pareto = p => {
    const o = p.slice().sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2])), keep = [];
    for (const t of o) if (!keep.some(u => u[0] <= t[0] && u[1] <= t[1] && u[2] <= t[2])) keep.push(t);
    return keep;
  };

  /* ---------- PR references for one lock ----------
   * kind 'sample': a real race reference of the same car card with PR >= lock (dominating it can only raise PR);
   * kind 'scaled': a reference within +-45 PR scaled along its own direction until the car's fitted PR-time curve,
   *   anchored at that reference's real PR, reaches the lock + 1 (scale 0.97..1.03, rising curve, well-fitting cars only);
   * kind 'guide': the lock race's recommended stats when nothing else exists (NOT guaranteed, flagged). */
  function prOfTime(PT, t) {
    if (t <= PT[0][0]) return PT[0][1];
    for (let i = 1; i < PT.length; i++) { const [x1, y1] = PT[i], [x0, y0] = PT[i - 1]; if (t <= x1) return y0 + (y1 - y0) * (t - x0) / (x1 - x0); }
    return PT.at(-1)[1];
  }
  function modelPR(m, PT, st) {
    const L = st.map(Math.log), f = [1, ...L]; for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) f.push(L[i] * L[j]);
    return prOfTime(PT, f.reduce((a, x, i) => a + x * m.c[i], 0));
  }
  function lockTargets(data, cid, g, opts) {
    const refs = (data.refs || {})[cid] || [], m = (data.prm || {})[cid], PT = data.prtime;
    const out = [];
    for (const p of refs) if (p[3] >= g.wall) out.push([p[0], p[1], p[2], p[3], 'sample']);
    if (m && PT && m.cv <= (opts.maxCV || 0.03) && !opts.samplesOnly) {
      for (const p of refs) {
        if (Math.abs(p[3] - g.wall) > 25) continue;
        const s = p.slice(0, 3), base = modelPR(m, PT, s), want = g.wall + 1 - p[3];
        const at = lam => modelPR(m, PT, s.map(x => x * lam)) - base;
        // stay local (within 3 % of a real reference) and only where the fitted curve rises with the stats
        let lo = 0.97, hi = 1.03;
        const grid = [0.97, 0.98, 0.99, 1, 1.01, 1.02, 1.03].map(at);
        if (grid.some((v, i) => i && v <= grid[i - 1])) continue;
        if (at(hi) < want) continue;
        if (at(lo) >= want) { out.push([...s.map(x => Math.ceil(x * lo)), g.wall, 'scaled']); continue; }
        for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (at(mid) >= want) hi = mid; else lo = mid; }
        out.push([...s.map(x => Math.ceil(x * hi)), g.wall, 'scaled']);
      }
    }
    // kind 'trade': the fitted PR estimate is a combined score, so a lock can be passed with one stat below the
    // reference and another above it. For the references nearest the lock, sweep the other two stats over +-R and
    // solve the remaining one so that the estimate (anchored at that reference's real PR) reaches lock + 0.5.
    // Only inside +-R of a real reference (real guide builds sit within ~5 %) and only where the curve rises in
    // every stat. Checked against 178 community builds that are known to pass.
    if (m && PT && m.cv <= (opts.maxCV || 0.03) && !opts.samplesOnly && opts.trade !== false) {
      const Rr = opts.tradeRange ?? 0.06, n = opts.tradeSteps ?? 25, steps = Array.from({ length: n }, (_, i) => -Rr + 2 * Rr * i / (n - 1));
      const near = refs.filter(p => Math.abs(p[3] - g.wall) <= 25).sort((a, b) => Math.abs(a[3] - g.wall) - Math.abs(b[3] - g.wall)).slice(0, opts.tradeRefs ?? 12);
      const rising = x => [0, 1, 2].every(j => { const y = x.slice(); y[j] *= 1.005; return modelPR(m, PT, y) > modelPR(m, PT, x); });
      for (const p of near) {
        const s = p.slice(0, 3), base = modelPR(m, PT, s), want = g.wall + (opts.tradeMargin ?? 0.5) - p[3];
        for (let j = 0; j < 3; j++) {
          const [a, b] = [0, 1, 2].filter(x => x !== j);
          for (const da of steps) for (const db of steps) {
            const x = s.slice(); x[a] = s[a] * (1 + da); x[b] = s[b] * (1 + db);
            const f = v => { x[j] = v; return modelPR(m, PT, x) - base; };
            let lo = s[j] * (1 - Rr), hi = s[j] * (1 + Rr);
            if (f(hi) < want) continue;
            if (f(lo) < want) { for (let it = 0; it < 22; it++) { const mid = (lo + hi) / 2; if (f(mid) >= want) hi = mid; else lo = mid; } x[j] = hi; } else x[j] = lo;
            if (!rising(x)) continue;
            out.push([...x.map(v => Math.ceil(v)), g.wall, 'trade']);
          }
        }
      }
    }
    let t = pareto(out);
    // thin near-duplicates of the combined-PR sweep: drop a point when a kept one is at most eps higher in every
    // stat (changes the requirement by well under 1 PR, far below the estimate's own error)
    const eps = opts.thin ?? 0;
    if (eps > 0 && t.length > 60) {
      const keep = [];
      for (const x of t) if (x[4] !== 'trade' || !keep.some(u => u[0] <= x[0] * (1 + eps) && u[1] <= x[1] * (1 + eps) && u[2] <= x[2] * (1 + eps))) keep.push(x);
      t = keep;
    }
    // fallback when even a fully upgraded car (at this lock's star) cannot reach any reference in every stat:
    // these are "max the car out" locks. Estimate the fully upgraded PR with the fitted curve anchored at the
    // nearest reference (within 3 %); if it reaches the lock, the target is "everything installed".
    const top = opts.top;
    if (top && !t.some(x => x.slice(0, 3).every((v, j) => v <= top[j] + 1e-6)) && m && PT && m.cv <= (opts.maxCV || 0.03) && !opts.samplesOnly) {
      const dist = p => Math.max(...[0, 1, 2].map(j => Math.abs(Math.log(p[j] / top[j]))));
      const near = refs.filter(p => Math.abs(p[3] - g.wall) <= 45).sort((x, y) => dist(x) - dist(y))[0];
      if (near && dist(near) <= 0.03) {
        const est = near[3] + modelPR(m, PT, top) - modelPR(m, PT, near.slice(0, 3));
        if (est >= g.wall - 0.5) t = [[...top.map(v => v - 1e-6), Math.round(est), 'max']];
      }
    }
    if (!t.length && g.guide && g.guide.every(x => x > 0)) t = [[...g.guide, g.guidePR ?? null, 'guide']];
    return t;
  }
  // best stats the car can reach at a lock if every allowed upgrade were installed (ignores materials)
  function topStats(L, cs, star) {
    const best = L.map(l => { let v = 0; for (let lv = 0; lv < l.length; lv++) { let ok = true; for (let x = 0; x < lv; x++) if (!l[x].canUp || star < l[x].star) ok = false; if (ok) v = Math.max(v, l[lv].hi, l[lv].lo); } return v; });
    return AX.map((a, j) => project(cs[j], L.reduce((s, l, i) => s + (l[0].attr === a ? best[i] : 0), 0)));
  }

  /* ---------- one part ---------- */
  function chain(nodes, stock, cur) {
    const L = []; let id = stock; const seen = new Set();
    let base = {}, fit = 0, rebuild = 0;
    while (id && !seen.has(id)) {
      seen.add(id); const n = nodes[id]; if (!n) break;
      const slots = n.slots.map((s, i) => ({ i, m: s[0], c: s[1], w: s[2], fee: s[3], ok: s[3] != null && s[4] === cur }));
      const canUp = !!(n.next && nodes[n.next] && n.slots.length && n.fee != null && n.currency === cur && slots.every(s => s.ok));
      L.push({ id, lo: n.lo, hi: n.hi, slots, canUp, star: n.q === n.potential ? n.q : n.q + 1, upFee: n.fee, base: { ...base }, fit, rebuild, attr: n.attr });
      if (!canUp) break;
      for (const s of slots) { base[s.m] = (base[s.m] || 0) + s.c; fit += s.fee; }
      rebuild += n.fee; id = n.next;
    }
    return L;
  }
  // slots of a level sorted best-first per material (same material always has the same count per slot)
  function order(lv) {
    const by = {};
    for (const s of lv.slots) if (s.ok) (by[s.m] = by[s.m] || []).push(s);
    for (const m in by) by[m].sort((a, b) => b.w - a.w || a.fee - b.fee || a.i - b.i);
    return by;
  }
  function stateOf(L, lv, mask) {
    const l = L[lv]; let w = 0, fit = l.fit; const req = { ...l.base };
    for (const s of l.slots) if (mask & (1 << s.i)) { w += s.w; fit += s.fee; req[s.m] = (req[s.m] || 0) + s.c; }
    return { lv, mask, value: l.lo + (l.hi - l.lo) * Math.min(1, w), req, fees: fit + l.rebuild };
  }
  // all distinct final states: per level, for each material take the k best slots (k = 0..n)
  function finals(L, ords) {
    const out = [];
    L.forEach((l, lv) => {
      const groups = Object.values(ords[lv]); let masks = [0];
      for (const g of groups) { const next = []; for (const m of masks) { let add = 0; next.push(m); for (const s of g) { add |= 1 << s.i; next.push(m | add); } } masks = next; }
      for (const m of masks) out.push(stateOf(L, lv, m));
    });
    return out;
  }
  const fits = (req, R) => { for (const m in req) if (req[m] > (R[m] || 0) + EPS) return false; return true; };
  // best state <= cap reachable with material budget R and star level
  function best(L, ords, cap, R, star) {
    let top = 0;
    while (top < cap.lv && L[top].canUp && star >= L[top].star && fits(L[top + 1].base, R)) top++;
    let bestS = null;
    for (let lv = 0; lv <= top; lv++) {
      let mask = 0;
      if (lv < top) { for (const s of L[lv].slots) mask |= 1 << s.i; }
      else {
        const left = {}; for (const m in R) left[m] = R[m] - (L[lv].base[m] || 0);
        for (const m in ords[lv]) { let have = left[m] || 0; for (const s of ords[lv][m]) { if (lv === cap.lv && !(cap.mask & (1 << s.i))) continue; if (s.c <= have + EPS) { mask |= 1 << s.i; have -= s.c; } else break; } }
      }
      const st = stateOf(L, lv, mask);
      if (!bestS || st.value > bestS.value + EPS || (Math.abs(st.value - bestS.value) <= EPS && lv >= bestS.lv)) bestS = st;
    }
    return bestS;
  }

  /* ---------- candidates per part ---------- */
  function partCandidates(L, gates, prices, extra, mode, limit) {
    const ords = L.map(order), G = gates.length, mats = new Set();
    L.forEach(l => l.slots.forEach(s => mats.add(s.m)));
    const M = [...mats];
    const freeAt = g => { const f = {}; for (const m of M) f[m] = (gates[g].free[m] || 0) + (g === G - 1 ? (extra[m] || 0) : 0); return f; };
    const F = gates.map((_, g) => freeAt(g));
    const out = new Map(); let truncated = false;
    for (const cap of finals(L, ords)) {
      // star must allow the cap at the last lock; purchases bounded by what the cap needs
      const lo = {}, hi = {}; let ok = true;
      for (const m of M) {
        const r = cap.req[m] || 0; lo[m] = Math.max(0, r - F[G - 1][m]);
        hi[m] = Math.max(0, ...F.map(f => r - f[m]));
        if (prices[m] == null) { if (lo[m] > 0) ok = false; hi[m] = 0; }
      }
      if (!ok) continue;
      let count = 1; for (const m of M) count *= hi[m] - lo[m] + 1;
      if (count > limit) { truncated = true; for (const m of M) lo[m] = hi[m]; count = 1; } // buy everything up front
      const B = { ...lo };
      for (let n = 0; n < count; n++) {
        // route under B, then tighten B to what the route really needed and re-run (same values, lower cost)
        let run = b => gates.map((gt, g) => { const R = {}; for (const m of M) R[m] = F[g][m] + b[m]; return best(L, ords, cap, R, gt.star); });
        let route = run(B);
        const last = route[G - 1];
        if (last.lv !== cap.lv || last.mask !== cap.mask) { if (!fits(cap.req, Object.fromEntries(M.map(m => [m, F[G - 1][m] + B[m]])))) { inc(); continue; } }
        const tight = {}; for (const m of M) tight[m] = Math.max(0, ...route.map((s, g) => (s.req[m] || 0) - F[g][m]));
        route = run(tight);
        const fin = route[G - 1];
        let shop = 0; for (const m of M) shop += tight[m] * (prices[m] || 0);
        const cost = mode === 'shop' ? [shop, shop + fin.fees] : [shop + fin.fees, shop];
        const key = fin.lv + ':' + fin.mask + ':' + M.map(m => tight[m]).join(',');
        if (!out.has(key)) out.set(key, { cost, shop, fees: fin.fees, buy: tight, route, prof: route.map(s => s.value) });
        inc();
      }
      function inc() { for (const m of M) { if (B[m] < hi[m]) { B[m]++; return; } B[m] = lo[m]; } }
    }
    // Pareto prune on (cost, value at every lock)
    const all = [...out.values()].sort((a, b) => a.cost[0] - b.cost[0] || a.cost[1] - b.cost[1]);
    const keep = [];
    for (const c of all) if (!keep.some(k => k.prof.every((v, g) => v >= c.prof[g] - EPS))) keep.push(c);
    return { list: keep, mats: M, truncated };
  }

  /* ---------- pair the two parts of one axis ---------- */
  function pair(A, Bl, thr) {
    let best = null;
    for (const a of A) {
      if (best && a.cost[0] + Bl[0].cost[0] > best.cost[0] + EPS) break;
      for (const b of Bl) {
        const c0 = a.cost[0] + b.cost[0];
        if (best && (c0 > best.cost[0] + EPS || (Math.abs(c0 - best.cost[0]) <= EPS && a.cost[1] + b.cost[1] >= best.cost[1]))) { if (c0 > best.cost[0] + EPS) break; continue; }
        let ok = true; for (let g = thr.length - 1; g >= 0; g--) if (a.prof[g] + b.prof[g] < thr[g] - 1e-9) { ok = false; break; }
        if (ok) { best = { a, b, cost: [c0, a.cost[1] + b.cost[1]] }; break; }
      }
    }
    return best;
  }

  /* ---------- whole route ---------- */
  function solve(data, k, last, extra = {}, mode = 'total', opts = {}) {
    const base = data.events[k];
    if (!base) return { error: '此版本没有 PR 锁' };
    if (base.own) return { error: '此赛事使用玩家自有车，固定起始六件和已装材料未知。' };
    if (!base.stock) return { error: '车辆初始状态不完整。' };
    const gatesAll = (opts.only ? opts.only.map(i => base.gates[i]) : opts.single ? [base.gates[last]] : base.gates.slice(0, last + 1)).map(g => ({ ...g }));
    if (gatesAll.some(g => g.gift)) return { error: '锁前会送整件性能部件，此版暂不按原厂六件估算。' };
    const refs = (data.refs || {})[base.cid] || [];
    const L = base.stock.map(id => chain(data.nodes, id, base.currency));
    if (L.some(l => !l.length)) return { error: '部件配方数据不完整。' };
    const gatesN = gatesAll.length;
    for (const [gi, g] of gatesAll.entries()) {
      g.cs = data.curves[g.ck];
      if (!g.cs || !g.star) return { error: '第 ' + g.day + ' 天第 ' + g.race + ' 场的车辆星级曲线不完整。' };
      g.targets = opts.codexTargets ? (g.targets.length ? g.targets : (g.guide ? [[...g.guide, g.guidePR, 'guide']] : [])) : lockTargets(data, base.cid, g, { ...opts, ...(gi < gatesN - (opts.fineLast ?? 3) ? { tradeSteps: opts.coarseSteps ?? 7, tradeRefs: opts.coarseRefs ?? 6 } : {}), top: g.cs ? topStats(L, g.cs, g.star) : null });
      if (!g.targets.length) return { error: '第 ' + g.day + ' 天第 ' + g.race + ' 场（' + g.wall + ' PR）找不到同车达到这道锁的关卡参考三围，无法估算。', gate: g };
    }
    if (opts.debugTargets) return { targets: gatesAll.map(g => g.targets) };
    const G = gatesAll.length, prices = base.prices;
    const axisOf = L.map(l => AX.indexOf(l[0].attr));
    const axes = AX.map((_, j) => axisOf.map((a, i) => a === j ? i : -1).filter(i => i >= 0));
    if (axes.some(a => a.length !== 2)) return { error: '零件属性组合未识别。' };
    const owner = {}; L.forEach((l, i) => l.forEach(lv => lv.slots.forEach(s => { (owner[s.m] = owner[s.m] || new Set()).add(i); })));
    const shared = Object.entries(owner).filter(([, s]) => s.size > 1).map(([m]) => m);
    const C = L.map(l => partCandidates(l, gatesAll, prices, extra, mode, opts.limit || 4000));
    // branch and bound over "which reference point per lock": a lock not yet assigned contributes, per axis, its
    // least demanding reference (a valid relaxation because the real choice uses one point for all three axes)
    const thrOf = (g, t, j) => need(gatesAll[g].cs[j], t[j]);
    const loose = gatesAll.map((gt, g) => [0, 1, 2].map(j => Math.min(...gt.targets.map(t => thrOf(g, t, j)))));
    const memo = new Map();
    const axisCost = (j, thr, hint) => {
      const key = j + '|' + thr.join(',');
      if (!memo.has(key)) {
        const [ia, ib] = axes[j];
        // a child only tightens thresholds, so the parent's optimal pair stays optimal if it still qualifies
        if (hint && thr.every((x, g) => hint.a.prof[g] + hint.b.prof[g] >= x - 1e-9)) memo.set(key, hint);
        else memo.set(key, thr.some(x => x === Infinity) ? null : pair(C[ia].list, C[ib].list, thr));
      }
      return memo.get(key);
    };
    const evalPick = (pick, hint) => {
      let tot = [0, 0]; const sel = [], pairs = [];
      for (let j = 0; j < 3; j++) {
        const thr = gatesAll.map((_, g) => pick[g] ? thrOf(g, pick[g], j) : loose[g][j]);
        const p = axisCost(j, thr, hint && hint[j]); if (!p) return null;
        tot = [tot[0] + p.cost[0], tot[1] + p.cost[1]]; const [ia, ib] = axes[j]; sel[ia] = p.a; sel[ib] = p.b; pairs[j] = p;
      }
      return { cost: tot, sel, pairs };
    };
    // per lock and axis: cheapest pair meeting a threshold at that lock only (lower bound for branching)
    const fronts = new Map();
    const frontOf = g => {
      if (fronts.has(g)) return fronts.get(g);
      const per = [0, 1, 2].map(j => {
        const [ia, ib] = axes[j];
        const cut = list => { const o = list.slice().sort((x, y) => x.cost[0] - y.cost[0]); let mx = -Infinity; return o.filter(c => c.prof[g] > mx + EPS && (mx = c.prof[g], true)); };
        const A = cut(C[ia].list), B = cut(C[ib].list), pts = [];
        for (const a of A) for (const b of B) pts.push([a.prof[g] + b.prof[g], a.cost[0] + b.cost[0]]);
        pts.sort((x, y) => y[0] - x[0]);
        for (let i = 1; i < pts.length; i++) pts[i][1] = Math.min(pts[i][1], pts[i - 1][1]);
        // cost(thr) = min cost over pairs whose value >= thr
        return thr => {
          if (thr === -Infinity) return 0;
          let lo = 0, hi = pts.length - 1, ans = Infinity;
          while (lo <= hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] >= thr - 1e-9) { ans = pts[mid][1]; lo = mid + 1; } else hi = mid - 1; }
          return ans;
        };
      });
      fronts.set(g, per); return per;
    };
    // lazy branching: solve with the relaxation, then branch only on a lock that the relaxed routes do not pass
    const passes = (sel, g, t) => [0, 1, 2].every(j => { const [ia, ib] = axes[j]; return sel[ia].prof[g] + sel[ib].prof[g] >= thrOf(g, t, j) - 1e-9; });
    let bestAll = null, nodes = 0;
    const started = Date.now(), limit = opts.timeLimit ?? 8000; let timedOut = false;
    let upper = Infinity, coarse = null;
    if (!opts._coarse && !opts.samplesOnly && !opts.codexTargets) {
      const q = solve(data, k, last, extra, mode, { ...opts, _coarse: true, fineLast: 0, coarseSteps: 7, coarseRefs: 6 });
      if (!q.error && q.optimum) { upper = q.optimum[0]; coarse = q; }
    }
    const ceil = () => Math.min(upper, bestAll ? bestAll.cost[0] : Infinity);
    const dfs = (pick, hint) => {
      if (++nodes > (opts.maxNodes || 4000)) return;
      if (bestAll && Date.now() - started > limit) { timedOut = true; return; }
      const r = evalPick(pick, hint);
      if (!r || r.cost[0] > ceil() + EPS) return;
      let worst = -1, worstGap = -Infinity; const full = pick.slice();
      for (let g = 0; g < gatesAll.length; g++) {
        if (pick[g]) continue;
        const ok = gatesAll[g].targets.find(t => passes(r.sel, g, t));
        if (ok) { full[g] = ok; continue; }
        // how far the relaxed route is from the closest reference of this lock
        const gap = Math.min(...gatesAll[g].targets.map(t => Math.max(...[0, 1, 2].map(j => { const [ia, ib] = axes[j]; return thrOf(g, t, j) - r.sel[ia].prof[g] - r.sel[ib].prof[g]; }))));
        if (gap > worstGap) { worstGap = gap; worst = g; }
      }
      if (worst < 0) {
        if (!bestAll || r.cost[0] < bestAll.cost[0] - EPS || (Math.abs(r.cost[0] - bestAll.cost[0]) <= EPS && r.cost[1] < bestAll.cost[1])) bestAll = { ...r, pick: full };
        return;
      }
      // cheap valid bound per choice: the relaxed cost of this node, and the cost of meeting only this lock's
      // reference on each axis (from a per-lock front); evaluate exactly only choices whose bound can still win
      const fr = frontOf(worst);
      const tries = gatesAll[worst].targets.map(t => {
        let lb = 0; for (let j = 0; j < 3; j++) lb += fr[j](thrOf(worst, t, j));
        return [Math.max(lb, r.cost[0]), t];
      }).sort((x, y) => x[0] - y[0]);
      for (const [lb, t] of tries) {
        if (lb === Infinity || lb > ceil() + EPS) break;
        pick[worst] = t; dfs(pick, r.pairs); pick[worst] = undefined;
      }
    };
    dfs(new Array(gatesAll.length));
    const searchCut = nodes > (opts.maxNodes || 4000) || timedOut;
    // the coarse plan also passes every lock under the fine references; use it when the fine search found nothing better
    if (coarse && (!bestAll || bestAll.cost[0] > upper + EPS)) return { ...coarse, optimal: coarse.optimal && !searchCut, searchCut };
    if (!bestAll) return { error: '在现有积分货架、锁前奖励与星级下，找不到能过每道锁的六件升级路线；这不代表实际过不去。' };
    return report(base, gatesAll, L, bestAll, extra, mode, { shared, truncated: C.some(x => x.truncated) || searchCut });
  }

  /* ---------- turn the chosen routes into a purchase plan ---------- */
  // The optimum is found with "use purchased material as early as possible" routes. For the plan we re-time it lazily:
  // at each lock take, per axis, the cheapest-so-far pair of states between last lock's states and the optimal route's
  // states (so the rest of the optimal route is always still reachable). The final purchase total cannot exceed the optimum.
  const leq = (s, t) => s.lv < t.lv || (s.lv === t.lv && (s.mask & ~t.mask) === 0);
  function report(base, gates, L, sol, extra, mode, flags) {
    const G = gates.length, sel = sol.sel, prices = base.prices;
    const R = g => sel.map(c => c.route[g]);
    const freeAt = g => { const f = { ...gates[g].free }; if (g === G - 1) for (const [m, n] of Object.entries(extra)) f[m] = (f[m] || 0) + n; return f; };
    const ords = L.map(l => l.map(order)), fin = L.map((l, i) => finals(l, ords[i]));
    const axesIx = AX.map((_, j) => L.map((l, i) => AX.indexOf(l[0].attr) === j ? i : -1).filter(i => i >= 0));
    const allowed = (i, s, star) => { for (let lv = 0; lv < s.lv; lv++) if (!L[i][lv].canUp || star < L[i][lv].star) return false; return true; };
    const bought = {}, history = []; let prev = null;
    for (let g = 0; g < G; g++) {
      const free = freeAt(g), cap = R(g), pick = sol.pick[g], cur = [];
      const spend = req => { let v = 0; for (const m in req) { const short = Math.max(0, req[m] - (free[m] || 0)); v += Math.max(short, bought[m] || 0) * (prices[m] ?? 1e12); } return v; };
      for (let j = 0; j < 3; j++) {
        const [ia, ib] = axesIx[j], thr = need(gates[g].cs[j], pick[j]);
        const cand = i => fin[i].filter(s => leq(s, cap[i]) && (!prev || leq(prev[i], s)) && allowed(i, s, gates[g].star));
        let best = null;
        for (const a of cand(ia)) for (const b of cand(ib)) {
          if (a.value + b.value < thr - 1e-9) continue;
          const req = { ...a.req }; for (const [m, n] of Object.entries(b.req)) req[m] = (req[m] || 0) + n;
          const key = [spend(req), a.fees + b.fees, -(a.value + b.value)];
          if (!best || key[0] < best.key[0] - EPS || (Math.abs(key[0] - best.key[0]) <= EPS && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) best = { key, a, b };
        }
        if (!best) { best = { a: cap[ia], b: cap[ib] }; }
        cur[ia] = best.a; cur[ib] = best.b;
      }
      const req = {}; cur.forEach(s => { for (const [m, n] of Object.entries(s.req)) req[m] = (req[m] || 0) + n; });
      const now = {};
      for (const m of Object.keys(req)) { const short = Math.max(0, req[m] - (free[m] || 0)); if (short > (bought[m] || 0)) { now[m] = short - (bought[m] || 0); bought[m] = short; } }
      const fees = cur.reduce((s, x) => s + x.fees, 0);
      let paid = 0; for (const m in bought) paid += bought[m] * (prices[m] || 0);
      const stats = AX.map((_, j) => project(gates[g].cs[j], axesIx[j].reduce((s, i) => s + cur[i].value, 0)));
      history.push({ day: gates[g].day, race: gates[g].race, wall: gates[g].wall, star: gates[g].star, purchases: now,
        shop: Object.entries(now).reduce((s, [m, n]) => s + n * (prices[m] || 0), 0), paid, fees, total: paid + fees,
        states: cur, stats, target: pick, ids: cur.map((s, i) => L[i][s.lv].id) });
      prev = cur;
    }
    const last = prev, req = {}; last.forEach(s => { for (const [m, n] of Object.entries(s.req)) req[m] = (req[m] || 0) + n; });
    const items = {};
    for (const m of new Set([...Object.keys(req), ...Object.keys(bought)])) {
      const gross = req[m] || 0, buy = bought[m] || 0, bonus = Math.min(extra[m] || 0, Math.max(0, gross - buy));
      items[m] = { gross, buy, bonus, free: Math.max(0, gross - buy - bonus), unit: prices[m] ?? null };
    }
    const end = history[G - 1];
    let fit = 0, rebuild = 0;
    last.forEach((s, i) => { const l = L[i][s.lv]; let f = l.fit; for (const x of l.slots) if (s.mask & (1 << x.i)) f += x.fee; fit += f; rebuild += l.rebuild; });
    const res = { items, shop: end.paid, fit, rebuild, total: end.paid + fit + rebuild, history, stats: end.stats, target: end.target,
      final: last.map((s, i) => ({ id: L[i][s.lv].id, mask: s.mask })),
      optimal: !flags.shared.length && !flags.truncated, shared: flags.shared, truncated: flags.truncated, mode, optimum: sol.cost };
    // self-check: re-timing must not beat the optimum (that would mean the search missed a cheaper route)
    const got = mode === 'shop' ? res.shop : res.total;
    if (got < sol.cost[0] - 1e-6 && res.optimal) res.selfcheck = 'lazy plan beat the search: ' + got + ' < ' + sol.cost[0];
    return res;
  }

  /* exposed for the independent MILP check */
  const _internal = { chain, order, finals, stateOf, pareto, need, lockTargets, topStats, best, modelPR };
  return { solve, project, need, _internal };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SERoute;
