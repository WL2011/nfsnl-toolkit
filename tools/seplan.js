/*
 * 生成「最省钱方案 / 采购清单」用的数据（data/seplan/）。
 * 数据来自 Codex 采购计算器项目（只在这台 Mac 上）：
 *   optimizer/v2/data.json        赛事、部件配方、星级曲线、材料名
 *   optimizer/v3/refs/*.json      每张车卡的过锁参考点、PR 拟合系数、PR-时间表
 *   optimizer/v3/route.js         求解器（复制到 assets/se-route.js）
 *   site/dist/index.html (#db)    赛事列表（车名、年份、版本、日期）
 * 输出：
 *   data/seplan/index.json        小程序车 ID → 可选赛事版本；材料名；PR-时间表
 *   data/seplan/ev/<key>.json     单个赛事求解所需的全部数据（按需加载）
 * 运行：node tools/seplan.js   （需要先跑过 build.js，生成 generated/modules.js）
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CODEX = process.env.SEPLAN_SRC || '/Users/williamlin/Documents/Codex/NFS mod/NFSNL-SE-PR-20261121';
const OUT = path.join(ROOT, 'data/seplan');

// ---- mini program data (cars + ses) -------------------------------------------------------------
global.window = global; const factories = {}; global.define = (n, f) => { factories[n] = f; };
eval(fs.readFileSync(path.join(ROOT, 'generated/modules.js'), 'utf8'));
const cache = {}, P = path.posix;
const req = base => p => { let n = P.normalize(P.join(P.dirname(base), p)); if (!n.endsWith('.js')) n += '.js'; if (cache[n]) return cache[n].exports; const m = { exports: {} }; cache[n] = m; factories[n](req(n), m, m.exports, global); return m.exports; };
const mpData = req('x.js')('data/data.js'), mpSes = req('x.js')('data/ses.js').ses;

// ---- Codex data ----------------------------------------------------------------------------------
const model = JSON.parse(fs.readFileSync(path.join(CODEX, 'optimizer/v2/data.json'), 'utf8'));
const refs = JSON.parse(fs.readFileSync(path.join(CODEX, 'optimizer/v3/refs/saferefs.json'), 'utf8'));
const prm = JSON.parse(fs.readFileSync(path.join(CODEX, 'optimizer/v3/refs/prm_slim.json'), 'utf8'));
const prtime = JSON.parse(fs.readFileSync(path.join(CODEX, 'optimizer/v3/refs/prtime.json'), 'utf8'));
const html = fs.readFileSync(path.join(CODEX, 'site/dist/index.html'), 'utf8');
const blob = id => { const a = html.indexOf('<script id="' + id + '" type="application/json">'); const s = html.indexOf('>', a) + 1; return JSON.parse(html.slice(s, html.indexOf('</script>', s))); };
const rows = blob('db').rows;
fs.copyFileSync(path.join(CODEX, 'optimizer/v3/route.js'), path.join(ROOT, 'assets/se-route.js'));

// ---- match mini program cars to event rows -------------------------------------------------------
const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const byCar = new Map(); for (const r of rows) { if (!model.events[r.k]) continue; if (!byCar.has(r.carId)) byCar.set(r.carId, []); byCar.get(r.carId).push(r); }
const cands = [...byCar.values()].map(rs => ({ rs, b: norm(rs[0].make[1]), m: norm(rs[0].model[1]), y: String(rs[0].year || '') }));
const ALIAS = { 'MERCEDES-AMG EQS 580': ['mercedesbenz', 'eqs580'] };
function match(car) {
  const brand = car.Name.split(' ')[0], modelName = car.Name.slice(brand.length + 1);
  let [b, full] = ALIAS[car.Name] || [norm(brand), norm(modelName)];
  const year = (modelName.match(/(?:19|20)\d\d/g) || []).pop() || '';
  const bare = norm(modelName.replace(/\(?(?:19|20)\d\d\)?/g, ''));
  const brandOk = c => c.b === b || c.b.replace(/benz|amg/, '') === b.replace(/benz|amg/, '');
  let ms = cands.filter(c => brandOk(c) && c.m === full);
  if (!ms.length) ms = cands.filter(c => brandOk(c) && c.m === bare);
  if (!ms.length) ms = cands.filter(c => brandOk(c) && c.m && (c.m.startsWith(bare) || bare.startsWith(c.m)));
  if (ms.length > 1 && year) { const y = ms.filter(c => c.y === year); if (y.length) ms = y; }
  return ms.length === 1 ? ms[0].rs : null;
}

const safeName = k => k.replace(/[^A-Za-z0-9_.-]/g, '_');
fs.rmSync(path.join(OUT, 'ev'), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'ev'), { recursive: true });
const cars = {}, written = new Set(), unmatched = [];
for (const id of Object.keys(mpSes)) {
  const car = mpData.cars[id]; if (!car) continue;
  const rs = match(car); if (!rs) { unmatched.push(car.Name); continue; }
  // newest first: versions with registrations first, then by start (限时赛) / release (保存库) date
  const list = rs.slice().sort((a, b) => ((b.registrations > 0) - (a.registrations > 0)) || (b.when?.[1] || 0) - (a.when?.[1] || 0)).map(r => {
    const e = model.events[r.k];
    return { k: r.k, f: safeName(r.k), kind: r.kind, t: r.when?.[1] || 0, gates: e.gates.map(g => [g.day, g.race, g.wall]) };
  });
  cars[id] = list;
  for (const v of list) {
    if (written.has(v.k)) continue; written.add(v.k);
    const e = model.events[v.k], nodes = {}, curves = {};
    for (const start of e.stock || []) { let n = start; const seen = new Set(); while (n && !seen.has(n) && model.nodes[n]) { seen.add(n); nodes[n] = model.nodes[n]; n = model.nodes[n].next; } }
    for (const ck of [e.ck, ...e.gates.map(g => g.ck)]) if (ck && model.curves[ck]) curves[ck] = model.curves[ck];
    const slim = { ...e, gates: e.gates.map(({ guide, guidePR, targets, ...g }) => ({ ...g, guide, guidePR, targets })) };
    fs.writeFileSync(path.join(OUT, 'ev', v.f + '.json'), JSON.stringify({ k: v.k, event: slim, nodes, curves, refs: refs[e.cid] || [], prm: prm[e.cid] || null }));
  }
}
// version tag for cache-busting the per-event files and the worker scripts
const crypto = require('crypto'), h = crypto.createHash('md5');
for (const f of ['assets/se-route.js', 'assets/se-worker.js']) if (fs.existsSync(path.join(ROOT, f))) h.update(fs.readFileSync(path.join(ROOT, f)));
for (const f of fs.readdirSync(path.join(OUT, 'ev')).sort()) h.update(fs.readFileSync(path.join(OUT, 'ev', f)));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ ver: h.digest('hex').slice(0, 8), cars, names: model.names, prtime }));
const size = fs.readdirSync(path.join(OUT, 'ev')).reduce((s, f) => s + fs.statSync(path.join(OUT, 'ev', f)).size, 0);
console.log('seplan:', Object.keys(cars).length, 'cars,', written.size, 'events,', (size / 1e6).toFixed(2), 'MB; unmatched:', unmatched.join(', ') || 'none');
