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

// Seat positions (percentages relative to table wrapper) for up to 10 players
// Dynamic seat positions: evenly distributed around the ellipse based on player count
// Position 0 is always bottom center (the viewing player)
// Other positions are evenly spread around the remaining arc
function getSeatPositions(playerCount) {
  // betLeft/betTop: where this seat's street bet sits on the felt, on an
  // inner ellipse concentric with the seat ring so it scales with the table.
  const me = {
    left: '50%',
    top: '105%',
    betLeft: '50%',
    betTop: '88%',
    transform: 'translate(-50%, -20px)',
  };
  if (playerCount <= 1) return [me];

  const positions = [me];

  // Remaining players: spread evenly around the arc above the viewer.
  //
  // Angles below are standard math convention, NOT CSS. `top` is computed as
  // cy - ry*sin(a), so 0deg=right, 90deg=TOP, 180deg=left, 270deg=bottom, and
  // an INCREASING angle sweeps counter-clockwise on screen.
  //
  // Seat order must run CLOCKWISE, because poker action moves to the left of
  // the button. table-render.js maps display slot i to engine seat
  // (myIndex + i), and the engine advances by increasing seat index, so slot
  // i+1 is always the next player to act. Sweeping the other way makes the
  // action visibly run backwards around the table.
  const others = playerCount - 1;
  const arcStart = 225; // bottom-left: the seat immediately clockwise of the viewer
  const arcSpan = -270; // clockwise over 3/4 of the ellipse, leaving the bottom free

  // Radii come from CSS so a breakpoint can pull the ring in on a narrow
  // felt (tokens.css --seat-rx / --seat-ry; responsive.css overrides).
  const rootStyle = getComputedStyle(document.documentElement);
  const rx = parseFloat(rootStyle.getPropertyValue('--seat-rx')) || 53; // horizontal radius %
  const ry = parseFloat(rootStyle.getPropertyValue('--seat-ry')) || 52; // vertical radius %
  const betRx = parseFloat(rootStyle.getPropertyValue('--bet-rx')) || 34;
  const betRy = parseFloat(rootStyle.getPropertyValue('--bet-ry')) || 30;
  const cx = 50; // center x %
  const cy = 44; // center y %

  for (let i = 0; i < others; i++) {
    const frac = others === 1 ? 0.5 : i / (others - 1);
    const angleDeg = arcStart + arcSpan * frac;
    const rad = ((angleDeg % 360) * Math.PI) / 180;

    const left = cx + rx * Math.cos(rad);
    const top = cy - ry * Math.sin(rad); // CSS y is inverted

    // Same angle, smaller ellipse: clear of the plate and of the board.
    const betLeft = cx + betRx * Math.cos(rad);
    const betTop = cy - betRy * Math.sin(rad);

    positions.push({
      left: left + '%',
      top: top + '%',
      betLeft: betLeft + '%',
      betTop: betTop + '%',
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
let _heartbeatTimer = null; // Mobile keep-alive interval
let _visibilityHandler = null; // Mobile foreground resume handler
let gameState = null; // Latest game state from server
let prevCommunityCount = 0; // Track community cards for animation
let messages = []; // Chat/log message history
let tournamentTimer = null; // Tournament countdown interval
let _resultShownThisRound = false; // Debounce: prevent double result popup
let _resumeInteractionGuardUntil = 0; // Brief guard after leaving auto-play

// ============================================================
//  SOUND SYSTEM - Web Audio API synthesized sounds
// ============================================================
const SFX = {
  ctx: null,
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {}
  },
  play(type) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      switch (type) {
        case 'deal':
          this._click(now, 800, 0.04);
          break;
        case 'check':
          this._tap(now, 400, 0.03);
          break;
        case 'call':
          this._chips(now, 1);
          break;
        case 'raise':
          this._chips(now, 3);
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
  if (!enabled) {
    _resumeInteractionGuardUntil = Date.now() + 900;
  }
  socket.emit('setAutoPlay', { enabled });
}

function hasResumeInteractionGuard() {
  return Date.now() < _resumeInteractionGuardUntil;
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
