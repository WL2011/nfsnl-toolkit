/* Desktop shell: sidebar navigation, top bar, page frames and overlays. */
(function () {
  'use strict';
  const { computed, ref, onMounted, onBeforeUnmount, nextTick } = Vue;

  const ICONS = {
    '赛车': '<path d="M5 17h14M6.5 17v1.5M17.5 17v1.5M4 13l1.6-4.2A2 2 0 0 1 7.5 7.5h9a2 2 0 0 1 1.9 1.3L20 13v4H4v-4Zm0 0h16"/><circle cx="7.5" cy="14.5" r=".6"/><circle cx="16.5" cy="14.5" r=".6"/>',
    '零件': '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    '地下': '<path d="M3 20h18M5 20V9l7-5 7 5v11"/><path d="M9 20v-6h6v6"/>',
    '活动': '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    '信息': '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    tool: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.4 2.4-2.6-.7-.7-2.6 2.7-2.1Z"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    game: '<rect x="3" y="7" width="18" height="11" rx="3"/><path d="M8 11v3M6.5 12.5h3M15.5 12h.01M17.5 13.5h.01"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
    auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17A8.5 8.5 0 0 0 12 3.5Z" fill="currentColor"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  };
  const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.tool}</svg>`;

  // titles for pages that don't set one themselves
  const TITLES = { 'pages/search/search': '搜索', 'pages/car/car': '赛车详情', 'pages/se/se': '特殊赛信息', 'pages/separtsnotes/separtsnotes': '特殊赛零件计算器', 'pages/compare/compare': '赛车对比' };
  const SKINS = ['nfsnl', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'grass', 'gray', 'nfspk'];

  window.NFSNLShell = {
    template: `
<div class="app" :class="{ dark: isDark }" :style="{ '--accent': accent }">
  <aside class="sidebar" :class="{ open: navOpen }">
    <div class="brand">
      <div class="brand-mark">NL</div>
      <div class="brand-text"><div class="brand-name">NFSNL 工具箱</div><div class="brand-sub">极品飞车：无极限 · 数据助手</div></div>
    </div>
    <nav class="nav">
      <button v-for="t in tabs" :key="t.route" class="nav-item" :class="{ active: tabActive(t.route) }" @click="go(t.route)">
        <span class="nav-ico" v-html="icon(t.text)"></span><span>{{ t.text }}</span>
      </button>
      <div class="nav-sep"></div>
      <button class="nav-item" :class="{ active: pageActive('pages/search/search') }" @click="go('pages/search/search')">
        <span class="nav-ico" v-html="icon('search')"></span><span>搜索</span>
      </button>
    </nav>
    <div class="sidebar-foot">
      <div class="theme-seg" role="group" aria-label="外观">
        <button v-for="m in themeModes" :key="m.v" :class="{ on: darkMode === m.v }" @click="setDark(m.v)" :title="m.t"><span v-html="icon(m.i)"></span></button>
      </div>
      <div class="skins" role="group" aria-label="主题色">
        <button v-for="s in skins" :key="s" class="skin-dot" :class="{ on: skin === s }" :style="{ background: color(s) }" :title="s" @click="setSkin(s)"></button>
      </div>
    </div>
  </aside>
  <div class="scrim" v-if="navOpen" @click="navOpen = false"></div>
  <main class="main">
    <header class="topbar">
      <button class="icon-btn menu-btn" @click="navOpen = !navOpen" aria-label="菜单"><span v-html="icon('list')"></span></button>
      <button v-if="canBack" class="back-btn" @click="back"><span v-html="icon('back')"></span>返回</button>
      <div class="crumbs">
        <span v-if="canBack" class="crumb-parent">{{ parentTitle }}</span>
        <span v-if="canBack" class="crumb-sep">/</span>
        <h1 class="title">{{ title }}</h1>
      </div>
    </header>
    <div class="content">
      <section v-for="e in entries" :key="e.key" v-show="e.key === top.key" class="page-frame">
        <div class="content-scroll">
          <div class="page-inner" :class="'inner-' + slug(e.route)">
            <component :is="$pageComp(e.route)" :entry="e" />
          </div>
        </div>
      </section>
    </div>
  </main>

  <transition name="fade"><div v-if="ui.toast" class="toast" :class="'toast-' + ui.toast.icon">
    <span v-if="ui.toast.icon === 'success'" class="toast-ico">✓</span><span v-else-if="ui.toast.icon === 'error'" class="toast-ico">!</span>{{ ui.toast.title }}
  </div></transition>
  <div v-if="ui.loading" class="toast toast-loading"><span class="spinner"></span>{{ ui.loading.title }}</div>
  <transition name="fade"><div v-if="ui.modal" class="overlay" @keydown.esc="modalAnswer(false)">
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-title" v-if="ui.modal.title">{{ ui.modal.title }}</div>
      <div class="dialog-body" v-if="!ui.modal.editable">{{ ui.modal.content }}</div>
      <textarea v-else class="dialog-input" v-model="ui.modal.value" :placeholder="ui.modal.placeholder" rows="4"></textarea>
      <div class="dialog-actions">
        <button v-if="ui.modal.showCancel" class="btn-ghost" @click="modalAnswer(false)">{{ ui.modal.cancelText }}</button>
        <button class="btn-primary" @click="modalAnswer(true)" ref="okBtn">{{ ui.modal.confirmText }}</button>
      </div>
    </div>
  </div></transition>
  <div v-if="ui.sheet" class="overlay" @click.self="ui.sheet.resolve(-1)">
    <div class="sheet">
      <button v-for="(it, i) in ui.sheet.items" :key="i" class="sheet-item" @click="ui.sheet.resolve(i)">{{ it }}</button>
      <button class="sheet-item cancel" @click="ui.sheet.resolve(-1)">取消</button>
    </div>
  </div>
  <div v-if="ui.preview" class="overlay lightbox" @click="ui.preview = null">
    <img :src="ui.preview.current" alt="" @click.stop>
    <div class="lightbox-thumbs" v-if="ui.preview.urls.length > 1" @click.stop>
      <img v-for="u in ui.preview.urls" :key="u" :src="u" :class="{ on: u === ui.preview.current }" @click="ui.preview.current = u" alt="">
    </div>
  </div>
</div>`,
    setup() {
      const N = window.NFSNL;
      const { router, nav, ui, CFG, storage } = N;
      const tick = ref(0);
      const navOpen = ref(false);
            const darkMode = ref(Number(storage.get('darked') || 0));
      const skin = ref(storage.get('skin') || 'pink');
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const sysDark = ref(mq.matches);
      const onMq = e => { sysDark.value = e.matches; refreshPages(); };
      onMounted(() => mq.addEventListener('change', onMq));
      onBeforeUnmount(() => mq.removeEventListener('change', onMq));

      const top = computed(() => N.topEntry());
      const entries = computed(() => [...Object.values(router.tabEntries), ...router.stack]);
      const canBack = computed(() => router.stack.length > 0);
      const titleOf = e => {
        if (!e) return '';
        const inst = N.insts.get(e.key);
        const t = (inst && inst.__state.title) || (CFG.pages[e.route] || {}).title;
        const tab = CFG.tabs.find(x => x.route === e.route);
        return t || (tab && tab.text) || TITLES[e.route] || 'NFSNL';
      };
      const title = computed(() => { tick.value; return titleOf(top.value); });
      const parentTitle = computed(() => {
        const s = router.stack; const below = s.length >= 2 ? s[s.length - 2] : router.tabEntries[router.tab];
        return titleOf(below);
      });
      const accent = computed(() => window.NFSNL.color(skin.value));
      const isDark = computed(() => darkMode.value === 1 || (darkMode.value === 2 && sysDark.value));

      // the original pages decide "dark" through getApp().getDark(); mode 2 now follows the OS setting
      const app = window.getApp();
      app.getDark = v => (Number(v) === 2 ? sysDark.value : Number(v) === 1);
      function refreshPages() {
        for (const inst of N.insts.values()) { try { app.onPageShow && inst.setData({ darked: app.getDark(storage.get('darked') || 0), skin: storage.get('skin') || 'pink' }); } catch (e) { /* ignore */ } }
        darkMode.value = Number(storage.get('darked') || 0);
        skin.value = storage.get('skin') || 'pink';
      }
      // pages change skin/dark themselves (信息页) — poll storage cheaply to stay in sync
      const sync = setInterval(() => {
        const d = Number(storage.get('darked') || 0), s = storage.get('skin') || 'pink';
        if (d !== darkMode.value || s !== skin.value) refreshPages();
        tick.value++;
      }, 700);
      onBeforeUnmount(() => clearInterval(sync));

      return {
        ui, tabs: CFG.tabs, skins: SKINS, navOpen, top, entries, canBack, title, parentTitle,
        accent, isDark, darkMode, skin,
        themeModes: [{ v: 0, i: 'sun', t: '浅色' }, { v: 1, i: 'moon', t: '深色' }, { v: 2, i: 'auto', t: '跟随系统' }],
        icon: svg, color: s => window.NFSNL.color(s), slug: r => r.split('/').pop(),
        tabActive: r => !router.stack.length && router.tab === r,
        pageActive: r => top.value && top.value.route === r,
        go(r) { navOpen.value = false; if (CFG.tabs.some(t => t.route === r)) nav.switchTab(r); else if (top.value.route !== r) nav.push(r, {}); },
        back() { nav.back(1); },
        setDark(v) { storage.set('darked', v); refreshPages(); },
        setSkin(s) { storage.set('skin', s); refreshPages(); },
        modalAnswer(ok) { const m = ui.modal; if (!m) return; m.resolve({ confirm: !!ok, cancel: !ok, content: m.value }); },
      };
    },
  };
})();
