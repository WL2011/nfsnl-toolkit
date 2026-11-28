/*
 * 采购清单求解 Web Worker：在后台线程里跑 se-route.js（Codex 采购计算器 v3 的求解器，原样复制），
 * 返回已经整理好的显示数据。消息：{ f, k, last, mode, ver } → { ok, ... } 或 { error }
 */
const VER = new URLSearchParams(self.location.search).get('v') || '';
importScripts('se-route.js?v=' + VER);

const TYPES = ['电机', '涡轮', '变速箱', '车轮', '电控单元', '氮气'];
const COLORS = ['', '灰', '绿', '蓝', '紫', '金', '黑'];
const BASIS = {
  sample: '同车关卡参考（每项都达标）', scaled: '估算 PR（沿参考点方向 ±3%）', trade: '估算综合 PR（三项互补）',
  max: '需在当时星级全部升满（估算刚好够）', guide: '只有推荐三围，不保证过锁',
};
// mini program material slot (11-16 碎片, 21-26 组件, 101-106 升级套件 1) for a game material id
function mpIdx(id) {
  const m = /^(?:LTS\d*_)?MATERIAL_(CONV_)?(\d+)$/.exec(id); if (!m) return null;
  const n = +m[2]; if (n < 1 || n > 30) return null;
  const p = Math.floor((n - 1) / 5) + 1, t = (n - 1) % 5;
  if (m[1]) return t === 0 ? 100 + p : null;
  return t === 0 ? 10 + p : t === 1 ? 20 + p : null;
}

let index = null;
const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error('数据下载失败（' + r.status + '）'); return r.json(); });

self.onmessage = async ev => {
  const { f, last, mode } = ev.data;
  try {
    if (!index) index = await getJSON('../data/seplan/index.json?v=' + VER);
    const s = await getJSON('../data/seplan/ev/' + f + '.json?v=' + VER);
    const data = { events: { [s.k]: s.event }, nodes: s.nodes, curves: s.curves, refs: { [s.event.cid]: s.refs }, prm: { [s.event.cid]: s.prm }, prtime: index.prtime };
    let v = SERoute.solve(data, s.k, last, {}, mode), forced = [];
    // A lock the data can't prove (no reference reachable at that star level): calculate it anyway as
    // "all six parts fully upgraded at that star", and flag it. route.js itself is unchanged.
    if (v.error && /找不到能过每道锁|找不到同车达到这道锁/.test(v.error)) {
      const fb = fallback(data, s, last, mode);
      if (fb) { forced = fb.forced; const w = SERoute.solve(fb.data, s.k, last, {}, mode); if (!w.error) { v = w; Object.assign(data, fb.data); } }
    }
    if (v.error) { postMessage({ error: v.error }); return; }
    let lb = null;
    try { const q = SERoute.solve(data, s.k, last, {}, mode, { single: true }); if (!q.error) lb = { shop: q.shop, total: q.total }; } catch (e) { /* lower bound is optional */ }
    postMessage(view(v, lb, s, data, mode, forced));
  } catch (e) {
    postMessage({ error: '计算出错：' + (e && e.message || e) });
  }
};

const AXN = ['极速', '加速', '氮气'];
function fallback(data, s, last, mode) {
  const e = s.event, I = SERoute._internal, L = e.stock.map(id => I.chain(data.nodes, id, e.currency));
  if (L.some(l => !l.length)) return null;
  const extra = [], forced = [];
  for (let g = 0; g <= last; g++) {
    const G = e.gates[g], cs = data.curves[G.ck];
    if (!cs) return null;
    const one = SERoute.solve(data, s.k, g, {}, mode, { single: true, timeLimit: 3000 });
    if (!one.error) continue;
    if (!/找不到能过每道锁|找不到同车达到这道锁/.test(one.error)) return null;
    const top = I.topStats(L, cs, G.star).map(x => Math.floor(x - 1e-6));
    extra.push([...top, G.wall]);
    // how far "fully upgraded" is from the closest real reference of this lock
    const real = (s.refs || []).filter(p => p[3] >= G.wall);
    let gap = null;
    for (const p of real) { const d = [0, 1, 2].map(j => p[j] - top[j]); const worst = Math.max(...d); if (!gap || worst < gap.worst) gap = { worst, p, d }; }
    forced.push({ day: G.day, race: G.race, wall: G.wall, star: G.star, top,
      gap: gap ? gap.d.map((x, j) => x > 0 ? AXN[j] + ' ' + top[j] + '，参考 ' + Math.round(gap.p[j]) + '，差 ' + Math.ceil(x) : null).filter(Boolean).join('；') : '' });
  }
  if (!extra.length) return null;
  const refs = { ...data.refs, [e.cid]: [...(data.refs[e.cid] || []), ...extra] };
  return { data: { ...data, refs }, forced };
}

function view(v, lb, s, data, mode, forced = []) {
  const names = index.names, name = id => String(names[id] || id).replace(/^限时\s*/, '');
  const desc = (id, mask) => {
    const n = data.nodes[id]; if (!n) return id;
    const ls = n.slots.filter((x, i) => mask & (1 << i)), cnt = {};
    for (const [m, c] of ls) cnt[m] = (cnt[m] || 0) + c;
    return (COLORS[n.rarity] || '品质' + n.rarity) + ' ' + n.q + '★ · ' + ls.length + '/' + n.slots.length + ' 槽' +
      (ls.length ? '（' + Object.entries(cnt).map(([m, c]) => name(m) + '×' + c).join('、') + '）' : '');
  };
  const buys = p => Object.entries(p).map(([id, n]) => name(id) + ' ×' + n).join('、') || '无';
  const prices = s.event.prices;
  const locks = v.history.map((h, i) => {
    const prev = v.history[i - 1];
    const change = h.states.map((st, j) => !prev || st.lv !== prev.states[j].lv || st.mask !== prev.states[j].mask ? TYPES[j] + '：' + desc(h.ids[j], st.mask) : null).filter(Boolean);
    const isForced = forced.some(f => f.wall === h.target[3] && f.top.every((x, j) => x === h.target[j]));
    const basis = isForced ? 'forced' : h.target[4];
    return { day: h.day, race: h.race, wall: h.wall, star: h.star, basis, basisText: isForced ? '数据证明不了，按全部升满计算' : (BASIS[h.target[4]] || ''), buys: buys(h.purchases), shop: h.shop, cum: mode === 'shop' ? h.paid : h.total, change };
  });
  const items = Object.entries(v.items).map(([id, z]) => ({ id, name: name(id), idx: mpIdx(id), gross: z.gross, free: z.free, buy: z.buy, unit: z.unit }))
    .sort((a, b) => (a.idx ?? 999) - (b.idx ?? 999) || b.buy - a.buy);
  const tier = [0, 0, 0]; for (const it of items) if (it.idx != null) tier[it.idx < 20 ? 0 : it.idx < 30 ? 1 : 2] += it.buy;
  const last = v.history[v.history.length - 1];
  return {
    ok: true, k: s.k, mode, last: { day: last.day, race: last.race, wall: last.wall },
    total: v.total, shop: v.shop, fit: v.fit, rebuild: v.rebuild, tier,
    optimal: !!v.optimal && !forced.length, why: forced.length ? '有锁按全部升满计算，不保证过锁' : v.optimal ? '' : (v.shared && v.shared.length ? '部件共用材料，可能不是最低' : '赛事较复杂，限时内找到的最低，未完全证明'),
    lb, locks, items, prices: Object.fromEntries(Object.entries(prices).map(([id, p]) => [id, p])),
    final: v.final.map((o, i) => ({ part: TYPES[i], desc: desc(o.id, o.mask) })),
    guided: locks.filter(l => l.basis === 'guide').map(l => '第 ' + l.day + ' 天第 ' + l.race + ' 场'),
    maxed: locks.filter(l => l.basis === 'max').map(l => '第 ' + l.day + ' 天第 ' + l.race + ' 场'),
    forced: forced.map(f => '第 ' + f.day + ' 天第 ' + f.race + ' 场（' + f.wall + ' PR，' + f.star + '★）' + (f.gap ? '：全部升满后' + f.gap : '：数据里没有同车达到这道锁的参考')),
  };
}
