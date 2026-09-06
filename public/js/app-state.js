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

// ── Mode & Equity State ──
let _currentEquity = null; // Currently displayed equity data
let _currentEquityContextKey = null; // Board-state key for the currently displayed oracle result
let _eqRulesShown = false; // Whether equity rules popup has been shown
let _eqPaidCount = 0; // Cumulative paid equity uses (for easter egg)
let _dalioShown = false; // Dalio easter egg shown flag
const EQ_RULES_NO_SHOW_KEY = 'finaltable:eqRulesNoShow:v2';
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



// ============================================================
//  v11: EQUITY SYSTEM
// ============================================================

function requestEquity() {
  if (!socket || !gameState) return;

  if ((gameState.communityCards || []).length < 3) {
    addLog('ℹ️ Equity oracle opens on the flop');
    return;
  }

  const currentContextKey = getEquityContextKey();
  if (_currentEquity && _currentEquityContextKey && currentContextKey === _currentEquityContextKey) {
    return;
  }

  // Practice mode: equity is free, no payment needed
  if (gameState.gameMode === 'practice') {
    socket.emit('requestEquity');
    return;
  }

  const es = gameState.equityState;
  const price = gameState.equityPrice;

  // First use: show rules popup
  if (!_eqRulesShown && !localStorage.getItem(EQ_RULES_NO_SHOW_KEY)) {
    _eqRulesShown = true;
    document.getElementById('eqRulesModal').classList.remove('hidden');
    return;
  }

  // Free uses remaining → request directly
  if (es.freeLeft > 0) {
    socket.emit('requestEquity');
    return;
  }

  // Paid → always confirm with the current price
  const me = gameState.players.find((p) => p.id === myId);
  if (!Number.isFinite(price) || price <= 0) {
    addLog('⚠️ Equity unavailable right now');
    return;
  }
  if (me) {
    document.getElementById('eqConfirmPrice').textContent = price;
    const pct = me.chips > 0 ? Math.round((price / me.chips) * 100) : 0;
    document.getElementById('eqConfirmWarn').textContent =
      pct > 0 ? `${pct}% of your current stack will be spent.` : '';
    document.getElementById('eqConfirmModal').classList.remove('hidden');
    return;
  }

  socket.emit('requestEquity');
}

function closeEqRules() {
  document.getElementById('eqRulesModal').classList.add('hidden');
  if (document.getElementById('eqRulesNoShow').checked) {
    localStorage.setItem(EQ_RULES_NO_SHOW_KEY, '1');
  }
  requestEquity();
}

function cancelEqConfirm() {
  document.getElementById('eqConfirmModal').classList.add('hidden');
}

function confirmEqPurchase() {
  document.getElementById('eqConfirmModal').classList.add('hidden');
  if (!gameState) return;
  const price = gameState.equityPrice;
  if (!Number.isFinite(price) || price <= 0) {
    addLog('⚠️ Equity unavailable right now');
    return;
  }
  socket.emit('requestEquity');
}

function showEquityDisplay(eqData) {
  if (!eqData || eqData.error) return;
  _currentEquity = eqData;
  _currentEquityContextKey = getEquityContextKey();
  updateEquityUI(eqData);
}

function getEquityContextKey() {
  if (!gameState || !myId) return null;
  const me = (gameState.players || []).find((player) => player.id === myId);
  if (!me || !me.holeCards || me.holeCards.length < 2) return null;
  return JSON.stringify({
    roundCount: gameState.roundCount,
    board: (gameState.communityCards || []).map((card) => `${card.rank}${card.suit}`),
    hero: me.holeCards.map((card) => `${card.rank}${card.suit}`),
  });
}

function updateEquityUI(eqData) {
  const detail = document.getElementById('eqSideDetail');
  const barFill = document.getElementById('eqSideBarFill');
  const label = document.getElementById('eqSideLabel');
  const sub = document.getElementById('eqSideSub');
  if (!detail || !barFill || !label) return;

  if (!eqData || eqData.equity === null || eqData.equity === undefined) {
    detail.classList.add('hidden');
    return;
  }

  const eq = typeof eqData.equity === 'number' ? eqData.equity : parseFloat(eqData.equity);

  detail.classList.remove('hidden');
  barFill.style.width = eq + '%';
  // Old Money palette: danger < 30, cream 30-60, success > 60
  if (eq < 30) barFill.style.background = '#8b3a3a';
  else if (eq > 60) barFill.style.background = '#4a7a5a';
  else barFill.style.background = '#e8e0d0';

  let text = '';
  if (eqData.label) {
    const labelMap = {
      monster: 'monster',
      strong: 'strong',
      decent: 'decent',
      'strong draw': 'strong draw',
      drawing: 'drawing',
      marginal: 'marginal',
      weak: 'weak',
      danger: 'danger',
    };
    const enLabel = labelMap[eqData.label] || eqData.label;
    text += enLabel + ' ';
  }
  text += eq.toFixed(1) + '%';
  // Use textContent for base text, then append delta as a safe span
  label.textContent = text;
  if (eqData.delta !== null && eqData.delta !== undefined) {
    const sign = eqData.delta >= 0 ? '▲' : '▼';
    const color = eqData.delta >= 0 ? '#4a7a5a' : '#8b3a3a';
    const deltaSpan = document.createElement('span');
    deltaSpan.style.color = color;
    deltaSpan.textContent = ` ${sign}${Math.abs(eqData.delta).toFixed(1)}`;
    label.appendChild(deltaSpan);
  }

  if (eqData.outsDesc) {
    sub.textContent = eqData.outsDesc;
    sub.style.display = '';
  } else if (eqData.handName) {
    sub.textContent = eqData.handName;
    sub.style.display = '';
  } else {
    sub.style.display = 'none';
  }
}

function showFeeFloat(cost) {
  const el = document.createElement('div');
  el.className = 'fee-float';
  el.textContent = `🔮 -${cost} chips`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function updateEquityButton() {
  const widget = document.getElementById('eqSide');
  const button = document.getElementById('eqSideBtn');
  const badge = document.getElementById('eqSideBadge');
  const detail = document.getElementById('eqSideDetail');
  if (!widget || !button || !badge || !detail || !gameState) {
    if (widget) widget.classList.add('hidden');
    return;
  }

  const me = gameState.players.find((p) => p.id === myId);
  const hasCards = me && !me.folded && me.holeCards && me.holeCards.length === 2;
  const inGame = gameState.isRunning && gameState.phase !== 'showdown';
  const postFlop = (gameState.communityCards || []).length >= 3;

  // Practice mode
  if (gameState.gameMode === 'practice') {
    widget.classList.toggle('hidden', !(hasCards && inGame));
    if (hasCards && inGame) {
      button.classList.toggle('eq-side-btn-disabled', !postFlop);
      badge.textContent = postFlop ? 'auto' : 'flop';
      if (!postFlop) detail.classList.add('hidden');
    }
    return;
  }

  // Cash/tournament: show widget when player has cards
  if (!hasCards || !inGame) {
    widget.classList.add('hidden');
    return;
  }

  widget.classList.remove('hidden');
  button.classList.toggle('eq-side-btn-disabled', !postFlop);
  if (!postFlop) {
    badge.textContent = 'flop';
    detail.classList.add('hidden');
    return;
  }
  const es = gameState.equityState || { freeLeft: 3, priceLevel: 0 };
  const price = gameState.equityPrice || gameState.bigBlind;
  badge.textContent = es.freeLeft > 0 ? `free×${es.freeLeft}` : `${price}`;
  if (!_currentEquity) {
    detail.classList.add('hidden');
  }
}

function onEqSideClick() {
  if (!gameState) return;
  requestEquity();
}

// 🔮 Dalio
function showDalioEasterEgg() {
  const modal = document.getElementById('dalioModal');
  if (modal) modal.classList.remove('hidden');
}
function closeDalioModal() {
  document.getElementById('dalioModal').classList.add('hidden');
}

function toggleAutoPlay() {
  if (!socket || !gameState) return;
  const me = gameState.players.find((p) => p.id === myId && !p.isNPC);
  if (!me || me.isSpectator) return;
  if (me.autoPlay) {
    _resumeInteractionGuardUntil = Date.now() + 900;
  }
  socket.emit('setAutoPlay', { enabled: !me.autoPlay });
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
  if (!autoBtn) return;
  const me = gameState.players.find((p) => p.id === myId && !p.isNPC);
  if (!me || me.isSpectator || gameState.gameOver || !gameState.isRunning) {
    autoBtn.classList.add('hidden');
    autoBtn.classList.remove('autoplay-active');
  } else {
    autoBtn.classList.remove('hidden');
    autoBtn.classList.toggle('autoplay-active', !!me.autoPlay);
    autoBtn.textContent = me.autoPlay ? 'resume' : 'auto';
    autoBtn.title = me.autoPlay ? 'Resume manual control' : 'Let the computer play this seat';
  }
}

