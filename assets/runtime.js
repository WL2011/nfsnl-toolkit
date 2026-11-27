/* NFSNL web runtime: runs the original mini program page logic in the browser.
 * - define/require module system for generated/modules.js
 * - wx.* API shim (storage, navigation, modal/toast, clipboard, request, canvas …)
 * - Page()/App()/getApp()/getCurrentPages()
 * - Vue-based page rendering + router with a page stack (like the mini program)
 */
(function () {
  'use strict';
  const { createApp, reactive, ref, computed, nextTick, onMounted, onBeforeUnmount, h, getCurrentInstance, watch, markRaw } = Vue;
  const CFG = window.__APPCFG__;
  const TPL = window.__TPL__;
  const STORAGE_PREFIX = 'nfsnl:';
  const OSS = 'https://nfsnl.oss-cn-beijing.aliyuncs.com/';

  /* ------------------------------------------------------------------ modules */
  const factories = Object.create(null), cache = Object.create(null);
  window.define = (name, factory) => { factories[name] = factory; };
  function resolve(from, req) {
    let p = req;
    if (req.startsWith('.')) {
      const base = from.split('/'); base.pop();
      for (const seg of req.split('/')) {
        if (seg === '..') base.pop(); else if (seg !== '.') base.push(seg);
      }
      p = base.join('/');
    }
    if (!p.endsWith('.js')) p += '.js';
    return p;
  }
  function requireModule(name, from) {
    const id = from ? resolve(from, name) : (name.endsWith('.js') ? name : name + '.js');
    if (cache[id]) return cache[id].exports;
    const f = factories[id];
    if (!f) throw new Error('module not found: ' + id + (from ? ' (from ' + from + ')' : ''));
    const module = { exports: {} };
    cache[id] = module;
    f.call(module.exports, n => requireModule(n, id), module, module.exports);
    return module.exports;
  }
  window.require = n => requireModule(n);

  /* ------------------------------------------------------------------ helpers */
  const later = fn => setTimeout(fn, 0);
  function cb(opts, name, res) { if (opts && typeof opts[name] === 'function') { try { opts[name](res); } catch (e) { console.error(e); } } }
  function done(opts, res, ok = true) {
    later(() => { cb(opts, ok ? 'success' : 'fail', res); cb(opts, 'complete', res); });
    return ok ? Promise.resolve(res) : Promise.reject(res);
  }
  const isPlain = v => v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
  function parsePath(path) {
    const parts = [];
    String(path).replace(/[^.[\]]+|\[(\d+)\]/g, (m, idx) => { parts.push(idx !== undefined ? +idx : m); return m; });
    return parts;
  }
  function setPath(obj, path, val) {
    const parts = parsePath(path);
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (o[p] == null || typeof o[p] !== 'object') o[p] = typeof parts[i + 1] === 'number' ? [] : {};
      o = o[p];
    }
    // always assign a fresh container so the view refreshes even when the same object is passed again
    o[parts[parts.length - 1]] = Array.isArray(val) ? val.slice() : (isPlain(val) ? Object.assign({}, val) : val);
  }
  function rpxStyle(v) {
    if (typeof v === 'string') return v.replace(/(-?\d*\.?\d+)rpx/g, 'calc(var(--rpx) * $1)');
    return v;
  }
  const rpxPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rpx')) || 0.5;

  /* ------------------------------------------------------------------ UI state (modal/toast/lightbox) */
  const ui = reactive({ toast: null, modal: null, loading: null, sheet: null, preview: null, theme: 'light' });
  let toastTimer = null;
  function showToast(o) {
    clearTimeout(toastTimer);
    ui.toast = { title: o.title || '', icon: o.icon || 'success' };
    toastTimer = setTimeout(() => { ui.toast = null; }, o.duration || 1500);
    return done(o, { errMsg: 'showToast:ok' });
  }

  /* ------------------------------------------------------------------ router / page stack */
  const pageDefs = Object.create(null);
  let registeringRoute = null;
  const insts = new Map();          // key -> page instance
  let keySeq = 0;
  const tabRoutes = CFG.tabs.map(t => t.route);
  const router = reactive({ tab: CFG.entry, visitedTabs: [CFG.entry], stack: [] /* {key, route, query} */, entries: {} });
  function newEntry(route, query) {
    const key = 'p' + (++keySeq);
    return { key, route, query: query || {} };
  }
  router.tabEntries = { [CFG.entry]: newEntry(CFG.entry, {}) };
  const topEntry = () => router.stack.length ? router.stack[router.stack.length - 1] : router.tabEntries[router.tab];
  const activeInst = () => { const e = topEntry(); return e && insts.get(e.key); };

  function splitUrl(url, fromRoute) {
    let [p, qs] = String(url).split('?');
    let route;
    if (p.startsWith('/')) route = p.slice(1);
    else {
      const base = (fromRoute || CFG.entry).split('/'); base.pop();
      for (const seg of p.split('/')) { if (seg === '..') base.pop(); else if (seg !== '.' && seg) base.push(seg); }
      route = base.join('/');
    }
    route = route.replace(/\.html$/, '');
    const query = {};
    if (qs) for (const kv of qs.split('&')) { if (!kv) continue; const i = kv.indexOf('='); const k = i < 0 ? kv : kv.slice(0, i); query[decodeURIComponent(k)] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1)); }
    return { route, query };
  }
  const hashOf = e => '#/' + e.route + (Object.keys(e.query).length ? '?' + Object.entries(e.query).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : '');
  let ignorePop = 0;
  function syncHash(replace) {
    const hsh = hashOf(topEntry());
    if (location.hash === hsh) return;
    if (replace) history.replaceState(null, '', hsh); else history.pushState(null, '', hsh);
  }
  function lifecycle(entry, name, arg) {
    const inst = entry && insts.get(entry.key);
    if (inst && typeof inst[name] === 'function') { try { inst[name](arg); } catch (e) { (window.__errs = window.__errs || []).push(entry.route + ' ' + name + ': ' + e.message); console.error(name, entry.route, e); } }
  }
  const nav = {
    push(route, query) {
      if (!pageDefs[route]) { showToast({ title: '该功能已移除', icon: 'none' }); return false; }
      if (tabRoutes.includes(route)) return nav.switchTab(route);
      lifecycle(topEntry(), 'onHide');
      router.stack.push(newEntry(route, query));
      syncHash();
      return true;
    },
    redirect(route, query) {
      if (!pageDefs[route]) return false;
      if (router.stack.length) { const e = router.stack.pop(); lifecycle(e, 'onUnload'); }
      router.stack.push(newEntry(route, query));
      syncHash(true);
      return true;
    },
    switchTab(route) {
      if (!tabRoutes.includes(route)) { showToast({ title: '该功能已移除', icon: 'none' }); return false; }
      while (router.stack.length) lifecycle(router.stack.pop(), 'onUnload');
      if (router.tab !== route) lifecycle(router.tabEntries[router.tab], 'onHide');
      const fresh = !router.tabEntries[route];
      if (fresh) router.tabEntries[route] = newEntry(route, {});
      const changed = router.tab !== route;
      router.tab = route;
      if (!fresh && changed) nextTick(() => lifecycle(router.tabEntries[route], 'onShow'));
      syncHash();
      return true;
    },
    back(delta = 1, fromPop) {
      let n = 0;
      while (router.stack.length && n < delta) { lifecycle(router.stack.pop(), 'onUnload'); n++; }
      nextTick(() => lifecycle(topEntry(), 'onShow'));
      if (!fromPop) syncHash(true);
    },
    reLaunch(route, query) {
      while (router.stack.length) lifecycle(router.stack.pop(), 'onUnload');
      if (tabRoutes.includes(route)) return nav.switchTab(route);
      return nav.push(route, query);
    },
  };
  window.addEventListener('popstate', () => {
    const want = location.hash.replace(/^#\//, '');
    const { route, query } = splitUrl('/' + want);
    const below = router.stack.length >= 2 ? router.stack[router.stack.length - 2] : router.tabEntries[router.tab];
    if (router.stack.length && below && below.route === route) return nav.back(1, true);
    if (tabRoutes.includes(route)) { nav.switchTab(route); return; }
    if (route && pageDefs[route] && topEntry().route !== route) nav.push(route, query);
  });

  /* ------------------------------------------------------------------ wx API */
  const storage = {
    get(k) { try { const v = localStorage.getItem(STORAGE_PREFIX + k); return v == null ? '' : JSON.parse(v); } catch (e) { return ''; } },
    set(k, v) { try { localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(v === undefined ? '' : v)); } catch (e) { console.warn('storage full?', e); } },
    remove(k) { localStorage.removeItem(STORAGE_PREFIX + k); },
    keys() { return Object.keys(localStorage).filter(k => k.startsWith(STORAGE_PREFIX)).map(k => k.slice(STORAGE_PREFIX.length)); },
  };
  function sysInfo() {
    const main = document.querySelector('.content');   // the visible content area (page frames may be hidden)
    const H = main && main.clientHeight ? main.clientHeight : window.innerHeight - 58;
    const W = 750 * rpxPx();
    return { windowHeight: H, windowWidth: W, screenHeight: H, screenWidth: W, pixelRatio: window.devicePixelRatio || 1,
      statusBarHeight: 0, platform: 'web', system: navigator.platform, version: '8.0.0', SDKVersion: '3.0.0', language: 'zh_CN',
      model: 'Web', brand: 'web', theme: ui.theme, safeArea: { top: 0, bottom: H, left: 0, right: W, width: W, height: H } };
  }
  function currentRoute() { const e = topEntry(); return e ? e.route : CFG.entry; }
  function chain() {
    const o = {}; const self = new Proxy(o, { get: (t, k) => (k === 'export' ? () => ({ actions: [] }) : () => self) });
    return self;
  }
  function makeCanvas(id) {
    const page = pageEl(activeInst());
    const cv = page && page.querySelector(`canvas[data-canvas-id="${id}"]`);
    if (!cv) return chain();
    const r = cv.getBoundingClientRect();
    if (cv.width !== Math.round(r.width)) { cv.width = Math.round(r.width) || 320; cv.height = Math.round(r.height) || 480; }
    const c2d = cv.getContext('2d');
    let queue = [];
    const st = { font: 10, align: 'left', baseline: 'alphabetic' };
    const op = fn => (...a) => { queue.push(() => fn(...a)); };
    const api = {
      setFillStyle: op(v => { c2d.fillStyle = v; }), setStrokeStyle: op(v => { c2d.strokeStyle = v; }),
      setLineWidth: op(v => { c2d.lineWidth = v; }), setFontSize: op(v => { st.font = v; c2d.font = `${v}px sans-serif`; }),
      setTextAlign: op(v => { c2d.textAlign = v; }), setTextBaseline: op(v => { c2d.textBaseline = v; }),
      setGlobalAlpha: op(v => { c2d.globalAlpha = v; }), setLineCap: op(v => { c2d.lineCap = v; }), setLineJoin: op(v => { c2d.lineJoin = v; }),
      draw(reserve, cbk) { if (!reserve) c2d.clearRect(0, 0, cv.width, cv.height); const q = queue; queue = []; q.forEach(f => f()); if (typeof cbk === 'function') later(cbk); },
    };
    for (const m of ['fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo',
      'quadraticCurveTo', 'bezierCurveTo', 'rect', 'fill', 'stroke', 'save', 'restore', 'translate', 'rotate', 'scale', 'drawImage', 'clip'])
      api[m] = op((...a) => c2d[m](...a));
    for (const p of ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'globalAlpha'])
      Object.defineProperty(api, p, { set: op(v => { c2d[p] = v; }) });
    return api;
  }
  const wx = window.wx = {
    getStorageSync: k => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: k => storage.remove(k),
    clearStorageSync: () => storage.keys().forEach(k => storage.remove(k)),
    getStorageInfoSync: () => ({ keys: storage.keys(), currentSize: 0, limitSize: 10240 }),
    getStorage: o => done(o, { data: storage.get(o.key) }),
    setStorage: o => { storage.set(o.key, o.data); return done(o, {}); },
    removeStorage: o => { storage.remove(o.key); return done(o, {}); },

    navigateTo(o) { const { route, query } = splitUrl(o.url, currentRoute()); const ok = nav.push(route, query); return done(o, { errMsg: 'navigateTo:' + (ok ? 'ok' : 'fail') }, ok); },
    redirectTo(o) { const { route, query } = splitUrl(o.url, currentRoute()); const ok = nav.redirect(route, query); return done(o, {}, ok); },
    switchTab(o) { const { route } = splitUrl(o.url, currentRoute()); const ok = nav.switchTab(route); return done(o, {}, ok); },
    reLaunch(o) { const { route, query } = splitUrl(o.url, currentRoute()); nav.reLaunch(route, query); return done(o, {}); },
    navigateBack(o = {}) { nav.back(o.delta || 1); return done(o, {}); },

    showToast, hideToast: () => { ui.toast = null; },
    showLoading(o = {}) { ui.loading = { title: o.title || '加载中' }; return done(o, {}); },
    hideLoading(o) { ui.loading = null; return done(o, {}); },
    showModal(o = {}) {
      return new Promise(resolveP => {
        ui.modal = { title: o.title || '', content: o.content || '', showCancel: o.showCancel !== false,
          cancelText: o.cancelText || '取消', confirmText: o.confirmText || '确定', editable: !!o.editable,
          placeholder: o.placeholderText || '', value: o.content && o.editable ? o.content : '',
          resolve: res => { ui.modal = null; cb(o, 'success', res); cb(o, 'complete', res); resolveP(res); } };
        if (o.editable) ui.modal.value = '';
      });
    },
    showActionSheet(o = {}) {
      return new Promise(resolveP => {
        ui.sheet = { items: o.itemList || [], resolve: idx => { ui.sheet = null; if (idx < 0) { cb(o, 'fail', { errMsg: 'showActionSheet:fail cancel' }); } else { cb(o, 'success', { tapIndex: idx }); } cb(o, 'complete', {}); resolveP({ tapIndex: idx }); } };
      });
    },
    setClipboardData(o) {
      const p = navigator.clipboard ? navigator.clipboard.writeText(String(o.data)) : Promise.reject();
      return p.then(() => { showToast({ title: '内容已复制', icon: 'success' }); return done(o, {}); }, () => done(o, { errMsg: 'setClipboardData:fail' }, false));
    },
    getClipboardData(o) {
      const p = navigator.clipboard ? navigator.clipboard.readText() : Promise.reject();
      return p.then(data => done(o, { data }), () => done(o, { errMsg: 'getClipboardData:fail' }, false));
    },
    previewImage(o) { ui.preview = { urls: o.urls || [], current: o.current || (o.urls || [])[0] }; return done(o, {}); },
    setNavigationBarTitle(o) { const inst = activeInst(); if (inst) inst.__state.title = o.title; return done(o, {}); },
    setNavigationBarColor: o => done(o, {}), setTabBarStyle: o => done(o, {}), showShareMenu: o => done(o, {}),
    setBackgroundColor: o => done(o, {}), stopPullDownRefresh: o => done(o, {}),
    getSystemInfoSync: sysInfo,
    getSystemInfo(o) { return done(o, sysInfo()); },
    getWindowInfo: sysInfo,
    getSetting: o => done(o, { authSetting: {} }),
    requestSubscribeMessage: o => done(o, { errMsg: 'requestSubscribeMessage:fail web' }, false),
    login: o => done(o, { code: '' }),
    vibrateShort: o => done(o || {}, {}), vibrateLong: o => done(o || {}, {}),
    canIUse: () => true,
    nextTick: f => nextTick(f),
    pageScrollTo(o) { const s = pageEl(activeInst()); const sc = s && s.closest('.content-scroll'); if (sc) sc.scrollTo({ top: o.scrollTop || 0, behavior: o.duration ? 'smooth' : 'auto' }); return done(o, {}); },
    createAnimation: () => chain(),
    createCanvasContext: id => makeCanvas(id),
    createSelectorQuery() {
      const tasks = [];
      const root = () => pageEl(activeInst()) || document;
      const node = (sel, all) => ({
        boundingClientRect(f) { tasks.push([() => { const els = all ? [...root().querySelectorAll(sel)] : [root().querySelector(sel)]; const rs = els.map(e => e ? Object.assign(e.getBoundingClientRect().toJSON(), { id: e.id, dataset: { ...e.dataset } }) : null); return all ? rs : rs[0]; }, f]); return q; },
        scrollOffset(f) { tasks.push([() => { const e = root().querySelector(sel); return e ? { scrollTop: e.scrollTop, scrollLeft: e.scrollLeft, id: e.id } : null; }, f]); return q; },
        fields(spec, f) { return this.boundingClientRect(f); },
        node(f) { tasks.push([() => ({ node: root().querySelector(sel) }), f]); return q; },
      });
      const q = {
        in() { return q; },
        select: sel => node(sel, false), selectAll: sel => node(sel, true),
        selectViewport: () => ({ scrollOffset(f) { tasks.push([() => { const s = document.querySelector('.content-scroll'); return { scrollTop: s ? s.scrollTop : 0, scrollLeft: 0 }; }, f]); return q; }, boundingClientRect(f) { tasks.push([() => ({ top: 0, left: 0, width: window.innerWidth, height: window.innerHeight }), f]); return q; } }),
        exec(f) { later(() => { const res = tasks.map(([run, c]) => { const r = run(); if (typeof c === 'function') c(r); return r; }); if (typeof f === 'function') f(res); }); },
      };
      return q;
    },
    request(o) {
      const method = (o.method || 'GET').toUpperCase();
      let url = o.url;
      const init = { method, headers: Object.assign({}, o.header || {}) };
      if (o.data && method === 'GET') url += (url.includes('?') ? '&' : '?') + new URLSearchParams(o.data).toString();
      else if (o.data) { init.body = typeof o.data === 'string' ? o.data : JSON.stringify(o.data); init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json'; }
      const parse = r => r.text().then(t => { let d = t; if (o.dataType !== 'text') { try { d = JSON.parse(t); } catch (e) { /* keep text */ } } return { data: d, statusCode: r.status, header: {} }; });
      const local = url.startsWith(OSS) ? 'data/' + url.slice(OSS.length).split('?')[0] : null;
      const attempt = () => fetch(url, init).then(r => { if (!r.ok) throw new Error(r.status); return parse(r); });
      const p = attempt().catch(err => local ? fetch(local).then(r => { if (!r.ok) throw err; return parse(r); }) : Promise.reject(err));
      p.then(res => { cb(o, 'success', res); cb(o, 'complete', res); }, err => { const r = { errMsg: 'request:fail ' + err }; cb(o, 'fail', r); cb(o, 'complete', r); });
      return { abort() {} };
    },
  };

  /* ------------------------------------------------------------------ App / Page */
  let appInst = null;
  window.App = def => { appInst = def; };
  window.getApp = () => appInst;
  window.Page = def => { if (registeringRoute) pageDefs[registeringRoute] = def; };
  window.Component = def => { if (registeringRoute) pageDefs[registeringRoute] = Object.assign({}, def, def.methods || {}); };
  window.getCurrentPages = () => {
    const list = [router.tabEntries[router.tab], ...router.stack];
    return list.map(e => e && insts.get(e.key)).filter(Boolean);
  };
  const pageEls = new Map();
  const pageEl = inst => inst && pageEls.get(inst.__key);

  // WXS module "functions" (utils/functions.wxs)
  const wxsFunctions = {
    getColor(skin) { return ({"pink": "#F3A7CB", "red": "#ff4537", "grass": "#44b549", "yellow": "#ffd503", "purple": "#c186f1", "orange": "#ff8929", "gray": "#aaaaaa", "nfsnl": "#0691b4", "nfspk": "#ff0080", "nfshw": "#fff", "blue": "#418abe"})[skin] || '#F3A7CB'; },
    getCarBrand(langMode, c) { const n = langMode == 0 ? c.Name2052 : langMode == 1 ? c.Name3076 : langMode == 3 ? c.Name1041 : c.Name; return String(n || '').substring(0, String(n || '').indexOf(' ')); },
    getCarName(langMode, c) { const n = String((langMode == 0 ? c.Name2052 : langMode == 1 ? c.Name3076 : langMode == 3 ? c.Name1041 : c.Name) || ''); return n.substring(n.indexOf(' ') + 1); },
    abs(n) { return Math.abs(parseInt(n)); },
  };

  // template helpers (global because the runtime-compiled templates resolve `_`-prefixed names on window)
  function instFromEl(el) { const p = el && el.closest && el.closest('[data-page-key]'); return p && insts.get(p.dataset.pageKey); }
  window.__list = v => (v == null ? [] : (typeof v === 'number' ? Array.from({ length: v }, (_, i) => i) : v));
  window.__rpx = rpxStyle;
  window.__s = v => (v == null ? '' : v);
  window.__preview = url => wx.previewImage({ urls: [url], current: url });
  window.__nav = function (evt, url, openType, delta) {
    const inst = instFromEl(evt && evt.currentTarget);
    const from = inst ? inst.route : currentRoute();
    if (openType === 'navigateBack') return nav.back(delta || 1);
    if (!url) return;
    const { route, query } = splitUrl(url, from);
    if (openType === 'switchTab') nav.switchTab(route);
    else if (openType === 'redirect') nav.redirect(route, query);
    else if (openType === 'reLaunch') nav.reLaunch(route, query);
    else nav.push(route, query);
  };
  window.__e = function (evt, handler, dataset, kind, id) {
    const isDom = evt instanceof Event;
    const el = isDom ? evt.currentTarget : evt && evt.__el;
    const inst = instFromEl(el) || activeInst();
    if (!inst || !handler) return;
    const fn = inst[handler];
    if (typeof fn !== 'function') { console.warn('handler not found', handler, inst.route); return; }
    const t = { id: id || (el && el.id) || '', dataset: dataset || {}, offsetLeft: el ? el.offsetLeft : 0, offsetTop: el ? el.offsetTop : 0 };
    let detail = {};
    if (!isDom) detail = evt.detail || {};
    else {
      const k = kind;
      if (k === 'input' || k === 'textarea') detail = { value: el.value, cursor: el.selectionStart };
      else if (k === 'checkbox-group') detail = { value: [...el.querySelectorAll('input.wx-checkbox:checked')].map(i => i.value) };
      else if (k === 'radio-group') {
        const tgt = evt.target; if (tgt && tgt.type === 'radio') el.querySelectorAll('input.wx-radio').forEach(r => { if (r !== tgt) r.checked = false; });
        const c = el.querySelector('input.wx-radio:checked'); detail = { value: c ? c.value : '' };
      } else if (evt.type === 'scroll') detail = { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, scrollHeight: el.scrollHeight, scrollWidth: el.scrollWidth };
      else if ('clientX' in evt) detail = { x: evt.pageX, y: evt.pageY };
      else if (k === 'checkbox' || k === 'radio') detail = { value: el.checked };
    }
    const touch = isDom && 'clientX' in evt ? [{ clientX: evt.clientX, clientY: evt.clientY, pageX: evt.pageX, pageY: evt.pageY, identifier: 0 }] : [];
    const e = { type: isDom ? ({ click: 'tap', contextmenu: 'longpress', pointerdown: 'touchstart', pointerup: 'touchend' }[evt.type] || evt.type) : 'change',
      timeStamp: Date.now(), currentTarget: t, target: t, detail, touches: touch, changedTouches: touch, mark: {} };
    try { fn.call(inst, e); } catch (err) { (window.__errs = window.__errs || []).push(inst.route + ' ' + handler + ': ' + err.message); console.error('[' + inst.route + '] ' + handler, err); }
  };

  /* ------------------------------------------------------------------ page component */
  const renders = Object.create(null);
  function compileRoute(route) {
    if (renders[route]) return renders[route];
    const slug = route.split('/').pop();
    const src = `<div class="pg pg-${slug}">${TPL[route] || '<div class="empty">页面没有内容</div>'}</div>`;
    const render = Vue.compile(src, { isCustomElement: t => t.startsWith('wx-'), whitespace: 'condense', comments: false });
    renders[route] = render;
    return render;
  }
  function makeInst(entry) {
    const def = pageDefs[entry.route];
    const data = reactive(JSON.parse(JSON.stringify(def.data || {})));
    const inst = Object.create(null);
    for (const k of Object.keys(def)) {
      if (k === 'data') continue;
      inst[k] = typeof def[k] === 'function' ? def[k] : def[k];
    }
    const state = reactive({ title: (CFG.pages[entry.route] || {}).title || '' });
    Object.assign(inst, {
      data, route: entry.route, __route__: entry.route, options: entry.query, __key: entry.key, __state: state, is: entry.route,
      setData(obj, callback) {
        // like the mini program, fields set to undefined are ignored (keeps the previous value)
        if (obj) for (const k of Object.keys(obj)) if (obj[k] !== undefined) setPath(data, k, obj[k]);
        if (typeof callback === 'function') nextTick(callback);
      },
      selectComponent: () => null, createSelectorQuery: () => wx.createSelectorQuery(),
      getOpenerEventChannel: () => ({ emit() {}, on() {}, once() {} }),
    });
    insts.set(entry.key, inst);
    return inst;
  }
  const helpers = { functions: wxsFunctions };
  const PageView = {
    props: { entry: Object, active: Boolean },
    setup(props) {
      const entry = props.entry;
      const inst = insts.get(entry.key) || makeInst(entry);
      const scope = new Proxy(inst.data, {
        get(t, k, r) { if (typeof k === 'string' && k in helpers) return helpers[k]; return Reflect.get(t, k, r); },
        getOwnPropertyDescriptor(t, k) {
          if (typeof k === 'string' && k in helpers) return { configurable: true, enumerable: false, writable: true, value: helpers[k] };
          const d = Reflect.getOwnPropertyDescriptor(t, k);
          if (d) return d;
          if (typeof k === 'string' && k[0] !== '$' && k[0] !== '_') return { configurable: true, enumerable: false, writable: true, value: undefined };
          return undefined;
        },
      });
      const self = getCurrentInstance();
      onMounted(() => {
        let el = self.proxy.$el;
        while (el && el.nodeType !== 1) el = el.nextSibling;
        if (!el) { console.error('page has no root element', entry.route); return; }
        el.dataset.pageKey = entry.key;
        pageEls.set(entry.key, el);
        try { inst.onLoad && inst.onLoad(Object.assign({}, entry.query)); } catch (e) { (window.__errs = window.__errs || []).push(entry.route + ' onLoad: ' + e.message); console.error('onLoad', entry.route, e); }
        try { inst.onShow && inst.onShow(); } catch (e) { (window.__errs = window.__errs || []).push(entry.route + ' onShow: ' + e.message); console.error('onShow', entry.route, e); }
        nextTick(() => { try { inst.onReady && inst.onReady(); } catch (e) { (window.__errs = window.__errs || []).push(entry.route + ' onReady: ' + e.message); console.error('onReady', entry.route, e); } });
      });
      onBeforeUnmount(() => { pageEls.delete(entry.key); insts.delete(entry.key); });
      return scope;
    },
  };
  // one component definition per route so each uses its own runtime-compiled render (keeps Vue's `_rc` flag)
  const pageComps = Object.create(null);
  const pageComp = route => pageComps[route] || (pageComps[route] = markRaw(Object.assign({ name: 'page-' + route.split('/').pop() }, PageView, { render: compileRoute(route) })));

  /* ------------------------------------------------------------------ components */
  const XPicker = {
    name: 'x-picker',
    props: { range: { type: [Array, Object], default: () => [] }, value: null, mode: { type: String, default: 'selector' }, rangeKey: String, disabled: Boolean, start: String, end: String, fields: String },
    emits: ['change', 'columnchange', 'cancel'],
    setup(props, { emit, slots }) {
      const root = ref(null);
      const open = ref(false);
      const multi = ref([]);
      const label = r => (props.rangeKey && r && typeof r === 'object' ? r[props.rangeKey] : r);
      const fire = (name, detail) => emit(name, { detail, __el: root.value });
      const openMulti = () => { if (props.disabled) return; multi.value = (Array.isArray(props.value) ? props.value : (props.range || []).map(() => 0)).slice(); open.value = true; };
      return () => {
        const kids = [slots.default && slots.default()];
        if (props.mode === 'selector' || !props.mode) {
          kids.push(h('select', { class: 'x-picker-native', disabled: props.disabled, value: String(props.value ?? 0),
            onChange: e => fire('change', { value: Number(e.target.value) }), onClick: e => e.stopPropagation() },
          (props.range || []).map((r, i) => h('option', { value: String(i), selected: Number(props.value) === i }, String(label(r) ?? '')))));
        } else if (props.mode === 'date' || props.mode === 'time') {
          const type = props.mode === 'time' ? 'time' : (props.fields === 'month' ? 'month' : 'date');
          kids.push(h('input', { class: 'x-picker-native', type, value: props.value || '', min: props.start, max: props.end,
            onChange: e => fire('change', { value: e.target.value }), onClick: e => { e.stopPropagation(); try { e.target.showPicker(); } catch (_) { /* ignore */ } } }));
        } else if (props.mode === 'multiSelector') {
          kids.push(h('button', { class: 'x-picker-native', type: 'button', onClick: e => { e.stopPropagation(); openMulti(); } }));
          if (open.value) {
            kids.push(h('div', { class: 'x-picker-pop', onClick: e => e.stopPropagation() }, [
              h('div', { class: 'x-picker-cols' }, (props.range || []).map((col, ci) => h('select', { class: 'x-picker-col', value: String(multi.value[ci] ?? 0),
                onChange: e => { multi.value[ci] = Number(e.target.value); fire('columnchange', { column: ci, value: Number(e.target.value) }); } },
              (col || []).map((r, i) => h('option', { value: String(i), selected: (multi.value[ci] ?? 0) === i }, String(label(r) ?? '')))))),
              h('div', { class: 'x-picker-actions' }, [
                h('button', { type: 'button', class: 'btn-ghost', onClick: () => { open.value = false; fire('cancel', {}); } }, '取消'),
                h('button', { type: 'button', class: 'btn-primary', onClick: () => { open.value = false; fire('change', { value: multi.value.slice() }); } }, '确定'),
              ]),
            ]));
          }
        }
        return h('wx-picker', { ref: root, class: 'x-picker' }, kids);
      };
    },
  };
  const XSwiper = {
    name: 'x-swiper',
    props: { current: { type: [Number, String], default: 0 }, autoplay: [Boolean, String], interval: { type: [Number, String], default: 5000 }, circular: [Boolean, String], vertical: [Boolean, String], duration: { type: [Number, String], default: 500 } },
    emits: ['change'],
    setup(props, { emit, slots }) {
      const root = ref(null), track = ref(null);
      const cur = ref(Number(props.current) || 0);
      const count = ref(0);
      const truthy = v => v === true || v === 'true' || v === '';
      watch(() => props.current, v => { cur.value = Number(v) || 0; });
      const go = (i, source) => {
        const n = count.value; if (!n) return;
        let ni = i;
        if (ni >= n) ni = truthy(props.circular) || source === 'autoplay' ? 0 : n - 1;
        if (ni < 0) ni = truthy(props.circular) ? n - 1 : 0;
        if (ni === cur.value) return;
        cur.value = ni;
        emit('change', { detail: { current: ni, source }, __el: root.value });
      };
      let timer = null;
      const measure = () => { count.value = track.value ? track.value.children.length : 0; };
      onMounted(() => {
        measure();
        timer = setInterval(() => { measure(); if (truthy(props.autoplay)) go(cur.value + 1, 'autoplay'); }, Number(props.interval) || 5000);
      });
      onBeforeUnmount(() => clearInterval(timer));
      let wheelLock = 0;
      const onWheel = e => {
        if (!truthy(props.vertical)) return;
        const now = Date.now(); if (now - wheelLock < 450) { e.preventDefault(); return; }
        if (Math.abs(e.deltaY) < 8) return;
        e.preventDefault(); wheelLock = now; go(cur.value + (e.deltaY > 0 ? 1 : -1), 'touch');
      };
      return () => {
        const v = truthy(props.vertical);
        const children = [h('div', { ref: track, class: 'x-swiper-track' + (v ? ' v' : ''), style: { transform: v ? `translateY(${-cur.value * 100}%)` : `translateX(${-cur.value * 100}%)`, transitionDuration: (Number(props.duration) || 500) + 'ms' } }, slots.default && slots.default())];
        if (count.value > 1 && !truthy(props.autoplay)) {
          children.push(h('div', { class: 'x-swiper-nav' + (v ? ' v' : '') }, [
            h('button', { type: 'button', class: 'x-swiper-btn prev', onClick: () => go(cur.value - 1, 'touch'), 'aria-label': '上一个' }, v ? '↑' : '‹'),
            h('span', { class: 'x-swiper-count' }, `${cur.value + 1} / ${count.value}`),
            h('button', { type: 'button', class: 'x-swiper-btn next', onClick: () => go(cur.value + 1, 'touch'), 'aria-label': '下一个' }, v ? '↓' : '›'),
          ]));
        }
        return h('div', { ref: root, class: 'x-swiper' + (v ? ' vertical' : ''), onWheel }, children);
      };
    },
  };
  const vInto = {
    mounted(el, b) { el.__into = b.value; if (b.value) nextTick(() => into(el, b.value)); },
    updated(el, b) { if (b.value !== el.__into) { el.__into = b.value; if (b.value) nextTick(() => into(el, b.value)); } },
  };
  function into(el, id) {
    let t = null; try { t = el.querySelector('#' + CSS.escape(String(id))); } catch (e) { return; }
    if (!t) return;
    const smooth = el.classList.contains('sv-smooth') || !el.classList.contains('sv-y');
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) {  // not a scroller: let the page scroll
      t.scrollIntoView({ block: 'start' });   // instant: page-level jumps shouldn't fight later scrolls
      return;
    }
    const top = t.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const left = t.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    el.scrollTo({ top: el.classList.contains('sv-y') ? top : el.scrollTop, left: el.classList.contains('sv-x') ? left : el.scrollLeft, behavior: el.classList.contains('sv-smooth') ? 'smooth' : 'auto' });
  }
  const vStop = {
    mounted(el, b) { el.__st = b.value; if (b.value != null) nextTick(() => { el.scrollTop = Number(b.value) || 0; }); },
    updated(el, b) { if (b.value !== el.__st) { el.__st = b.value; el.scrollTo({ top: Number(b.value) || 0, behavior: el.classList.contains('sv-smooth') ? 'smooth' : 'auto' }); } },
  };

  /* ------------------------------------------------------------------ shell */
  window.NFSNL = { color: s => wxsFunctions.getColor(s), pageComp: r => pageComp(r), router, nav, ui, insts, wx, pageDefs, storage, getCurrentPages: window.getCurrentPages, activeInst, CFG, topEntry };

  function boot() {
    // app + pages
    requireModule('app.js');
    for (const route of Object.keys(CFG.pages)) {
      registeringRoute = route;
      try { requireModule(route + '.js'); } catch (e) { console.error('page module failed', route, e); }
    }
    registeringRoute = null;
    // hand-written page logic upgrades (assets/*.js push into window.__pagePatches)
    for (const p of (window.__pagePatches || [])) { try { p(pageDefs, requireModule); } catch (e) { console.error('page patch failed', e); } }
    try { appInst.onLaunch && appInst.onLaunch({ path: CFG.entry, query: {} }); } catch (e) { console.error('onLaunch', e); }
    // the random 'game quote' easter egg leads to the removed 信息 page — switch it off
    appInst.showToast = function () {};

    // initial route from hash
    const want = location.hash.replace(/^#\//, '');
    if (want) {
      const { route, query } = splitUrl('/' + want);
      if (tabRoutes.includes(route)) { router.tab = route; router.tabEntries = { [route]: newEntry(route, {}) }; }
      else if (pageDefs[route]) router.stack.push(newEntry(route, query));
    }
    history.replaceState(null, '', hashOf(topEntry()));

    const app = createApp(window.NFSNLShell);
    app.config.globalProperties.$pageComp = pageComp;
    app.component('x-picker', XPicker);
    app.component('x-swiper', XSwiper);
    app.directive('into', vInto);
    app.directive('stop', vStop);
    // v-scrolltop="x": scroll the page back to the top whenever x changes (e.g. switching tabs)
    app.directive('scrolltop', { updated(el, b) { if (b.value !== b.oldValue) { const sc = el.closest('.content-scroll'); if (sc) sc.scrollTop = 0; } } });
    app.config.compilerOptions.isCustomElement = t => t.startsWith('wx-');
    app.config.errorHandler = (err, vm, info) => { (window.__errs = window.__errs || []).push(info + ': ' + (err && err.message)); console.error('[vue]', info, err); };
    app.config.warnHandler = () => {};
    app.mount('#app');
  }
  window.NFSNL.boot = boot;
})();
