// side-panel.js - the docked table panel and its tabs.
//
// Chat is what people say (chat.js writes there) and Log is the dealer's
// narration (addLog() in ui-panels.js). Info, Stats
// and History are drawn by renderers other scripts register with
// SidePanel.register(name, fn); a tab is rendered when it is selected and
// refreshed on demand while it is showing. From 1024px up the panel is docked
// beside the felt by CSS; below that the same markup rides as a drawer, which
// is the only mode where open()/close() do anything.

(function () {
  'use strict';

  const TAB_KEY = 'finaltable_side_panel_tab';
  const NAMES = ['chat', 'log', 'info', 'stats', 'history'];
  const renderers = {};
  let current = 'chat';

  function panel() {
    return document.getElementById('sidePanel');
  }
  function tabs() {
    return Array.from(document.querySelectorAll('#sidePanel .side-tab'));
  }
  function tabFor(name) {
    return document.querySelector(`#sidePanel .side-tab[data-tab="${name}"]`);
  }
  function bodyFor(name) {
    return document.getElementById('panel' + name.charAt(0).toUpperCase() + name.slice(1));
  }
  function isDrawer() {
    return !window.matchMedia('(min-width: 1024px)').matches;
  }
  // Whether the panel is on screen at all: docked and not hidden, or an open drawer.
  function isShowing() {
    const p = panel();
    if (!p) return false;
    return isDrawer()
      ? p.classList.contains('open')
      : !document.body.classList.contains('rail-hidden');
  }

  function select(name, opts) {
    if (!NAMES.includes(name)) return;
    current = name;
    tabs().forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on) tab.classList.remove('unread');
      const body = bodyFor(tab.dataset.tab);
      if (body) body.classList.toggle('hidden', !on);
    });
    if (renderers[name]) renderers[name]();
    // The two append-only scrollers open at their latest line.
    if (name === 'chat' || name === 'log') {
      const body = document.getElementById(name === 'chat' ? 'panelChatBody' : 'panelLogBody');
      if (body) body.scrollTop = body.scrollHeight;
    }
    try {
      localStorage.setItem(TAB_KEY, name);
    } catch (_err) {
      /* private mode */
    }
    if (opts && opts.focus) {
      const tab = tabFor(name);
      if (tab) tab.focus();
    }
  }

  function register(name, fn) {
    renderers[name] = fn;
    if (current === name) fn();
  }

  // Re-run a tab's renderer, but only while that tab is the one showing.
  function refresh(name) {
    if (current === name && renderers[name]) renderers[name]();
  }

  // Mark a tab as having something new when the viewer cannot see it.
  function notify(name) {
    if (isShowing() && current === name) return;
    const tab = tabFor(name);
    if (tab) tab.classList.add('unread');
    // Out of view entirely: the top-bar button carries the dot.
    if (!isShowing()) {
      const btn = document.getElementById('btnPanelToggle');
      if (btn) btn.classList.add('unread');
    }
  }

  function syncToggle() {
    const btn = document.getElementById('btnPanelToggle');
    if (!btn) return;
    btn.setAttribute('aria-expanded', isShowing() ? 'true' : 'false');
    if (isShowing()) btn.classList.remove('unread');
    document.body.classList.toggle('panel-open', isDrawer() && isShowing());
  }

  function open() {
    const p = panel();
    if (!p || !isDrawer()) return;
    p.classList.add('open');
    const scrim = document.getElementById('panelScrim');
    if (scrim) scrim.classList.remove('hidden');
    const tab = tabFor(current);
    if (tab) tab.classList.remove('unread');
    syncToggle();
  }

  // Returns true when a drawer was actually closed, so the Escape chain can
  // tell whether the key did something.
  function close() {
    const p = panel();
    if (!p || !p.classList.contains('open')) return false;
    p.classList.remove('open');
    const scrim = document.getElementById('panelScrim');
    if (scrim) scrim.classList.add('hidden');
    syncToggle();
    return true;
  }

  function toggle() {
    if (isDrawer()) {
      if (!close()) open();
      return;
    }
    document.body.classList.toggle('rail-hidden');
    if (isShowing()) {
      const tab = tabFor(current);
      if (tab) tab.classList.remove('unread');
    }
    syncToggle();
  }

  function isDocked() {
    return !isDrawer();
  }

  // Select a tab and make sure the viewer can see it: open the drawer on a
  // phone, un-hide the rail on a desktop.
  function reveal(name) {
    select(name);
    if (isDrawer()) {
      open();
    } else if (document.body.classList.contains('rail-hidden')) {
      document.body.classList.remove('rail-hidden');
    }
    syncToggle();
  }

  function onTabKey(e) {
    const list = tabs();
    const idx = list.indexOf(document.activeElement);
    if (idx < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % list.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(list[next].dataset.tab, { focus: true });
  }

  function init() {
    const p = panel();
    if (!p) return;
    tabs().forEach((tab) => tab.addEventListener('click', () => select(tab.dataset.tab)));
    const strip = p.querySelector('.side-panel-tabs');
    if (strip) strip.addEventListener('keydown', onTabKey);
    const scrim = document.getElementById('panelScrim');
    if (scrim) scrim.addEventListener('click', close);
    const toggleBtn = document.getElementById('btnPanelToggle');
    if (toggleBtn) toggleBtn.addEventListener('click', toggle);
    const closeBtn = document.getElementById('btnPanelClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    // Crossing the docked threshold: a drawer left open must not linger as
    // an open class, and the toggle's state text must follow the mode.
    const docked = window.matchMedia('(min-width: 1024px)');
    const onModeChange = () => {
      if (docked.matches) close();
      syncToggle();
    };
    if (docked.addEventListener) docked.addEventListener('change', onModeChange);
    else if (docked.addListener) docked.addListener(onModeChange);
    let saved = null;
    try {
      saved = localStorage.getItem(TAB_KEY);
    } catch (_err) {
      /* private mode */
    }
    select(NAMES.includes(saved) ? saved : 'chat');
    syncToggle();
  }

  window.SidePanel = {
    select,
    register,
    refresh,
    notify,
    open,
    close,
    toggle,
    reveal,
    isDocked,
    isOpen: isShowing,
    current: () => current,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
