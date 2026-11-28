/*
 * 搜索页逻辑升级（替换原小程序里的简单子串匹配）。
 *  - 多关键词 AND 匹配：车名 / 简称 / 品牌（中英文 + 常用别称）/ 类别 / 稀有度 / 年份
 *  - 忽略大小写、空格和符号（gtr = GT-R，911gt3 = 911 GT3），英文允许 1 个字母的拼写错误
 *  - 按相关度排序，命中部分高亮
 *  - 稀有度 / 类别 / 标签筛选 + 排序；不输入关键词也能按筛选浏览全部赛车
 *  - 最近搜索、最近查看；键盘 ↑↓ 选择、Enter 打开、Esc 清空；任意页面按 / 或 Ctrl/⌘+K 打开搜索
 */
(function () {
  const ROUTE = 'pages/search/search';
  const RARITY = ['普通', '罕见', '稀有', '史诗', '传奇'];
  const TYPES_EN = ['street', 'classic', 'muscle', 'sports', 'super', 'hyper'];
  const ALIASES = {
    LAMBORGHINI: ['兰博', '小牛', 'lambo'], FERRARI: ['法拉'], PORSCHE: ['保时捷'],
    'MERCEDES-AMG': ['奔驰', 'benz', 'merc', 'amg'], 'MERCEDES-BENZ': ['奔驰', 'benz', 'merc'],
    BMW: ['宝马'], VOLKSWAGEN: ['vw'], CHEVROLET: ['chevy', '雪佛莱'], MCLAREN: ['麦克拉伦', '迈凯伦'],
    KOENIGSEGG: ['柯尼塞格', '科尼赛克', '柯尼赛格'], 'ASTON-MARTIN': ['阿斯顿马丁', '阿斯顿', 'aston'],
    'ALFA-ROMEO': ['阿尔法', 'alfa'], 'LAND-ROVER': ['路虎'], NISSAN: ['尼桑'], 'HOT-WHEELS': ['风火轮'],
    POLESTAR: ['极星'], RIMAC: ['里马克'], ACURA: ['讴歌'], PONTIAC: ['庞蒂克'], SHELBY: ['谢尔比'],
    DELOREAN: ['德罗宁'], 'AUTOMOBILI-PININFARINA': ['宾尼法利纳', 'pininfarina'], SRT: ['克莱斯勒'],
    LOTUS: ['莲花'], HENNESSEY: ['轩尼诗'], BUGATTI: ['布加迪'], MASERATI: ['玛莎'], TOYOTA: ['丰田'],
  };
  // special-event (特殊赛) types: index = Type in the mini program's ses / sesX data (SEType + B.R.A.V.O.)
  const SE_TYPES = [
    { cn: '剧情赛', en: 'Story', kw: 'story 剧情' }, { cn: 'XRC', en: 'Xtreme Racing Championship', kw: 'xrc 极限赛车锦标赛' },
    { cn: '快车道', en: 'Fast Lane', kw: 'fastlane fastline fast lane 快车道' }, { cn: '试炼赛', en: 'Proving Grounds', kw: 'proving grounds pg 试炼' },
    { cn: '突围赛', en: 'Breakout', kw: 'breakout blackridge 突围' }, { cn: '车队试炼', en: 'Crew Trials', kw: 'crew trials 车队' },
    { cn: 'B.R.A.V.O.', en: 'B.R.A.V.O.', kw: 'bravo' },
  ];
  let SE = {}; // car id -> { type, name }
  const TAGS = [
    { k: 'HasSEs', t: '有特殊赛' }, { k: 'HasSePartData', t: '有零件数据' }, { k: 'Under', t: '地下赛用车' },
    { k: 'inPC', t: '金箱子' }, { k: 'crew', t: '车队箱' }, { k: 'CanWasteBuy', t: '废料兑换' }, { k: 'inVault', t: '保存库' },
  ];
  const SORTS = [{ v: 'rel', t: '相关度' }, { v: 'prd', t: 'PR 从高到低' }, { v: 'pra', t: 'PR 从低到高' }, { v: 'rar', t: '稀有度' }, { v: 'id', t: '游戏顺序' }];
  const EGG = ['↑↑↓↓←→←→BA', 'show me the money'];
  const MAX_HISTORY = 8, MAX_RECENT = 8;

  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[\s\-_.·・'’"“”()（）\[\]\/+,，:：!！?？]/g, '');
  const isAscii = s => /^[\x00-\x7f]+$/.test(s);
  const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[\s\-_./()（）·]+/).map(norm).filter(Boolean);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // split "兰博基尼aventador svj" -> ['兰博基尼', 'aventador', 'svj']
  const tokenize = q => String(q || '').replace(/([㐀-鿿])([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9])([㐀-鿿])/g, '$1 $2')
    .split(/\s+/).map(norm).filter(Boolean);

  // Damerau-Levenshtein distance <= 1 ?
  function within1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
    if (la === lb) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
    return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
  }
  // tok's letters appear in order inside text, within a short window (catches dropped letters like "avntdr")
  function subseqTight(text, tok) {
    for (let st = text.indexOf(tok[0]); st >= 0; st = text.indexOf(tok[0], st + 1)) {
      let j = 1, i = st + 1;
      for (; i < text.length && j < tok.length; i++) if (text[i] === tok[j]) j++;
      if (j === tok.length && i - st <= Math.ceil(tok.length * 1.5)) return true;
    }
    return false;
  }

  let INDEX = null;
  function buildIndex(cars, types) {
    INDEX = [];
    for (const id of Object.keys(cars)) {
      const c = cars[id];
      const brandEn = String(c.Name).split(' ')[0];
      const brandCn = String(c.Name2052 || '').split(' ')[0];
      const modelEn = String(c.Name).slice(brandEn.length + 1), modelCn = String(c.Name2052 || '').slice(brandCn.length + 1);
      const year = (String(c.Name).match(/(19|20)\d\d/) || [''])[0];
      const F = (text, w) => ({ text: norm(text), words: words(text), w });
      const fields = [
        F(c.ShortName, 1.2), F(modelEn, 1.1), F(modelCn, 1.1), F(c.Name3076 && String(c.Name3076).slice(String(c.Name3076).indexOf(' ') + 1), 1),
        F(brandEn.replace(/-/g, ' '), 1), F(brandEn, 1), F(brandCn, 1), F((ALIASES[brandEn] || []).join(' '), 0.9),
        F(types?.[c.Type], 0.8), F(TYPES_EN[c.Type], 0.8), F(RARITY[c.BPColor], 0.8), F(year, 0.9),
        F(c.Name, 0.7), F(c.Name2052, 0.7),
        ...(SE[id] ? [F(SE_TYPES[SE[id].type]?.cn, 0.8), F(SE_TYPES[SE[id].type]?.kw, 0.8), F(SE[id].name, 0.75)] : []),
      ].filter(f => f.text);
      INDEX.push({ id, c, fields, all: fields.map(f => f.text).join('|') });
    }
  }
  function tokenScore(e, tok) {
    let best = 0;
    for (const f of e.fields) {
      let s = 0;
      if (f.words.includes(tok) || f.text === tok) s = 100;
      else if (f.words.some(w => w.startsWith(tok)) || f.text.startsWith(tok)) s = 70;
      else if (f.text.includes(tok)) s = 45;
      else if (isAscii(tok) && tok.length >= 4 && f.words.some(w => w.length >= 3 && within1(w, tok))) s = 25;
      s *= f.w;
      if (s > best) best = s;
    }
    if (best) return best;
    // CJK run typed without spaces, e.g. "法拉利超跑": cover it with pieces found anywhere in the car's fields
    if (!isAscii(tok) && tok.length >= 3) {
      let i = 0, pieces = 0;
      while (i < tok.length) {
        let j = tok.length;
        while (j > i + 1 && !e.all.includes(tok.slice(i, j))) j--;
        if (j === i + 1 && !e.all.includes(tok[i])) return 0;
        pieces++; i = j;
      }
      return pieces <= Math.ceil(tok.length / 2) ? 30 : 0;
    }
    if (isAscii(tok) && tok.length >= 4 && e.fields.some(f => f.w >= 1 && f.words.some(w => subseqTight(w, tok)))) return 8;
    return 0;
  }
  function scoreCar(e, toks, compact) {
    let sum = 0;
    for (const t of toks) { const s = tokenScore(e, t); if (!s) { sum = 0; break; } sum += s; }
    if (!sum && compact.length >= 3 && e.all.includes(compact)) sum = 40;
    return sum;
  }

  // highlight tokens inside a display string (matching is done on the normalised text)
  function highlight(str, toks) {
    str = String(str || '');
    if (!toks.length) return esc(str);
    let ns = '', map = [];
    for (let i = 0; i < str.length; i++) { const n = norm(str[i]); for (const ch of n) { ns += ch; map.push(i); } }
    const mark = new Array(str.length).fill(false);
    for (const t of toks) {
      if (t.length < 1) continue;
      let p = ns.indexOf(t);
      while (p >= 0) { for (let k = p; k < p + t.length; k++) mark[map[k]] = true; p = ns.indexOf(t, p + t.length); }
    }
    let out = '', open = false;
    for (let i = 0; i < str.length; i++) {
      const m = mark[i] || (open && !norm(str[i]) && mark[i + 1]);
      if (m && !open) { out += '<mark>'; open = true; } else if (!m && open) { out += '</mark>'; open = false; }
      out += esc(str[i]);
    }
    return out + (open ? '</mark>' : '');
  }

  const nameOf = (lm, c) => String((lm == 0 ? c.Name2052 : lm == 1 ? c.Name3076 : lm == 3 ? c.Name1041 : c.Name) || c.Name || '');
  function row(e, lm, toks, score) {
    const c = e.c, n = nameOf(lm, c), sp = n.indexOf(' ');
    return {
      ID: e.id, score, Type: c.Type, BPColor: c.BPColor, brandLogo: c.brand || String(c.Name).split(' ')[0],
      brandHtml: highlight(n.slice(0, sp), toks), nameHtml: highlight(n.slice(sp + 1), toks),
      // English model name under the Chinese one, only when it actually differs
      alt: lm == 0 && norm(String(c.Name).slice(String(c.Name).indexOf(' ') + 1)) !== norm(n.slice(sp + 1)) ? highlight(String(c.Name).slice(String(c.Name).indexOf(' ') + 1), toks) : '',
      pr0: c.PR?.[0] || 0, pr1: c.PR?.[1] || 0,
      tags: [...(SE[e.id] ? [SE_TYPES[SE[e.id].type]?.cn || '特殊赛'] : []), ...TAGS.filter(t => c[t.k] && !(t.k === 'HasSEs' && SE[e.id])).map(t => t.t)],
    };
  }

  window.__pagePatches = window.__pagePatches || [];
  window.__pagePatches.push(function (defs, req) {
    const def = defs[ROUTE];
    if (!def) return;
    const data = req('data/data.js'), faqs = req('data/faqs.js').faqs || [], sesMod = req('data/ses.js');
    SE = {};
    for (const src of [sesMod.sesX || {}, sesMod.ses || {}]) for (const k of Object.keys(src)) if (data.cars[k]) SE[k] = { type: src[k].Type, name: src[k].Name };
    const seTypeList = SE_TYPES.map((t, i) => ({ v: i, cn: t.cn, en: t.en, n: Object.values(SE).filter(x => x.type === i).length })).filter(t => t.n);
    const cars = data.cars;
    const origStart = def.startsearch, origLoad = def.onLoad;

    Object.assign(def.data, {
      query: '', filters: { r: [], t: [], g: [], s: [] }, seTypes: seTypeList, sortBy: 'rel', sorts: SORTS, rarityNames: RARITY, typeNames: data.Types2052 || [],
      tagList: [], results: [], total: 0, faqResults: [], faqAll: false, active: -1, history: [], recent: [], browsing: false,
    });

    Object.assign(def, {
      onLoad(o) {
        origLoad && origLoad.call(this, o);
        buildIndex(cars, data.Types2052);
        this.setData({
          tagList: TAGS.filter(t => Object.values(cars).some(c => c[t.k])),
          history: wx.getStorageSync('searchHistory') || [],
          recent: this.recentRows(),
        });
        if (o && o.q) this.setQuery(decodeURIComponent(o.q));
      },
      onShow() { if (INDEX) this.setData({ recent: this.recentRows(), tagList: TAGS.filter(t => Object.values(cars).some(c => c[t.k])) }); },
      recentRows() {
        const lm = this.data.langMode;
        return (wx.getStorageSync('searchRecentCars') || []).map(id => INDEX.find(e => e.id == id)).filter(Boolean).map(e => row(e, lm, [], 0));
      },
      // --- input -------------------------------------------------------------------------
      searchValueInput(ev) { this.setQuery(ev.detail.value); },
      setQuery(q) {
        if (EGG.includes(q)) { origStart && origStart.call(this, q); q = ''; }
        this.setData({ query: q, searchValue: q, searchCon: q ? 'show' : '' });
        this.run();
      },
      deleteTxt() { this.setQuery(''); },
      onFouse() {}, onBlur() {},
      hitbuttonclick(ev) { this.setQuery(ev.currentTarget.dataset.index); },
      hisclick(ev) { this.setQuery(ev.currentTarget.dataset.index); },
      clearHistory() { wx.setStorageSync('searchHistory', []); this.setData({ history: [] }); },
      clearRecent() { wx.setStorageSync('searchRecentCars', []); this.setData({ recent: [] }); },
      // --- filters -----------------------------------------------------------------------
      toggleFilter(ev) {
        const { g, v } = ev.currentTarget.dataset;
        const f = JSON.parse(JSON.stringify(this.data.filters));
        const i = f[g].indexOf(v); i >= 0 ? f[g].splice(i, 1) : f[g].push(v);
        this.setData({ filters: f }); this.run();
      },
      clearFilters() { this.setData({ filters: { r: [], t: [], g: [], s: [] } }); this.run(); },
      setSort(ev) { this.setData({ sortBy: ev.currentTarget.dataset.v }); this.run(); },
      toggleFaqAll() { this.setData({ faqAll: !this.data.faqAll }); },
      // --- search ------------------------------------------------------------------------
      run() {
        if (!INDEX) return;
        const q = this.data.query || '', f = this.data.filters, lm = this.data.langMode;
        const toks = tokenize(q), compact = norm(q);
        if (!f.s) f.s = [];
        const hasFilter = f.r.length || f.t.length || f.g.length || f.s.length;
        if (!toks.length && !hasFilter) { this.setData({ results: [], total: 0, faqResults: [], active: -1, browsing: false }); return; }
        let list = [];
        for (const e of INDEX) {
          const c = e.c;
          if (f.r.length && !f.r.includes(c.BPColor)) continue;
          if (f.t.length && !f.t.includes(c.Type)) continue;
          if (f.g.length && !f.g.every(k => c[k])) continue;
          if (f.s.length && !(SE[e.id] && f.s.includes(SE[e.id].type))) continue;
          const s = toks.length ? scoreCar(e, toks, compact) : 1;
          if (s > 0) list.push({ e, s });
        }
        const by = this.data.sortBy, pr = x => x.e.c.PR?.[1] || 0;
        const cmp = {
          rel: (a, b) => b.s - a.s || a.e.c.BPColor - b.e.c.BPColor || pr(a) - pr(b),
          prd: (a, b) => pr(b) - pr(a), pra: (a, b) => pr(a) - pr(b),
          rar: (a, b) => b.e.c.BPColor - a.e.c.BPColor || pr(b) - pr(a), id: (a, b) => a.e.id - b.e.id,
        }[by === 'rel' && !toks.length ? 'id' : by];
        list.sort(cmp);
        // FAQ: every token must appear in question, answer or keywords; question hits rank first
        let fq = [];
        if (toks.length) {
          for (const item of faqs) {
            const nq = norm(item.q), na = norm(item.a), nk = norm((item.kw || []).join(' '));
            let s = 0, ok = true;
            for (const t of toks) {
              const v = nq.includes(t) ? 3 : nk.includes(t) ? 2 : na.includes(t) ? 1 : 0;
              if (!v) { ok = false; break; } s += v;
            }
            if (ok) fq.push({ s, item });
          }
          fq.sort((a, b) => b.s - a.s);
        }
        this.setData({
          results: list.map(x => row(x.e, lm, toks, x.s)), total: list.length, browsing: !toks.length,
          faqResults: fq.map(({ item }) => ({ q: item.q, qHtml: highlight(item.q, toks), aHtml: highlight(item.a, toks), i: item.i || [] })),
          faqAll: false, active: list.length ? 0 : -1,
        });
      },
      // --- open --------------------------------------------------------------------------
      remember(id) {
        const q = String(this.data.query || '').trim();
        if (q) {
          const h = [q, ...(wx.getStorageSync('searchHistory') || []).filter(x => x !== q)].slice(0, MAX_HISTORY);
          wx.setStorageSync('searchHistory', h); this.setData({ history: h });
        }
        const r = [String(id), ...(wx.getStorageSync('searchRecentCars') || []).filter(x => x != id)].slice(0, MAX_RECENT);
        wx.setStorageSync('searchRecentCars', r);
      },
      searchresultclick(ev) {
        const id = ev.currentTarget.dataset.index;
        this.remember(id);
        wx.navigateTo({ url: '../car/car?id=' + id });
      },
      onKey(ev) {
        const k = ev.key, n = this.data.results.length;
        if (k === 'ArrowDown' || k === 'ArrowUp') {
          if (!n) return;
          ev.preventDefault();
          const a = ((this.data.active < 0 ? -1 : this.data.active) + (k === 'ArrowDown' ? 1 : -1) + n) % n;
          this.setData({ active: a });
          requestAnimationFrame(() => document.querySelector('.v-search .result.kb')?.scrollIntoView({ block: 'nearest' }));
        } else if (k === 'Enter') {
          const r = this.data.results[this.data.active];
          if (r) this.searchresultclick({ currentTarget: { dataset: { index: r.ID } } });
        } else if (k === 'Escape') {
          if (this.data.query) this.setQuery(''); else ev.target.blur();
        }
      },
    });
  });

  window.__searchKey = ev => { const i = window.NFSNL.activeInst(); if (i && i.onKey) i.onKey(ev); };

  // "/" or Ctrl/⌘+K anywhere: open the search page and focus the box
  window.addEventListener('keydown', ev => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    const hot = (ev.key === '/' && !typing && !ev.metaKey && !ev.ctrlKey) || ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k');
    if (!hot) return;
    ev.preventDefault();
    const N = window.NFSNL;
    if (N.topEntry().route !== ROUTE) N.nav.push(ROUTE, {});
    const focus = (n = 0) => { const el = document.querySelector('.page-frame:not([style*="none"]) .v-search .search-input'); if (el) { el.focus(); el.select(); } else if (n < 20) setTimeout(() => focus(n + 1), 30); };
    setTimeout(focus, 0);
  });
})();
