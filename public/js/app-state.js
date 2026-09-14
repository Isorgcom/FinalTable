const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const SUIT_COLORS = { hearts: 'red', diamonds: 'red', clubs: 'black', spades: 'black' };
const SUIT_NAMES = { hearts: 'Hearts', diamonds: 'Diamonds', clubs: 'Clubs', spades: 'Spades' };
const RANK_NAMES = {
  A: 'Ace',
  K: 'King',
  Q: 'Queen',
  J: 'Jack',
  10: 'Ten',
  9: 'Nine',
  8: 'Eight',
  7: 'Seven',
  6: 'Six',
  5: 'Five',
  4: 'Four',
  3: 'Three',
  2: 'Two',
};

// Browser storage, behind a guard. Private-mode Safari throws on the accessor
// itself, and a poker table is not worth a blank screen over a remembered
// preference. The lobby has carried its own copy of this since before there
// was anywhere shared to put it.
window.Store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch (_err) {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_err) {
      /* a preference that cannot be saved is not worth an error */
    }
    // Some of these belong to the person rather than the browser. The local
    // write above still happens first and the table reads it immediately, so
    // nothing waits on the network; this only tells the server afterwards.
    if (SYNCED_PREFS[key]) pushPreference(key, value);
  },
};

// Which chair the viewer has asked to be shown in.
const VIEWER_SLOT_KEY = 'finaltable_my_slot';

// Whether the table is silent.
const MUTED_KEY = 'finaltable_muted';

// Which side panel tab opens. side-panel.js owns the panel; the key lives here
// because Store has to know it is one of the ones that travels.
const SIDE_PANEL_TAB_KEY = 'finaltable_side_panel_tab';
window.SIDE_PANEL_TAB_KEY = SIDE_PANEL_TAB_KEY;

// How the cards look: the back, two colours or four, and whether the face
// carries a large index. card-look.js owns what they mean; the names live here
// with the other keys that travel, for the same reason the tab's does.
const CARD_LOOK_KEYS = {
  cardBack: 'finaltable_card_back',
  deck: 'finaltable_deck',
  cardFace: 'finaltable_card_face',
};
window.CARD_LOOK_KEYS = CARD_LOOK_KEYS;

// ── Preferences that follow the player ───────────────────────────────────
//
// Some settings belong to a person, not to the browser they happen to be
// using: whether the table is silent, which chair they sit in, which panel tab
// opens, and how the cards are drawn. They are still written to localStorage
// first, because that is what makes them instant and what a guest has; the
// server copy is what makes the iPad agree with the phone, for anyone signed
// in with a Game Night account, whose devices are one identity.
//
// Each entry maps the storage key to the name the server knows it by, and the
// pair of functions that carry a value across the wire: the store holds
// strings, the server holds the real types.
const SYNCED_PREFS = {
  [MUTED_KEY]: {
    name: 'muted',
    toServer: (raw) => raw === '1',
    toStore: (value) => (value ? '1' : null),
  },
  [VIEWER_SLOT_KEY]: {
    name: 'seat',
    toServer: (raw) => (raw === null ? null : Number(raw)),
    toStore: (value) => (value === null ? null : String(value)),
  },
  [SIDE_PANEL_TAB_KEY]: {
    name: 'panelTab',
    toServer: (raw) => raw,
    toStore: (value) => value,
  },
  // The three card settings are names on both sides of the wire, so they
  // travel as they are.
  [CARD_LOOK_KEYS.cardBack]: {
    name: 'cardBack',
    toServer: (raw) => raw,
    toStore: (value) => value,
  },
  [CARD_LOOK_KEYS.deck]: {
    name: 'deck',
    toServer: (raw) => raw,
    toStore: (value) => value,
  },
  [CARD_LOOK_KEYS.cardFace]: {
    name: 'cardFace',
    toServer: (raw) => raw,
    toStore: (value) => value,
  },
};

// Changes are gathered and sent together on the next beat. Pressing a tab
// three times while making up your mind is one save, not three, and the beat
// is short enough that closing the tab straight after still catches it.
const PREF_PUSH_MS = 300;
let _prefPending = null;
let _prefTimer = null;

let _adoptingPrefs = false;

function pushPreference(key, raw) {
  const spec = SYNCED_PREFS[key];
  // Adopting writes through the same setters the player's own presses do, and
  // sending those straight back would be a round trip to agree with itself.
  if (!spec || _adoptingPrefs) return;
  if (!_prefPending) _prefPending = {};
  _prefPending[spec.name] = spec.toServer(raw === undefined ? null : raw);
  if (_prefTimer) return;
  _prefTimer = setTimeout(() => {
    _prefTimer = null;
    const patch = _prefPending;
    _prefPending = null;
    // No socket yet, or nothing connected: the local write stands, and the
    // next change after identifying carries this one with it. `socket` is the
    // module-level binding below, not a window property, so it is named
    // directly - reaching for window.socket finds nothing.
    if (patch && socket && socket.connected) socket.emit('savePreferences', patch);
  }, PREF_PUSH_MS);
}

// What the server has for this identity, on identifying. It wins: opening the
// iPad is asking for the settings this person chose, not the ones this browser
// last happened to see. A key the server has never been told about is left
// alone, so a new device keeps its own until it changes something.
//
// Written straight to localStorage rather than through Store.set, because
// adopting is not a change to push back.
function adoptPreferences(prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  _adoptingPrefs = true;
  try {
    applyPreferences(prefs);
  } finally {
    _adoptingPrefs = false;
  }
}

function applyPreferences(prefs) {
  for (const [key, spec] of Object.entries(SYNCED_PREFS)) {
    if (!Object.prototype.hasOwnProperty.call(prefs, spec.name)) continue;
    const stored = spec.toStore(prefs[spec.name]);
    try {
      if (stored === null || stored === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, stored);
    } catch (_err) {
      /* private mode: the settings stay as this browser has them */
    }
  }
  // Two of the three are read once and held. Writing the store is not enough
  // for those; they have to be told, or the mute stays off until a reload and
  // the panel opens on whatever it opened on.
  // SFX and the two bindings below are declared later in this file with const
  // and let, which puts them in the script's scope rather than on window. They
  // are named directly for that reason: a window.SFX guard is always false and
  // would skip this silently, which is exactly how it failed the first time.
  if (Object.prototype.hasOwnProperty.call(prefs, 'muted')) {
    SFX.muted = !!prefs.muted;
    if (window.syncMuteLabel) syncMuteLabel();
  }
  if (window.SidePanel && typeof prefs.panelTab === 'string') {
    SidePanel.select(prefs.panelTab);
  }
  // The cards are drawn from attributes on <body>, which the store alone does
  // not move. Cheap enough to re-read all three rather than work out which of
  // them this payload actually carried.
  if (window.CardLook) CardLook.apply();
  // The seat is read from the store on every render, so the next one has it.
  // Only worth forcing if there is a table up to redraw.
  if (typeof renderPlayersIncremental === 'function' && gameState) {
    renderPlayersIncremental();
  }
}
window.adoptPreferences = adoptPreferences;

// ── Where the seats go ───────────────────────────────────────────────────
//
// Eight chairs around the felt: two across the top, two a side, two along the
// bottom. What matters as much as where they are is where they are NOT - there
// is deliberately nothing at top centre and nothing at bottom centre, because
// those two lanes belong to the tournament level banner and the action bar,
// and every collision between the furniture and a plate has come from a seat
// parked in one of them.
//
// Each chair is an offset from the felt's centre in units of the seat ring's
// radii, so every per-breakpoint override of --seat-rx / --seat-ry still pulls
// the whole arrangement in on a narrow screen. That is what keeps plates on
// the display: a fixed percentage would put the side chairs off the edge of an
// iPad in portrait, which is the bug commit a48b505 fixed once already.
//
// Order is CLOCKWISE from chair 0, and it has to be. table-render.js maps
// display slot i to engine seat (myIndex + i) and the engine advances by
// increasing seat index, so slot i+1 must be the next player to act. Sweeping
// the other way makes the action visibly run backwards around the table.
const SEAT_SLOTS = [
  { dx: 0.55, dy: 1.06 }, // 0 bottom right - the viewer, by default
  { dx: -0.55, dy: 1.06 }, // 1 bottom left
  { dx: -1.16, dy: 0.4 }, // 2 lower left
  { dx: -1.16, dy: -0.62 }, // 3 upper left
  { dx: -0.55, dy: -1.16 }, // 4 top left
  { dx: 0.55, dy: -1.16 }, // 5 top right
  { dx: 1.16, dy: -0.62 }, // 6 upper right
  { dx: 1.16, dy: 0.4 }, // 7 lower right
];

// What each chair is called, in the same order as SEAT_SLOTS. A menu that says
// "chair 5" tells you nothing; one that says "top right" tells you where you
// will be sitting.
const SEAT_SLOT_NAMES = [
  'bottom right',
  'bottom left',
  'lower left',
  'upper left',
  'top left',
  'top right',
  'upper right',
  'lower right',
];

// A table for fewer than eight uses a spread of the same chairs rather than a
// ring of its own, so a six-max table is the eight-max table with two chairs
// taken out and everyone still sits where they would have sat.
function slotsForCapacity(capacity) {
  const n = Math.max(1, Math.min(SEAT_SLOTS.length, capacity));
  if (n === SEAT_SLOTS.length) return SEAT_SLOTS.map((_, i) => i);
  const picks = [];
  for (let i = 0; i < n; i++)
    picks.push(Math.round((i * SEAT_SLOTS.length) / n) % SEAT_SLOTS.length);
  return picks;
}

// The chairs a table of this size actually has, named. Indexed the way the
// stored preference is - by place in the ring, not by which of the eight
// physical chairs it happens to be.
function seatSlotNames(capacity) {
  return slotsForCapacity(capacity).map((physical) => SEAT_SLOT_NAMES[physical]);
}

// The ring radii, read from CSS so a breakpoint can pull them in. Cached: this
// is a forced style read, and it used to happen on every call - several times
// per render, every render.
let _ringCache = null;
function ringRadii() {
  if (_ringCache) return _ringCache;
  const rootStyle = getComputedStyle(document.documentElement);
  const num = (name, fallback) => parseFloat(rootStyle.getPropertyValue(name)) || fallback;
  _ringCache = {
    rx: num('--seat-rx', 53),
    ry: num('--seat-ry', 52),
    betRx: num('--bet-rx', 34),
    betRy: num('--bet-ry', 36),
  };
  return _ringCache;
}
function invalidateRingCache() {
  _ringCache = null;
}

// Positions in DISPLAY order: index 0 is wherever the viewer has asked to be
// shown, and the rest follow clockwise from there. Callers index by display
// order and never need to know which physical chair that is.
function getSeatPositions(capacity, mySlot = 0) {
  const slots = slotsForCapacity(capacity);
  const n = slots.length;
  const start = ((Math.round(mySlot) % n) + n) % n;
  const { rx, ry, betRx, betRy } = ringRadii();
  const cx = 50; // felt centre x, %
  const cy = 44; // felt centre y, % - the ring rides a little high on the stage

  const positions = [];
  for (let i = 0; i < n; i++) {
    const slotIndex = slots[(start + i) % n];
    const { dx, dy } = SEAT_SLOTS[slotIndex];
    positions.push({
      // Which chair this is, so a seat element can carry it and a right-click
      // can name it. Display order changes with the viewer's choice; this does
      // not.
      slot: (start + i) % n,
      left: cx + dx * rx + '%',
      top: cy + dy * ry + '%',
      // The street bet sits on the same bearing but well inside, on the cloth
      // rather than under the plate.
      betLeft: cx + dx * betRx + '%',
      betTop: cy + dy * betRy + '%',
      transform: 'translate(-50%, -50%)',
    });
  }
  return positions;
}

// ============================================================
//  APPLICATION STATE
//  Note: globals are used intentionally for simplicity in this
//  vanilla JS app. Functions below are exposed to window scope
//  for onclick handlers in HTML.
// ============================================================

let socket = null; // Socket.IO connection
let myId = null; // Current player's socket ID
let _visibilityHandler = null; // Mobile foreground resume handler
let gameState = null; // Latest game state from server
let prevCommunityCount = 0; // Track community cards for animation
let messages = []; // Chat/log message history
let tournamentTimer = null; // Tournament countdown interval
let _resultShownThisRound = false; // Debounce: prevent double result popup

// ============================================================
//  SOUND SYSTEM - Web Audio API synthesized sounds
// ============================================================
const SFX = {
  ctx: null,
  // Decoded one-shot samples, by name. Everything else here is synthesised;
  // these are recordings, for the sounds a synth cannot fake.
  samples: {},
  _lastChipSound: 0,
  _lastShuffleSound: 0,
  // Read once, from the same store the seat preference uses. A table people
  // play at work or next to a sleeping house needs an off switch, and it has
  // to still be off after a reload.
  muted: window.Store ? Store.get(MUTED_KEY) === '1' : false,
  isMuted() {
    return !!this.muted;
  },
  setMuted(on) {
    this.muted = !!on;
    if (window.Store) Store.set(MUTED_KEY, this.muted ? '1' : null);
    // Coming off mute is a gesture like any other, and the context may have
    // been parked the whole time it was silent.
    if (!this.muted) this.unlock();
  },
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      return;
    }
    // Fetched here rather than at load: init runs on the first click, which is
    // the same gesture that lets audio play at all, and is long before the
    // first hand is dealt.
    const chips = document.getElementById('sfxChips');
    this.loadSample('chips', chips ? chips.getAttribute('href') : '/audio/chips.mp3');
    const card = document.getElementById('sfxCard');
    this.loadSample('card', card ? card.getAttribute('href') : '/audio/card.mp3');
    const shuffle = document.getElementById('sfxShuffle');
    this.loadSample('shuffle', shuffle ? shuffle.getAttribute('href') : '/audio/shuffle.mp3');
    const check = document.getElementById('sfxCheck');
    // Trimmed and levelled: as delivered it is 187ms of sound inside 1.13s,
    // starting a third of a second in and peaking at 0.043 - late and inaudible
    // beside the others.
    this.loadSample('check', check ? check.getAttribute('href') : '/audio/check.m4a', {
      dress: true,
      peak: 0.7,
    });
  },
  // iOS hands back a suspended AudioContext unless it is created inside a
  // gesture Safari recognises, and suspends it again every time the tab goes to
  // the background or the device locks. Nothing here used to call resume(), and
  // the one unlock attempt was spent on whichever click happened to come first,
  // so a context that started or ended up suspended stayed that way and the
  // table went quiet for the rest of the session. Every gesture is another
  // chance now, and coming back to the tab is one too.
  unlock() {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  },
  listen() {
    if (this._listening) return;
    this._listening = true;
    const wake = () => this.unlock();
    // Deliberately not { once: true }: the first gesture is not reliably the
    // one that works, and there is no cost to checking a context that is
    // already running.
    for (const ev of ['pointerdown', 'touchend', 'keydown']) {
      document.addEventListener(ev, wake, { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.unlock();
    });
  },
  // A recording made on a phone is not a sound effect yet: it arrives with
  // silence at both ends and a peak far below the others. Rather than keeping a
  // converted copy beside the original, the file is taken as delivered and the
  // silence and the level are dealt with here, once, at decode time.
  _dress(decoded, peakTarget) {
    const channels = decoded.numberOfChannels;
    const threshold = 0.01;
    let first = decoded.length;
    let last = -1;
    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
        if (v > threshold) {
          if (i < first) first = i;
          if (i > last) last = i;
        }
      }
    }
    if (last < first || !peak) return decoded;
    // A couple of milliseconds of run-up, so the first sample is not a step.
    const pad = Math.round(decoded.sampleRate * 0.002);
    const start = Math.max(0, first - pad);
    const end = Math.min(decoded.length, last + pad);
    const gain = peakTarget ? peakTarget / peak : 1;
    const out = this.ctx.createBuffer(channels, end - start, decoded.sampleRate);
    for (let c = 0; c < channels; c++) {
      const src = decoded.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < dst.length; i++) dst[i] = src[start + i] * gain;
    }
    return out;
  },
  loadSample(name, url, opts) {
    if (!this.ctx || !url) return;
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .then((buf) => this.ctx.decodeAudioData(buf))
      .then((decoded) => {
        this.samples[name] = opts && opts.dress ? this._dress(decoded, opts.peak) : decoded;
      })
      .catch(() => {
        // No sample: play() falls back to the synthesised version.
      });
  },
  // whenOffset books the sound that many seconds ahead. Web Audio schedules
  // against its own clock, so a card landing in 700ms sounds exactly then even
  // though the main thread is busy laying out twenty cards; a setTimeout chain
  // at 55ms spacing audibly jitters. rate detunes a repeated sample so a deal
  // sounds like a deck rather than a machine.
  playSample(name, gain, whenOffset, rate) {
    if (this.muted) return false;
    const buffer = this.samples[name];
    if (!this.ctx || !buffer) return false;
    try {
      const src = this.ctx.createBufferSource();
      const vol = this.ctx.createGain();
      src.buffer = buffer;
      if (rate) src.playbackRate.value = rate;
      vol.gain.value = gain === undefined ? 0.5 : gain;
      src.connect(vol);
      vol.connect(this.ctx.destination);
      // A negative or already-passed time is played immediately rather than
      // throwing, which is what a render that ran long should do.
      src.start(this.ctx.currentTime + Math.max(0, whenOffset || 0));
      return true;
    } catch (e) {
      return false;
    }
  },
  // Chips moving on the felt, wherever they are going. Called once per player
  // in a flight, so a nine-handed sweep would otherwise fire nine overlapping
  // copies of the same recording: one per burst is the sound of a table, nine
  // is a landslide.
  chipsMoved() {
    // Gated here as well as in playSample: this one falls back to a
    // synthesised burst when the recording is missing, and that route does not
    // go past playSample at all.
    if (this.muted) return;
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    const now = Date.now();
    if (now - this._lastChipSound < 220) return;
    this._lastChipSound = now;
    if (!this.playSample('chips', 0.45)) {
      try {
        this._chips(this.ctx.currentTime, 2);
      } catch (e) {}
    }
  },
  // The deck, once as a hand is dealt. Played at offset 0 from the same
  // function that books the card snaps, so the shuffle is still ringing when
  // the first card lands rather than finishing into silence. There is no
  // synthesised fallback on purpose: a synth shuffle is white noise with a
  // hopeful name, and a sample that failed to decode is better as nothing.
  deckShuffled() {
    if (this.muted) return;
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    const now = Date.now();
    // One deal is one shuffle. The deal animation is latched to fire once per
    // hand, but a repeated render arriving inside that window must not stack a
    // second copy on top of the first.
    if (now - this._lastShuffleSound < 900) return;
    this._lastShuffleSound = now;
    this.playSample('shuffle', 0.4);
  },

  // Cards being placed, one snap each, booked against the animation's own
  // schedule. Takes every offset at once because reduced motion collapses the
  // whole deal into a single frame: a second of audio trailing an instant
  // visual is worse than one sound, and that decision belongs here rather than
  // at each call site.
  cardsPlaced(offsets) {
    if (this.muted) return;
    if (!offsets || !offsets.length) return;
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    const still =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const schedule = still ? [0] : offsets;
    for (const offset of schedule) {
      // A few percent either way. Identical copies of one recording read as a
      // machine gun; a deck does not.
      this.playSample('card', 0.32, offset, 0.96 + Math.random() * 0.08);
    }
  },

  play(type) {
    if (this.muted) return;
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    // Scheduling into a parked context is silence with extra steps. Ask for it
    // back and give up on this one sound; the next will have somewhere to go.
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const now = this.ctx.currentTime;
      switch (type) {
        case 'check':
          // The recording if it decoded, the synthesised tap if it did not -
          // the same fallback chipsMoved uses, so a missing or undecodable file
          // costs the sound rather than the table.
          if (!this.playSample('check', 0.5)) this._tap(now, 400, 0.03);
          break;
        case 'fold':
          this._swoosh(now);
          break;
        case 'allin':
          this._allin(now);
          break;
        case 'win':
          this._win(now);
          break;
        case 'turn':
          this._bell(now);
          break;
        case 'warn':
          this._warn(now);
          break;
      }
    } catch (e) {}
  },
  _click(t, freq, dur) {
    const o = this.ctx.createOscillator(),
      g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur);
  },
  _tap(t, freq, dur) {
    const o = this.ctx.createOscillator(),
      g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur);
  },
  _chips(t, count) {
    for (let i = 0; i < count; i++) {
      const delay = i * 0.06;
      this._click(t + delay, 2000 + Math.random() * 1500, 0.03);
    }
  },
  _swoosh(t) {
    const o = this.ctx.createOscillator(),
      g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(500, t);
    o.frequency.exponentialRampToValueAtTime(100, t + 0.15);
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g);
    g.connect(this.ctx.destination);
    o.start(t);
    o.stop(t + 0.2);
  },
  _allin(t) {
    [400, 500, 600, 800].forEach((f, i) => {
      this._click(t + i * 0.08, f, 0.12);
    });
  },
  _win(t) {
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = this.ctx.createOscillator(),
        g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.12, t + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.3);
      o.connect(g);
      g.connect(this.ctx.destination);
      o.start(t + i * 0.15);
      o.stop(t + i * 0.15 + 0.35);
    });
  },
  // The five-second warning. Deliberately not _bell: that rising pair is
  // already "it is your turn", and a warning that sounds like the turn arriving
  // is worse than no warning at all. This one falls instead, and sits lower.
  _warn(t) {
    this._click(t, 740, 0.1);
    this._click(t + 0.14, 520, 0.16);
  },
  _bell(t) {
    this._click(t, 1200, 0.08);
    this._click(t + 0.1, 1600, 0.06);
  },
};

// ============================================================
//  v11: MODE SELECTION & PRACTICE FLOW
// ============================================================

// Hamburger menu toggle
function toggleMenu() {
  const dd = document.getElementById('menuDropdown');
  dd.classList.toggle('open');
}
// Close menu on outside click
document.addEventListener('click', (e) => {
  const dd = document.getElementById('menuDropdown');
  const toggle = document.getElementById('menuToggle');
  if (dd && toggle && !dd.contains(e.target) && !toggle.contains(e.target)) {
    dd.classList.remove('open');
  }
});

function setSitOut(enabled) {
  if (!socket || !gameState) return;
  const me = gameState.players.find((p) => p.id === myId);
  if (!me || me.isSpectator || !!me.autoPlay === enabled) return;
  socket.emit('setAutoPlay', { enabled });
}

// Arming a line for a turn that has not opened yet. The server holds it, so it
// survives a reload and a phone locking itself; the local write is only so the
// button responds to the tap, and the echo puts it right if the server disagreed.
// Turning a card over after taking a pot nobody contested. The server decides
// whether the offer stands and closes it the moment it is answered; this only
// asks. No optimistic write: the cards coming back face up in the next push is
// the whole of the feedback, and guessing at it would show a card that the
// server might have refused.
function showMyCards(indices) {
  if (!socket || !gameState || !gameState.myShow) return;
  const cards = (Array.isArray(indices) ? indices : [indices]).filter((i) => i === 0 || i === 1);
  if (!cards.length) return;
  socket.emit('showCards', { cards });
}

function declineShowMyCards() {
  if (!socket || !gameState || !gameState.myShow) return;
  socket.emit('declineShow');
}

function armPreAction(kind) {
  if (!socket || !gameState) return;
  const me = gameState.players.find((p) => p.id === myId);
  if (!me || me.isSpectator || me.autoPlay) return;
  const armed = gameState.myPreAction;
  // Tapping the armed one takes it back; the buttons are one choice, not four.
  const next = armed && armed.kind === kind ? null : kind;
  const payload = { kind: next };
  if (next === 'call') {
    // The price it is being armed against travels with it, and the engine
    // refuses to play it at any other.
    payload.atBet = gameState.currentBet;
    payload.atToCall = Math.max(0, gameState.currentBet - (me.bet || 0));
  }
  gameState.myPreAction = next
    ? { kind: next, atBet: payload.atBet ?? null, atToCall: payload.atToCall ?? null }
    : null;
  updatePreActionPanel();
  socket.emit('armPreAction', payload);
}

function setSitOutNextHand(enabled) {
  if (!socket || !gameState) return;
  const me = gameState.players.find((p) => p.id === myId);
  if (!me || me.autoPlay) return;
  gameState.mySitOutNextHand = enabled;
  updatePreActionPanel();
  socket.emit('setSitOutNextHand', { enabled });
}

// ============================================================
//  v11: UPDATE MODE-DEPENDENT UI
// ============================================================

function updateModeUI() {
  if (!gameState) return;
  const badge = document.getElementById('modeBadge');
  if (badge) {
    badge.className = 'mode-badge tournament';
    badge.textContent = 'Tournament';
  }
  const autoBtn = document.getElementById('btnAutoPlay');
  const banner = document.getElementById('seatBanner');
  if (!autoBtn) return;
  const me = gameState.players.find((p) => p.id === myId);
  // Holding a seat is the whole condition. It used to also require a hand to
  // be in progress, which meant the control vanished between every hand, and
  // a seat that is sitting out folds instantly: the gap was most of the time,
  // and the way back was a button that flickered past.
  const seated = !!me && !me.isSpectator;
  // The way back in is never gated on anything but sitting out. Spectating a
  // hand you were dealt into late is a state you can also be sitting out in,
  // and hiding the button there is how someone gets stuck.
  const sittingOut = !!me && !!me.autoPlay;

  if (banner) banner.classList.toggle('hidden', !sittingOut);

  // One control per state: the banner owns the way back in, the top bar owns
  // the way out. Two buttons for the same thing is how you end up clicking
  // the wrong one.
  autoBtn.classList.toggle('hidden', !seated || sittingOut);
  autoBtn.classList.remove('autoplay-active');
  autoBtn.textContent = 'sit out';
  autoBtn.title = 'Sit out: check when free, fold to a bet';
}
