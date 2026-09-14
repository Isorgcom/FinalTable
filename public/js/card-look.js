// card-look.js - how the cards look to the person reading them.
//
// Three settings: the back they are dealt with, whether the deck is the
// classic two colours or four, and whether the face carries a large index.
// None of it reaches anybody else. Two people at one table can be looking at
// different backs and neither can tell, which is why this is a preference and
// not table state: the cards are the same cards, and this is the reading.
//
// Each setting is one attribute on <body>, and the stylesheets do the rest -
// tokens.css for the backs and the face scale, table.css for the four-colour
// deck. Every rule is written against the bare attribute rather than against
// body, so an option in the dialog carrying the same attribute is drawn that
// way inside a table that still is not.

(function () {
  'use strict';

  // app-state.js owns the names, because these are three of the settings that
  // follow the player rather than the browser, and Store has to know they are
  // among those. The literals here are the fallback for a page that somehow
  // loaded this file without that one.
  const KEYS = window.CARD_LOOK_KEYS || {
    cardBack: 'finaltable_card_back',
    deck: 'finaltable_deck',
    cardFace: 'finaltable_card_face',
  };

  // Also known to the server, which will not store a value it cannot see the
  // point of. Changing a list means changing CARD_BACKS, DECKS or CARD_FACES
  // in server/identity.js. The first of each is what this table has always
  // dealt, so somebody who never opens the dialog sees no change at all.
  const LOOKS = {
    cardBack: { attr: 'data-back', values: ['green', 'red', 'blue', 'ivory'] },
    deck: { attr: 'data-deck', values: ['two', 'four'] },
    cardFace: { attr: 'data-face', values: ['standard', 'large'] },
  };

  function modal() {
    return document.getElementById('cardsModal');
  }

  function options(name) {
    return Array.from(document.querySelectorAll(`#cardsModal [data-look="${name}"]`));
  }

  function current(name) {
    const look = LOOKS[name];
    const saved = window.Store ? Store.get(KEYS[name]) : null;
    return look.values.includes(saved) ? saved : look.values[0];
  }

  // The dialog says what is chosen, and only the chosen option is in the tab
  // order: a radio group is one stop, and the arrows move within it.
  function syncOptions() {
    for (const name of Object.keys(LOOKS)) {
      const chosen = current(name);
      for (const btn of options(name)) {
        const on = btn.dataset.value === chosen;
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.tabIndex = on ? 0 : -1;
      }
    }
  }

  // Straight onto <body>, from whatever the store has. Called at load before
  // anything is drawn, and again whenever the settings arrive from the server
  // on another device (applyPreferences in app-state.js).
  function apply() {
    if (!document.body) return;
    for (const [name, look] of Object.entries(LOOKS)) {
      document.body.setAttribute(look.attr, current(name));
    }
    syncOptions();
  }

  function set(name, value) {
    const look = LOOKS[name];
    if (!look || !look.values.includes(value)) return;
    // Through Store, which writes this browser's copy first - the felt changes
    // under the dialog immediately - and tells the server afterwards, so the
    // choice is already made when this person opens their phone.
    if (window.Store) Store.set(KEYS[name], value);
    document.body.setAttribute(look.attr, value);
    syncOptions();
  }

  function onClick(e) {
    const btn = e.target.closest('[data-look]');
    if (!btn) return;
    set(btn.dataset.look, btn.dataset.value);
  }

  function onKey(e) {
    const btn = e.target.closest('[data-look]');
    if (!btn) return;
    const list = options(btn.dataset.look);
    const idx = list.indexOf(btn);
    if (idx < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % list.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (idx - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    set(list[next].dataset.look, list[next].dataset.value);
    list[next].focus();
  }

  function open() {
    const el = modal();
    if (!el) return;
    syncOptions();
    el.classList.remove('hidden');
  }

  function close() {
    const el = modal();
    if (el) el.classList.add('hidden');
  }

  function init() {
    const el = modal();
    if (el) {
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', onKey);
    }
    const done = document.getElementById('btnCloseCards');
    if (done) done.addEventListener('click', close);
    apply();
  }

  window.CardLook = { apply, set, open, close, current };

  // The script is deferred, so this runs with the document parsed and long
  // before the first hand is drawn: a reload never shows a frame of a deck
  // this person did not choose.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
