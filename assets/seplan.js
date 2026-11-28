/*
 * 肝它（特殊赛零件计算器）升级：
 *  - 零件目标去掉最左侧的配置，新增「最省钱方案」：目标 = 全程最省积分路线（Codex 采购计算器 v3 求解器）所需的材料
 *  - 新增「采购清单」：每道 PR 锁前要买什么、累计花费、六件最终状态；可选赛事版本、目标锁、优先省总积分 / 商店采购
 * 求解在 Web Worker（assets/se-worker.js）里跑，结果按参数缓存在浏览器里。数据：data/seplan/（tools/seplan.js 生成）
 */
(function () {
  const ROUTE = 'pages/separtsnotes/separtsnotes';
  const SLOTS = [11, 12, 13, 14, 15, 16, 21, 22, 23, 24, 25, 26, 101, 102, 103, 104, 105, 106];
  const cls = i => (i < 20 ? 0 : i < 30 ? 1 : 2);
  const OLD_PRICE = [4000, 6000, 12500];
  const CACHE_KEY = 'nfsnl:seplan:cache';

  let indexP = null;
  const loadIndex = () => indexP || (indexP = fetch('data/seplan/index.json', { cache: 'no-cache' }).then(r => r.json()).catch(e => { indexP = null; throw e; }));

  // ---- result cache (localStorage, small LRU) ----
  const cacheGet = key => { try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); return c[key] && c[key].v; } catch (e) { return null; } };
  const cachePut = (key, v) => {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); c[key] = { v, t: Date.now() };
      const keys = Object.keys(c).sort((a, b) => c[b].t - c[a].t); for (const k of keys.slice(30)) delete c[k];
      localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch (e) { /* quota or private mode: just don't cache */ }
  };
  // one worker per job, so a stale job can be cancelled by terminating it
  const jobs = {};
  function solve(tag, ver, msg) {
    const key = [ver, msg.f, msg.last, msg.mode].join('|');
    const hit = cacheGet(key); if (hit) return Promise.resolve(hit);
    if (jobs[tag]) { jobs[tag].w.terminate(); jobs[tag].reject(new Error('cancelled')); }
    return new Promise((resolve, reject) => {
      const w = new Worker('assets/se-worker.js?v=' + ver);
      jobs[tag] = { w, reject };
      w.onmessage = e => { w.terminate(); delete jobs[tag]; if (e.data.ok) cachePut(key, e.data); resolve(e.data); };
      w.onerror = e => { w.terminate(); delete jobs[tag]; resolve({ error: '计算出错：' + (e.message || '后台线程失败') }); };
      w.postMessage(msg);
    });
  }
  // known special case (integration notes §7): the engine shard is neither sold nor a first-clear reward here
  const NOTES = { 'vault_drift_king/vault_drift_king_v1': '这一版的电机碎片商店不卖、首通也不给，只能靠重赛刷，所以算不出采购路线。' };
  const withNote = (k, r) => (r.error && NOTES[k] ? { ...r, error: r.error + ' ' + NOTES[k] } : r);
  const fmtDate = t => { if (!t) return ''; const d = new Date(t * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };

  window.__pagePatches = window.__pagePatches || [];
  window.__pagePatches.push(function (defs) {
    const def = defs[ROUTE];
    if (!def) return;
    const orig = { onLoad: def.onLoad };
    Object.assign(def.data, {
      planOn: false, planVers: [], planVer: 0, planGates: [], planGate: 0, planMode: 'shop', planBusy: false, plan: null,
      aimState: '', aimPlan: null, need: {}, dropOf: {}, boardExtra: [],
    });

    Object.assign(def, {
      onLoad(o) {
        const id = o && o.id, notes = wx.getStorageSync('SENoteMulti') || {}, savedAim = id && notes[id] && notes[id].aim;
        orig.onLoad.call(this, o);
        if (!this.data.se_item) return;
        const shown = (this.data.aims || []).slice(-2).map(a => a.id);
        if (savedAim === 'cheap') this.setAim('cheap', true); // the original onLoad resets unknown aims and saves that, so save it back
        else if (!shown.includes(this.data.SESelectedPartMode) && shown.length) this.setAim(shown[shown.length - 1], true);
        else this.refreshNeed();
        this.planInit();
      },
      // ---- aims ---------------------------------------------------------------------------
      selectMode(ev) { this.setAim(ev.currentTarget.dataset.idx, true); },
      setAim(aim, save) {
        const upd = { SESelectedPartMode: aim };
        if (aim !== 'cheap') upd.partModeSum = this.data.partModeSumObj[aim];
        this.setData(upd);
        if (save) {
          const m = wx.getStorageSync('SENoteMulti') || {}, id = this.data.cur_id;
          m[id] ? (m[id].aim = aim) : (m[id] = { aim, m: this.data.OwnedSEMaterials, d: new Date() });
          wx.setStorageSync('SENoteMulti', m);
        }
        this.refreshNeed();
      },
      // per-slot target (need), the free drops counted against it (dropOf) and the totals line (sumcredit)
      refreshNeed() {
        const d = this.data, owned = d.OwnedSEMaterials || {}, need = {}, drop = {}, extra = [];
        let rest = [0, 0, 0], credit = 0;
        if (d.SESelectedPartMode === 'cheap') {
          const p = d.aimPlan && d.aimPlan.ok ? d.aimPlan : null;
          for (const i of SLOTS) { need[i] = 0; drop[i] = 0; }
          if (p) for (const it of p.items) {
            if (it.idx == null) { if (it.buy) extra.push(it.name + ' ×' + it.buy); continue; }
            need[it.idx] += it.gross; drop[it.idx] += it.free;
          }
          for (const i of SLOTS) {
            const r = Math.max(0, need[i] - drop[i] - (owned[i] || 0)); rest[cls(i)] += r;
            const it = p && p.items.find(x => x.idx === i && x.unit != null);
            credit += r * (it ? it.unit : OLD_PRICE[cls(i)]);
          }
          if (!p) rest = ['–', '–', '–'], credit = '–';
        } else {
          const sum = d.partModeSum || [0, 0, 0];
          for (const i of SLOTS) {
            need[i] = sum[cls(i)]; drop[i] = (d.materialsCount || {})[i] || 0;
            const r = Math.max(0, need[i] - drop[i] - (owned[i] || 0)); rest[cls(i)] += r; credit += r * OLD_PRICE[cls(i)];
          }
        }
        this.setData({ need, dropOf: drop, boardExtra: extra, sumcredit: [...rest, credit] });
      },
      saveOwned(owned) {
        const m = wx.getStorageSync('SENoteMulti') || {}, id = this.data.cur_id;
        m[id] ? (m[id].m = owned) : (m[id] = { aim: this.data.SESelectedPartMode, m: owned, d: new Date() });
        wx.setStorageSync('SENoteMulti', m);
      },
      add(ev) {
        const i = ev.currentTarget.dataset.idx, owned = { ...this.data.OwnedSEMaterials };
        if ((owned[i] || 0) >= (this.data.need[i] || 0) - (this.data.dropOf[i] || 0)) return;
        owned[i] = (owned[i] || 0) + 1;
        this.setData({ OwnedSEMaterials: owned }); this.saveOwned(owned); this.refreshNeed();
        if (this.data.sumcredit[3] === 0) {
          const self = this;
          wx.showModal({
            title: '完美提车', content: '恭喜您已经达到预定目标，完美提车！是否结束正在跑的[' + (this.data.carname || '') + ']赛事（点“取消”后仍可以手动结束赛事）？',
            confirmText: '结束', cancelText: '取消', success(r) { if (r.confirm) self.finishRace(); },
          });
        }
      },
      sub(ev) {
        const i = ev.currentTarget.dataset.idx, owned = { ...this.data.OwnedSEMaterials };
        if (!(owned[i] > 0)) return;
        owned[i]--; this.setData({ OwnedSEMaterials: owned }); this.saveOwned(owned); this.refreshNeed();
      },
      reset() {
        const self = this;
        wx.showModal({
          title: '是否重置', content: '是否重置正在跑的[' + (this.data.carname || '') + ']赛事？【注意】重置后所有记录的材料数据将被清空。',
          confirmText: '重置', confirmColor: '#ff0000', cancelText: '取消',
          success(r) { if (!r.confirm) return; const z = {}; for (const i of SLOTS) z[i] = 0; self.setData({ OwnedSEMaterials: z }); self.saveOwned(z); self.refreshNeed(); },
        });
      },
      finishRace() {
        const id = this.data.cur_id;
        if ((wx.getStorageSync('MySeID') || '') == id) wx.setStorageSync('MySeID', '');
        else { const v = wx.getStorageSync('MyVaultIDs') || []; const k = v.findIndex(x => '' + x == id); if (k >= 0) { v.splice(k, 1); wx.setStorageSync('MyVaultIDs', v); } }
        const m = wx.getStorageSync('SENoteMulti') || {}; delete m[id]; wx.setStorageSync('SENoteMulti', m);
        wx.navigateBack();
      },
      // ---- purchase plan ------------------------------------------------------------------
      async planInit() {
        let idx;
        try { idx = await loadIndex(); } catch (e) { this.setData({ aimState: 'err', plan: { error: '采购清单数据加载失败，请检查网络后刷新。' } }); return; }
        const vers = idx.cars[this.data.cur_id] || [];
        this.ver = idx.ver; this.vers = vers;
        if (!vers.length) { this.setData({ planOn: false, aimState: 'none' }); if (this.data.SESelectedPartMode === 'cheap') this.setAim((this.data.aims || []).slice(-1)[0].id, true); return; }
        const saved = (wx.getStorageSync('SEPlanVer') || {})[this.data.cur_id];
        const v = Math.max(0, vers.findIndex(x => x.k === saved));
        this.setData({
          planOn: true,
          planVers: vers.map((x, i) => ({ label: (x.kind === 'vault' ? '保存库' : '限时赛') + (fmtDate(x.t) ? ' · ' + fmtDate(x.t) : '') + (i === 0 ? '（最新）' : '') })),
        });
        this.useVersion(v);
      },
      useVersion(v) {
        const x = this.vers[v];
        this.setData({
          planVer: v, planGate: x.gates.length - 1, planMode: 'shop',
          planGates: x.gates.map((g, i) => ({ label: '第 ' + g[0] + ' 天 · 第 ' + g[1] + ' 场 · ' + g[2] + ' PR' + (i === x.gates.length - 1 ? '（最后一道锁）' : '') })),
        });
        this.runAim(); this.runPlan();
      },
      planPickVer(ev) {
        const v = Number(ev.detail.value), all = wx.getStorageSync('SEPlanVer') || {};
        all[this.data.cur_id] = this.vers[v].k; wx.setStorageSync('SEPlanVer', all);
        this.useVersion(v);
      },
      planPickGate(ev) { this.setData({ planGate: Number(ev.detail.value) }); this.runPlan(); },
      planPickMode(ev) { this.setData({ planMode: ev.currentTarget.dataset.v }); this.runPlan(); },
      // aim = full route to the last lock, fewest shop credits (same as the purchase list's default)
      runAim() {
        const x = this.vers[this.data.planVer];
        this.setData({ aimState: 'busy', aimPlan: null }); this.refreshNeed();
        solve('aim:' + this.__key, this.ver, { f: x.f, last: x.gates.length - 1, mode: 'shop' }).then(r => {
          r = withNote(x.k, r);
          this.setData({ aimPlan: r, aimState: r.ok ? 'ok' : 'err' }); this.refreshNeed();
        }, () => {});
      },
      runPlan() {
        const x = this.vers[this.data.planVer];
        this.setData({ planBusy: true });
        solve('plan:' + this.__key, this.ver, { f: x.f, last: this.data.planGate, mode: this.data.planMode }).then(r => {
          r = withNote(x.k, r);
          this.setData({ plan: r, planBusy: false });
        }, () => {});
      },
    });
  });
})();
