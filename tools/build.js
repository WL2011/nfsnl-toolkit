#!/usr/bin/env node
// Build the web version from the unpacked mini program in source/unpacked.
//   node --expose-internals tools/build.js
// Outputs:
//   generated/templates.js   page templates converted to Vue template strings
//   generated/legacy.css     original WXSS decoded to CSS, scoped per page
//   generated/modules.js     original JS modules (data/, utils/, pages/, app.js) as define() calls
//   source/wxml/**           readable decompiled WXML (reference only)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const acorn = require('internal/deps/acorn/acorn/dist/acorn');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'source', 'unpacked');
const GEN = path.join(ROOT, 'generated');
// Pages included in the web version (everything else from the mini program is dropped)
const KEEP = new Set([
  'pages/index/index',            // 赛车
  'pages/underground/underground',// 地下
  'pages/activity/activity',      // 活动
  'pages/search/search',          // 搜索
  'pages/car/car',                // 赛车详情
  'pages/se/se',                  // 特殊赛信息
  'pages/separtsnotes/separtsnotes', // 特殊赛零件计算器
  'pages/compare/compare',        // 赛车对比（地下赛 VS）
]);
fs.mkdirSync(GEN, { recursive: true });

const html = fs.readFileSync(path.join(SRC, 'page-frame.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const appConfig = JSON.parse(fs.readFileSync(path.join(SRC, 'app-config.json'), 'utf8'));

/* ============================== WXML decompile ============================== */
const code = scripts.find(s => s.includes('var x=[') && s.includes('gz$gwx_'));
const ast = acorn.parse(code, { ecmaVersion: 'latest', allowReturnOutsideFunction: true });
const S = n => code.slice(n.start, n.end);
const gz = {}, mfuncs = {}, eMap = {}, tplDefs = {};
let xList = null;
(function walk(n, cb) {
  if (!n || typeof n.type !== 'string') return;
  cb(n);
  for (const k in n) {
    const v = n[k];
    if (Array.isArray(v)) v.forEach(c => walk(c, cb));
    else if (v && typeof v.type === 'string') walk(v, cb);
  }
})(ast, n => {
  if (n.type === 'FunctionDeclaration' && n.id && /^gz\$gwx_\d+$/.test(n.id.name)) gz[n.id.name] = S(n);
  if (n.type === 'VariableDeclarator' && n.id.name === 'x' && n.init && n.init.type === 'ArrayExpression' && !xList)
    xList = n.init.elements.map(e => e.value);
  if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.computed &&
      n.left.object.type === 'MemberExpression' && n.left.object.object.name === 'd_' && n.right.type === 'FunctionExpression') {
    const fi = n.left.object.property.property.value;
    (tplDefs[fi] = tplDefs[fi] || []).push([n.left.property.value, n.right]);
  }
  if (n.type === 'VariableDeclarator' && /^m\d+$/.test(n.id.name) && n.init && n.init.type === 'FunctionExpression')
    mfuncs[n.id.name] = n.init;
  if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.name === 'e_' &&
      n.right.type === 'ObjectExpression') {
    const f = n.right.properties.find(p => p.key.name === 'f');
    const idx = n.left.property.type === 'MemberExpression' ? n.left.property.property.value : null;
    if (f && idx !== null) eMap[idx] = f.value.name;
  }
});
const vctx = { __WXML_GLOBAL__: { ops_cached: {} } };
vm.createContext(vctx);
for (const v of Object.values(gz)) vm.runInContext(v, vctx);
const ops = name => vm.runInContext(name + '()', vctx);

// Tree: element {tag, attrs:[[name, op]], children}, text {textOp}, branch blocks carry attrs with ops.
function decompileM(fnNode, z) {
  const nodes = {};
  const mk = tag => ({ tag, attrs: [], children: [] });
  const root = mk('#root');
  nodes[fnNode.params[2].name] = root;
  const forFns = {}, gdVars = {};
  const num = a => a.type === 'Literal' ? a.value : (a.type === 'UnaryExpression' && a.operator === '-' ? -a.argument.value : Number(S(a)));
  function call(c, assignTo) {
    const fn = c.callee.name, a = c.arguments;
    const set = n => { if (assignTo) nodes[assignTo] = n; return n; };
    switch (fn) {
      case '_n': return set(mk(a[0].value));
      case '_v': { const n = mk('block'); n.virtual = true; return set(n); }
      case '_mz': {
        // pairs [name, n]: n === -1 -> boolean attribute; first other n is an absolute op index (base),
        // later ones are offsets from that base
        const n = mk(a[1].value), arr = a[2].elements; let base = null;
        for (let i = 0; i < arr.length; i += 2) {
          const d = num(arr[i + 1]);
          if (d === -1) { n.attrs.push([arr[i].value, [1, true]]); continue; }
          let idx; if (base === null) { base = d; idx = d; } else idx = base + d;
          n.attrs.push([arr[i].value, z[idx]]);
        }
        return set(n);
      }
      case '_oz': return set({ textOp: z[a[1].value] });
      case '_rz': { const n = nodes[a[1].name]; if (n) n.attrs.push([a[2].value, z[a[3].value]]); return; }
      case '_': {
        const p = nodes[a[0].name], ch = nodes[a[1].name];
        if (p && ch && !ch._attached) { p.children.push(ch); ch._attached = true; }
        return;
      }
      case '_2z': case '_1z': {
        const target = nodes[a[6].name];
        const f = a[2].type === 'Identifier' ? forFns[a[2].name] : a[2];
        if (target) {
          target.forOp = z[a[1].value];
          target.forItem = a[7] ? a[7].value : 'item';
          target.forIndex = a[8] ? a[8].value : 'index';
          if (f) { nodes[f.params[2].name] = target; f.body.body.forEach(stmt); }
        }
        return;
      }
      case '_gd': if (assignTo) gdVars[assignTo] = nodes[a[1].name]; return;
      default: return;
    }
  }
  function stmt(st) {
    if (!st) return;
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        if (!d.init) continue;
        if (d.init.type === 'CallExpression') call(d.init, d.id.name);
        else if (d.init.type === 'FunctionExpression') forFns[d.id.name] = d.init;
      }
    } else if (st.type === 'ExpressionStatement') {
      const e = st.expression;
      if (e.type === 'CallExpression') call(e);
      else if (e.type === 'SequenceExpression') e.expressions.forEach(x => x.type === 'CallExpression' && call(x));
    } else if (st.type === 'IfStatement') ifChain(st, true);
    else if (st.type === 'BlockStatement') st.body.forEach(stmt);
    else if (st.type === 'TryStatement') st.block.body.forEach(stmt);
  }
  const vkeyTarget = block => {
    for (const s of block.body || [])
      if (s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' &&
          s.expression.left.type === 'MemberExpression' && s.expression.left.property.name === 'wxVkey')
        return s.expression.left.object.name;
    return null;
  };
  const condOp = t => (t.type === 'CallExpression' && t.callee.name === '_oz') ? z[t.arguments[1].value] : [[7], [3, 'true']];
  function ifChain(st, first) {
    if (first && st.test.type === 'Identifier' && gdVars[st.test.name]) {   // <template is=.. data=..>
      const isn = gdVars[st.test.name];
      let dataOp = null, tgt = null;
      for (const b of st.consequent.body) {
        if (b.type === 'VariableDeclaration') for (const d of b.declarations) {
          const i = d.init && (d.init.type === 'LogicalExpression' ? d.init.left : d.init);
          if (i && i.type === 'CallExpression' && i.callee.name === '_1z') dataOp = z[i.arguments[1].value];
        }
        if (b.type === 'ExpressionStatement' && b.expression.type === 'AssignmentExpression' &&
            b.expression.left.property && b.expression.left.property.name === 'wxXCkey')
          tgt = nodes[b.expression.left.object.name];
      }
      (tgt || root).children.push({ tag: 'template', attrs: [], isOp: isn && isn.textOp, dataOp, children: [] });
      return;
    }
    const cons = st.consequent.type === 'BlockStatement' ? st.consequent : { body: [st.consequent] };
    const tn = vkeyTarget(cons), tgt = tn && nodes[tn];
    if (!tgt) { cons.body.forEach(stmt); if (st.alternate) stmt(st.alternate); return; }
    const before = tgt.children.length;
    cons.body.forEach(stmt);
    tgt.children.push({ tag: 'block', attrs: [], cond: first ? 'if' : 'elif', condOp: condOp(st.test), children: tgt.children.splice(before) });
    if (st.alternate) {
      if (st.alternate.type === 'IfStatement') ifChain(st.alternate, false);
      else {
        const b2 = tgt.children.length; st.alternate.body.forEach(stmt);
        tgt.children.push({ tag: 'block', attrs: [], cond: 'else', children: tgt.children.splice(b2) });
      }
    }
  }
  fnNode.body.body.forEach(stmt);
  return root;
}
const gzOf = f => f.body.body[0].declarations[0].init.callee.name;
const pages = {};      // 'pages/index/index' -> tree
for (const [idx, mname] of Object.entries(eMap)) {
  const f = mfuncs[mname]; if (!f) continue;
  const rel = xList[idx].replace(/^\.\//, '').replace(/^(\.\.\/)+/, '').replace(/\.wxml$/, '');
  pages[rel] = decompileM(f, ops(gzOf(f)));
}
const namedTpls = {};  // 'caritem' -> tree
for (const defs of Object.values(tplDefs))
  for (const [nm, f] of defs) namedTpls[nm] = decompileM(f, ops(gzOf(f)));

/* ============================== expressions ============================== */
const ID = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await').split(' '));
const fixPath = s => s.replace(/(^|[^\w])(\.\.\/)+img\//g, '$1img/').replace(/^\/img\//, 'img/');
const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
function ex(o, js) {   // js=true: valid JS for Vue; false: WXML-ish display
  const lit = s => js ? q(fixPath(s)) : JSON.stringify(s);
  if (!Array.isArray(o)) return JSON.stringify(o);
  const h = o[0];
  if (typeof h === 'number') {
    if (h === 3) return lit(o[1]);
    if (h === 1) return typeof o[1] === 'string' ? lit(o[1]) : String(o[1]);
    // "a{{x}}b{{y}}": each {{}} renders undefined/null as an empty string
    if (h === 11) return o.slice(1).map(p => (Array.isArray(p) && p[0] === 3 ? lit(p[1]) : (js ? '__s(' + ex(p, js) + ')' : '(' + ex(p, js) + ')'))).join(' + ');
    return JSON.stringify(o);
  }
  switch (h[0]) {
    case 7: {  // variable; JS reserved words can't be bare identifiers inside Vue's with(_ctx) render
      const v = o[1][1];
      return js && RESERVED.has(v) ? `_ctx[${q(v)}]` : v;
    }
    case 6: {
      // WXML member access is null-safe (undefined.x -> undefined); mirror that with optional chaining
      const obj = ex(o[1], js), p = o[2], dot = js ? '?.' : '.';
      if (Array.isArray(p) && p[0] === 3 && ID.test(p[1])) return obj + dot + p[1];
      return obj + (js ? '?.[' : '[') + ex(p, js) + ']';
    }
    case 2: {
      const f = h[1];
      if (f === '?:') return '(' + ex(o[1], js) + ' ? ' + ex(o[2], js) + ' : ' + ex(o[3], js) + ')';
      if (o.length === 2) return '(' + f + ex(o[1], js) + ')';
      return '(' + ex(o[1], js) + ' ' + f + ' ' + ex(o[2], js) + ')';
    }
    case 4: return '[' + (o[1] ? ex(o[1], js) : '') + ']';
    case 5: return o.slice(1).map(x => ex(x, js)).join(', ');
    case 8: case 9: return '{' + objParts(o, js).join(', ') + '}';
    case 10: return '...' + ex(o[1], js);
    case 12: return ex(o[1], js) + '(' + (o[2] ? ex(o[2], js) : '') + ')';
    default: return JSON.stringify(o);
  }
}
function objParts(o, js) {
  const h = o[0][0];
  if (h === 8) { const v = ex(o[2], js); return [v === o[1] ? v : (ID.test(o[1]) ? o[1] : q(o[1])) + ': ' + v]; }
  if (h === 9) return [...objParts(o[1], js), ...objParts(o[2], js)];
  return ['...' + ex(o, js)];
}
const isStatic = o => Array.isArray(o) && o[0] === 3;
const staticVal = o => (isStatic(o) ? o[1] : null);
// WXML display form
function tmpl(o) {
  if (isStatic(o)) return o[1];
  if (Array.isArray(o) && o[0] === 11) return o.slice(1).map(p => (isStatic(p) ? p[1] : '{{' + ex(p) + '}}')).join('');
  return '{{' + ex(o) + '}}';
}

/* ============================== WXML writer (reference) ============================== */
function renderWxml(n, ind = 0) {
  const pad = '  '.repeat(ind);
  if (n.textOp !== undefined) return pad + tmpl(n.textOp) + '\n';
  if (n.tag === '#root') return n.children.map(c => renderWxml(c, ind)).join('');
  if (n.tag === 'template') return `${pad}<template is="${n.isOp ? tmpl(n.isOp) : '?'}"${n.dataOp ? ` data="{{${ex(n.dataOp)}}}"` : ''} />\n`;
  const at = [];
  if (n.forOp) {
    at.push(['wx:for', tmpl(n.forOp)]);
    if (n.forItem !== 'item') at.push(['wx:for-item', n.forItem]);
    if (n.forIndex !== 'index') at.push(['wx:for-index', n.forIndex]);
  }
  if (n.cond) at.push(['wx:' + n.cond, n.condOp ? '{{' + ex(n.condOp) + '}}' : '']);
  for (const [k, v] of n.attrs) at.push([k, tmpl(v)]);
  if (n.virtual && !at.length) return n.children.map(c => renderWxml(c, ind)).join('');
  const as = at.map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, "'")}"`)).join('');
  if (!n.children.length) return `${pad}<${n.tag}${as} />\n`;
  return `${pad}<${n.tag}${as}>\n${n.children.map(c => renderWxml(c, ind + 1)).join('')}${pad}</${n.tag}>\n`;
}

/* ============================== Vue template writer ============================== */
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jsOf = o => {
  if (isStatic(o)) return q(fixPath(o[1]));
  return ex(o, true);
};
const CUSTOM = { view: 'wx-view', text: 'wx-text', label: 'label', navigator: 'wx-navigator', 'scroll-view': 'wx-scroll-view',
  'swiper-item': 'wx-swiper-item', 'checkbox-group': 'wx-checkbox-group', 'radio-group': 'wx-radio-group', icon: 'wx-icon',
  div: 'div', br: 'br', canvas: 'canvas', button: 'button', textarea: 'textarea', input: 'input' };
// wx event name -> [dom event, modifiers]
const EVT = { tap: ['click'], longpress: ['contextmenu', '.prevent'], longtap: ['contextmenu', '.prevent'], change: ['change'],
  input: ['input'], confirm: ['keyup', '.enter'], scroll: ['scroll'], focus: ['focus'], blur: ['blur'],
  touchstart: ['pointerdown'], touchend: ['pointerup'], touchcancel: ['pointercancel'], touchmove: ['pointermove'],
  columnchange: ['columnchange'] };
const camelData = k => k.slice(5).toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const VIEWS = path.join(ROOT, 'views');
const viewOverride = rel => { const f = path.join(VIEWS, rel + '.html'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim() : null; };
const usedIds = new Set();
const warnings = [];

function renderVue(n, ctx) {
  if (n.textOp !== undefined) {
    if (isStatic(n.textOp)) return escText(n.textOp[1]);
    return '{{ ' + escText(ex(n.textOp, true)) + ' }}';
  }
  if (n.tag === '#root') return n.children.map(c => renderVue(c, ctx)).join('');
  if (n.tag === 'template') {
    const name = n.isOp && staticVal(n.isOp);
    if (!name || !namedTpls[name]) { warnings.push(`${ctx.page}: dynamic/unknown template ${n.isOp && tmpl(n.isOp)}`); return ''; }
    const ov = viewOverride('templates/' + name);
    if (ov) { ctx.overrides && ctx.overrides.add('templates/' + name); return ov; }
    return renderVue(namedTpls[name], ctx);
  }
  if (n.tag === 'ad') return '';
  const dir = [];
  if (n.forOp) {
    let it = n.forItem || 'item'; const ix = n.forIndex || 'index';
    if (ix === it) it = '__item_' + it;  // same name for item and index: the mini program binds the index
    dir.push(`v-for="(${it}, ${ix}) in __list(${escAttr(jsOf(n.forOp))})"`);
  }
  if (n.cond === 'if') dir.push(`v-if="${escAttr(jsOf(n.condOp))}"`);
  if (n.cond === 'elif') dir.push(`v-else-if="${escAttr(jsOf(n.condOp))}"`);
  if (n.cond === 'else') dir.push('v-else');
  const inner = () => n.children.map(c => renderVue(c, ctx)).join('');
  if (n.tag === 'block') {
    if (!dir.length && !n.attrs.length) return inner();
    return `<template ${dir.join(' ')}>${inner()}</template>`;
  }

  // ---- element attributes ----
  const A = {}; n.attrs.forEach(([k, v]) => { A[k] = v; });
  const out = [...dir];
  const classes = [];
  let tag = CUSTOM[n.tag] || n.tag;
  const dataset = [];
  const events = [];
  let kind = n.tag;
  for (const [k, v] of n.attrs) {
    if (k.startsWith('data-')) { dataset.push(`${camelData(k)}: ${jsOf(v)}`); continue; }
    let m = k.match(/^(bind|catch|capture-bind|capture-catch|bind:|catch:)(.+)$/);
    if (m) {
      const ev = m[2].replace(/^:/, ''); const stop = m[1].startsWith('catch');
      events.push({ ev, handler: v, stop });
      continue;
    }
  }
  const dsExpr = '{' + dataset.join(', ') + '}';
  const idExpr = A.id !== undefined ? jsOf(A.id) : "''";
  for (const e of events) {
    const map = EVT[e.ev] || [e.ev];
    let domEv = map[0], mods = (map[1] || '') + (e.stop ? '.stop' : '');
    if (e.ev === 'change' && (n.tag === 'picker' || n.tag === 'swiper')) domEv = 'change';
    if (e.ev === 'change' && (n.tag === 'checkbox-group' || n.tag === 'radio-group')) domEv = 'change';
    const h = isStatic(e.handler) ? q(e.handler[1]) : jsOf(e.handler);
    out.push(`@${domEv}${mods}="__e($event, ${escAttr(h)}, ${escAttr(dsExpr)}, ${escAttr(q(kind))}, ${escAttr(idExpr)})"`);
  }
  const bindAttr = (name, v) => {
    if (isStatic(v)) out.push(`${name}="${escAttr(fixPath(v[1]))}"`);
    else out.push(`:${name}="${escAttr(jsOf(v))}"`);
  };
  for (const [k, v] of n.attrs) {
    if (k.startsWith('data-') || /^(bind|catch|capture)/.test(k)) continue;
    switch (k) {
      case 'class':
        if (isStatic(v)) classes.push(v[1]); else out.push(`:class="${escAttr(jsOf(v))}"`);
        break;
      case 'style':
        if (isStatic(v)) out.push(`style="${escAttr(v[1].replace(/(-?[\d.]+)rpx/g, 'calc(var(--rpx) * $1)'))}"`);
        else out.push(`:style="__rpx(${escAttr(jsOf(v))})"`);
        break;
      case 'hidden': out.push(`v-show="!(${escAttr(isStatic(v) ? (v[1] === 'false' ? 'false' : 'true') : jsOf(v))})"`); break;
      case 'animation': case 'unitId': case 'wx:key': case 'easingFunction': case 'selectionStart': case 'selectionEnd': break;
      default:
        if (n.tag === 'scroll-view' && (k === 'scrollY' || k === 'scrollX')) {
          if (!(isStatic(v) && v[1] === 'false')) classes.push(k === 'scrollY' ? 'sv-y' : 'sv-x');
          break;
        }
        if (n.tag === 'scroll-view' && k === 'scrollIntoView') { out.push(`v-into="${escAttr(jsOf(v))}"`); break; }
        if (n.tag === 'scroll-view' && k === 'scrollTop') { out.push(`v-stop="${escAttr(jsOf(v))}"`); break; }
        if (n.tag === 'scroll-view' && k === 'scrollWithAnimation') { classes.push('sv-smooth'); break; }
        if ((n.tag === 'input' || n.tag === 'textarea') && k === 'value') { out.push(`:value="${escAttr(jsOf(v))}"`); break; }
        if ((n.tag === 'input' || n.tag === 'textarea') && k === 'focus') { out.push('autofocus'); break; }
        if ((n.tag === 'checkbox' || n.tag === 'radio') && (k === 'checked' || k === 'disabled')) {
          out.push(`:${k}="${escAttr(isStatic(v) ? (v[1] === '' || v[1] === 'true' ? 'true' : 'false') : jsOf(v))}"`); break;
        }
        if (n.tag === 'button' && k === 'openType') { classes.push('wx-btn-opentype-' + (staticVal(v) || 'x')); break; }
        if (n.tag === 'button' && (k === 'type' || k === 'size')) { if (isStatic(v)) classes.push('wx-btn-' + v[1]); break; }
        if (n.tag === 'image' && k === 'mode') { if (isStatic(v)) classes.push('wx-mode-' + v[1]); break; }
        if (n.tag === 'canvas' && k === 'canvasId') { bindAttr('data-canvas-id', v); break; }
        if (n.tag === 'navigator' && (k === 'url' || k === 'openType' || k === 'delta')) break;
        if (n.tag === 'picker') { // passed as component props
          const pn = { range: 'range', value: 'value', mode: 'mode', rangeKey: 'range-key', disabled: 'disabled', start: 'start', end: 'end', fields: 'fields' }[k];
          if (pn) { out.push(`:${pn}="${escAttr(jsOf(v))}"`); break; }
        }
        if (n.tag === 'swiper') {
          const pn = { current: 'current', autoplay: 'autoplay', interval: 'interval', circular: 'circular', vertical: 'vertical', duration: 'duration' }[k];
          if (pn) { out.push(`:${pn}="${escAttr(isStatic(v) ? (/^(true|false|\d+)$/.test(v[1]) ? v[1] : q(v[1])) : jsOf(v))}"`); break; }
        }
        if (k === 'id' && !isStatic(v)) { out.push(`:id="${escAttr(jsOf(v))}"`); break; }
        bindAttr(k.replace(/([A-Z])/g, '-$1').toLowerCase(), v);
    }
  }
  switch (n.tag) {
    case 'label': classes.push('wx-label'); break;
    case 'image': tag = 'img'; classes.push('wx-image'); out.push('loading="lazy"'); break;
    case 'button': classes.push('wx-button'); out.push('type="button"'); break;
    case 'input': classes.push('wx-input'); break;
    case 'textarea': classes.push('wx-textarea'); break;
    case 'checkbox': tag = 'input'; classes.push('wx-checkbox'); out.push('type="checkbox"'); break;
    case 'radio': tag = 'input'; classes.push('wx-radio'); out.push('type="radio"'); break;
    case 'picker': tag = 'x-picker'; break;
    case 'swiper': tag = 'x-swiper'; break;
    case 'navigator': {
      const url = A.url ? jsOf(A.url) : "''";
      const ot = A.openType ? jsOf(A.openType) : "'navigate'";
      out.push(`@click="__nav(${escAttr(url)}, ${escAttr(ot)}, ${A.delta ? escAttr(jsOf(A.delta)) : 1})"`);
      break;
    }
  }
  if (classes.length) out.unshift(`class="${escAttr(classes.join(' '))}"`);
  const open = `<${tag}${out.length ? ' ' + out.join(' ') : ''}`;
  if (['img', 'input', 'br'].includes(tag) || (tag === 'input')) return open + '>';
  if (tag === 'textarea') return open + '></textarea>';
  return `${open}>${inner()}</${tag}>`;
}

const templatesOut = {};
const wxmlDir = path.join(ROOT, 'source', 'wxml');
const overridden = new Set();
for (const [route, tree] of Object.entries(pages)) {
  if (!KEEP.has(route)) {
    const p = path.join(wxmlDir, route + '.wxml');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, renderWxml(tree));
    continue;
  }
  let ov = viewOverride(route.replace(/^pages\/[^/]+\//, 'pages/'));
  if (ov) {
    overridden.add(route);
    // <include-template name="x" /> -> hand-written views/templates/x.html, or the converted original template
    ov = ov.replace(/<include-template\s+name="([\w-]+)"\s*\/>/g, (_, nm) =>
      viewOverride('templates/' + nm) || (namedTpls[nm] ? renderVue(namedTpls[nm], { page: route }) : ''));
  }
  templatesOut[route] = ov || renderVue(tree, { page: route, overrides: overridden });
  const p = path.join(wxmlDir, route + '.wxml');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderWxml(tree));
}
{
  let t = '';
  for (const [nm, tree] of Object.entries(namedTpls)) t += `<template name="${nm}">\n${renderWxml(tree, 1)}</template>\n\n`;
  fs.mkdirSync(path.join(wxmlDir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(wxmlDir, 'templates', 'templates.wxml'), t);
}
fs.writeFileSync(path.join(GEN, 'templates.js'),
  '// generated by tools/build.js — do not edit\nwindow.__TPL__ = ' + JSON.stringify(templatesOut, null, 0).replace(/<\/script/g, '<\\/script') + ';\n');

/* ============================== CSS ============================== */
const records = [];
const cctx = {
  __COMMON_STYLESHEETS__: {},
  setCssToHead: (arr, err, info) => { records.push({ arr, path: info && info.path }); return () => {}; },
};
vm.createContext(cctx);
function balanced(s, from, open, close) {
  let i = from, depth = 1, qch = null;
  for (; i < s.length && depth; i++) {
    const c = s[i];
    if (qch) { if (c === '\\') i++; else if (c === qch) qch = null; continue; }
    if (c === '"' || c === "'") qch = c; else if (open.includes(c)) depth++; else if (close.includes(c)) depth--;
  }
  return i;
}
for (const s of scripts) {
  let m; const re = /(__wxAppCode__\['([^']+\.wxss)'\]\s*=\s*)?setCssToHead\(/g;
  while ((m = re.exec(s))) {
    const end = balanced(s, m.index + m[0].length, '([', ')]');
    const before = records.length;
    try { vm.runInContext(s.slice(m.index + (m[1] ? m[1].length : 0), end), cctx); } catch (e) { warnings.push('css ' + e.message); }
    if (m[2] && records.length > before && !records[records.length - 1].path) records[records.length - 1].path = './' + m[2];
  }
  const re2 = /__COMMON_STYLESHEETS__\['([^']+)'\]\s*=\s*\[/g;
  while ((m = re2.exec(s))) {
    const end = balanced(s, m.index + m[0].length, '[', ']');
    try { vm.runInContext(s.slice(m.index, end), cctx); } catch (e) { warnings.push('ccss ' + e.message); }
  }
}
const common = cctx.__COMMON_STYLESHEETS__;
function decodeCss(arr, seen = new Set()) {
  let out = '';
  for (const it of arr) {
    if (typeof it === 'string') out += it;
    else if (it[0] === 0) out += `calc(var(--rpx) * ${it[1]})`;
    else if (it[0] === 2 && !seen.has(it[1]) && common[it[1]]) { seen.add(it[1]); out += decodeCss(common[it[1]], seen) + '\n'; }
  }
  return out;
}
const TAGSEL = { 'wx-label': '.wx-label', 'wx-image': '.wx-image', 'wx-button': '.wx-button', 'wx-input': '.wx-input', 'wx-textarea': '.wx-textarea',
  'wx-checkbox': '.wx-checkbox', 'wx-radio': '.wx-radio', 'wx-swiper': '.x-swiper', 'wx-picker': '.x-picker' };
function scopeSel(sel, prefix) {
  sel = sel.trim();
  for (const [a, b] of Object.entries(TAGSEL)) sel = sel.replace(new RegExp('(^|[\\s>+~(,])' + a + '(?![\\w-])', 'g'), '$1' + b);
  if (/^(page|body|html)\b/.test(sel)) return prefix + sel.replace(/^(page|body|html)/, '');
  if (sel.startsWith('::-webkit-scrollbar')) return prefix + ' ' + sel;
  return prefix + ' ' + sel;
}
function scopeCss(css, prefix) {
  let out = '', i = 0;
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while (i < css.length) {
    const ob = css.indexOf('{', i); if (ob < 0) break;
    const sel = css.slice(i, ob).trim();
    const cb = balanced(css, ob + 1, '{', '}');
    const body = css.slice(ob + 1, cb - 1);
    if (/^@(media|supports)/.test(sel)) out += `${sel}{${scopeCss(body, prefix)}}\n`;
    else if (/^@/.test(sel)) out += `${sel}{${body}}\n`;
    else if (sel) out += sel.split(/,(?![^(]*\))/).map(s => scopeSel(s, prefix)).join(',') + `{${body}}\n`;
    i = cb;
  }
  return out;
}
let cssOut = '/* generated by tools/build.js — original WXSS, scoped per page */\n';
for (const r of records) {
  const css = decodeCss(r.arr); if (!css.trim()) continue;
  if (!r.path) { cssOut += `/* app */\n` + scopeCss(css, '.pg') + '\n'; continue; }
  const route = r.path.replace(/^\.\//, '').replace(/\.wxss$/, '');
  if (route.startsWith('templates/')) continue; // included via @import into pages
  if (route !== 'app' && !KEEP.has(route)) continue;
  const prefix = route === 'app' ? '.pg' : '.pg-' + route.split('/').pop();   // app.wxss applies to every page
  cssOut += `/* ${route} */\n` + scopeCss(css, prefix) + '\n';
}
fs.writeFileSync(path.join(GEN, 'legacy.css'), cssOut);

/* ============================== JS modules ============================== */
const svc = fs.readFileSync(path.join(SRC, 'app-service.js'), 'utf8');
const ms = [...svc.matchAll(/define\("([^"]+)",/g)];
let modOut = '// generated by tools/build.js — original mini program modules\n';
for (let i = 0; i < ms.length; i++) {
  const end = i + 1 < ms.length ? ms[i + 1].index : svc.length;
  const modName = ms[i][1];
  if (modName.startsWith('pages/') && !KEEP.has(modName.replace(/\.js$/, ''))) continue;
  let body = svc.slice(ms[i].index, end);
  // drop what follows each define (auto-registration `require("pages/x/x.js")`, __wxRoute bookkeeping);
  // the runtime registers pages itself
  body = body.slice(0, body.lastIndexOf('});') + 3) + '\n';
  modOut += body.trim() + '\n';
}
fs.writeFileSync(path.join(GEN, 'modules.js'), modOut);

/* ============================== app config ============================== */
const pageCfg = {};
for (const p of appConfig.pages) {
  const r = p.replace(/\.html$/, '');
  if (!KEEP.has(r)) continue;
  const w = (appConfig.page[p] || {}).window || {};
  pageCfg[r] = { title: w.navigationBarTitleText || '' };
}
const cfg = {
  entry: appConfig.entryPagePath.replace(/\.html$/, ''),
  tabs: appConfig.tabBar.list.map(t => ({ route: t.pagePath.replace(/\.html$/, ''), text: t.text })).filter(t => KEEP.has(t.route)),
  pages: pageCfg,
};
fs.writeFileSync(path.join(GEN, 'config.js'), '// generated by tools/build.js\nwindow.__APPCFG__ = ' + JSON.stringify(cfg, null, 1) + ';\n');

/* ============================== cache busting ============================== */
// index.html references assets/* and generated/* with ?v=<content hash>, so browsers pick up rebuilt files
{
  const crypto = require('crypto');
  const idx = path.join(ROOT, 'index.html');
  let page = fs.readFileSync(idx, 'utf8');
  page = page.replace(/(src|href)="((?:assets|generated)\/[^"?]+)(?:\?v=[^"]*)?"/g, (m, attr, file) => {
    const f = path.join(ROOT, file);
    if (!fs.existsSync(f)) return m;
    const v = crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 8);
    return `${attr}="${file}?v=${v}"`;
  });
  fs.writeFileSync(idx, page);
}

console.log(`views overridden: ${[...overridden].join(', ') || 'none'}`);
console.log(`templates: ${Object.keys(templatesOut).length}, named: ${Object.keys(namedTpls).join(',')}, css records: ${records.length}, modules: ${ms.length}`);
if (warnings.length) console.log('warnings:\n  ' + [...new Set(warnings)].join('\n  '));
