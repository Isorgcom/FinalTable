function sendAction(action, amount) {
  if (!socket) return;
  socket.emit('action', { action, amount });
}

function setAnimationDelay(el, delaySeconds) {
  el.style.setProperty('--deal-delay', `${delaySeconds}s`);
}

// ── Chip movement ─────────────────────────────────────────────────────────
// Chips fly seat → pot when a player commits chips, and pot → seat when a
// hand is awarded. Seats, the pot and the chips are all positioned against
// .poker-table-wrapper, so one coordinate space serves all three.

const CHIP_FLY_MAX = 5; // cap per event, however large the bet

function seatElementForPlayer(playerId) {
  const container = document.getElementById('playerSeats');
  if (!container) return null;
  // Walk the children rather than using an attribute selector: socket ids are
  // not guaranteed to be safe to interpolate into one.
  for (const el of container.children) {
    if (el.dataset && el.dataset.playerId === playerId) return el;
  }
  return null;
}

// The pot drawn as chips. Bucketed by big blinds so it reads the same at
// level 1 and level 12, and capped: one chip per unit would be a wall.
// Each entry is the chips per column, tallest in the middle.
const POT_PILE_TIERS = [[], [3], [4, 3], [4, 5, 3], [5, 6, 4], [6, 7, 5]];
let _potPileTier = -1;

function potPileTier(pot) {
  if (!(pot > 0)) return 0;
  const bbs = pot / ((gameState && gameState.bigBlind) || 20);
  if (bbs < 3) return 1;
  if (bbs < 8) return 2;
  if (bbs < 20) return 3;
  if (bbs < 60) return 4;
  return 5;
}

// Rebuilt only when the tier changes. Every action and every 1.2s director
// tick comes through here, and redrawing eighteen nodes each time would both
// churn and kill the bump animation half way through.
function renderPotPile(pot) {
  const pile = document.getElementById('potPile');
  if (!pile) return;
  const tier = gameState && gameState.isRunning ? potPileTier(pot) : 0;
  if (tier === _potPileTier) return;
  _potPileTier = tier;
  pile.dataset.tier = String(tier);
  pile.classList.toggle('is-empty', tier === 0);
  pile.textContent = '';
  POT_PILE_TIERS[tier].forEach((n) => {
    const col = document.createElement('div');
    col.className = 'pot-stack';
    col.style.setProperty('--n', n);
    for (let i = 0; i < n; i++) {
      const chip = document.createElement('span');
      chip.className = 'pot-chip';
      chip.style.setProperty('--i', i);
      col.appendChild(chip);
    }
    pile.appendChild(col);
  });
}

function bumpPotPile() {
  const pile = document.getElementById('potPile');
  if (!pile || pile.classList.contains('is-empty')) return;
  pile.classList.remove('is-bumped');
  // Reading offsetWidth restarts the animation when a bump is already running.
  void pile.offsetWidth;
  pile.classList.add('is-bumped');
  const done = () => pile.classList.remove('is-bumped');
  pile.addEventListener('animationend', done, { once: true });
  setTimeout(done, 500);
}

// Chips land on the pile when there is one, and on the pot block otherwise.
function potTarget() {
  const pile = document.getElementById('potPile');
  if (pile && pile.isConnected && pile.offsetParent !== null) return pile;
  return document.getElementById('potDisplay');
}

function chipCountForAmount(amount) {
  const bb = (gameState && gameState.bigBlind) || 20;
  return Math.max(1, Math.min(CHIP_FLY_MAX, Math.round(amount / bb) || 1));
}

// Both ends of a flight can be an element or a remembered {x, y}. The street
// sweep needs the latter: the stacks it flies from have already been wiped off
// the felt by the time it runs, so it carries their coordinates instead.
function flyPoint(target, wrapRect) {
  if (!target) return null;
  if (target.nodeType === 1) {
    // Deliberately NOT a width check. #potDisplay collapses to 0x0 at the end
    // of a hand, because renderTable blanks the pot amount once the hand stops
    // running, which is the exact moment chips need to fly OUT of it. Its
    // position stays correct, so test visibility instead: offsetParent is null
    // only when the element or an ancestor is display:none.
    if (!target.isConnected || target.offsetParent === null) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2 - wrapRect.left, y: r.top + r.height / 2 - wrapRect.top };
  }
  if (Number.isFinite(target.x) && Number.isFinite(target.y)) return { x: target.x, y: target.y };
  return null;
}

function flyChips(from, to, count, extraClass, opts) {
  const wrap = document.querySelector('.poker-table-wrapper');
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const a = flyPoint(from, wrapRect);
  const b = flyPoint(to, wrapRect);
  if (!a || !b) return;
  const delayMs = (opts && opts.delayMs) || 0;
  const durMs = (opts && opts.durMs) || CHIP_FLY_MS;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Chips are actually going somewhere, so this is the one honest place to
  // make the sound: it covers a bet going in, a street sweeping to the middle
  // and a pot being pushed to the winner, and it cannot fire for a flight that
  // was abandoned above.
  if (typeof SFX !== 'undefined') SFX.chipsMoved();

  for (let i = 0; i < count; i++) {
    const chip = document.createElement('div');
    chip.className = 'chip-fly' + (extraClass ? ' ' + extraClass : '');
    chip.style.left = a.x + 'px';
    chip.style.top = a.y + 'px';
    // Scatter the landing slightly so a stack does not read as a single chip.
    const scatter = (i % 2 ? 1 : -1) * Math.min(10, i * 3);
    chip.style.setProperty('--fly-dx', dx + scatter + 'px');
    chip.style.setProperty('--fly-dy', dy + ((i % 3) - 1) * 3 + 'px');
    chip.style.setProperty('--fly-dur', durMs + 'ms');
    chip.style.animationDelay = delayMs + i * 70 + 'ms';
    wrap.appendChild(chip);
    chip.addEventListener('animationend', () => chip.remove(), { once: true });
    // Under prefers-reduced-motion the chip is display:none, so animationend
    // never fires and nothing else would ever remove it. The fallback has to
    // clear the delay too, or a queued chip is reaped in flight.
    setTimeout(() => chip.remove(), delayMs + durMs + 2000);
  }
}

// Animation counters, so a browser test can assert that a sweep happened once
// rather than racing a sub-second animation in the DOM. Same idea as
// window.__identity, which the Playwright specs already read.
window.__anim = { sweeps: 0, deals: 0, flips: 0 };

// How much of the felt a single street end may throw at the pot. Eight seats
// at five chips each would be forty nodes and a visible hitch on a phone.
// The deal. A card is in the air for DEAL_DUR_S and is heard at 78% of that,
// which is the moment it reads as placed rather than the moment it sets off -
// so the sound is derived from the flight rather than being a second number
// that has to be remembered when the first one moves. The lead-in gives the
// shuffle a moment of its own before the first card leaves the deck; without
// it the two land on top of each other and the hand starts in a rush.
const DEAL_DUR_S = 0.44;
const DEAL_LAND_S = Number((DEAL_DUR_S * 0.78).toFixed(3));
const DEAL_LEAD_S = 0.12;
const DEAL_STEP_S = 0.11; // between one card and the next
const DEAL_STEP_TIGHT_S = 0.07; // a full table, where the queue is long enough to drag
// A board card swaps faces at 48% of the 0.36s fold.
const FLIP_TURN_S = 0.173;

const SWEEP_CHIP_BUDGET = 14;
// How long chips take to travel. A bet going in and a pot being pushed use the
// first; a street sweeping to the middle uses the second, which is also what
// the board waits for before it turns over and what the winner's push waits
// for, so the three stay in step by construction.
const CHIP_FLY_MS = 900;
const SWEEP_DUR_MS = 700;

function feltBetElementFor(playerId) {
  const layer = document.getElementById('feltBets');
  if (!layer) return null;
  for (const el of layer.children) {
    if (el.dataset && el.dataset.playerId === playerId) return el;
  }
  return null;
}

// A bet stack is swept when it is about to leave the felt for any reason other
// than a new hand. renderFeltBets only draws one while isRunning and bet > 0,
// so there are exactly two ways it can vanish: nextPhase zeroing the bets at
// the end of a street, and endRound clearing isRunning after the river. Both
// are the money going to the middle. Asking "is this stack about to disappear"
// catches both; asking "did a bet drop to zero" misses the showdown, because
// nextPhase hands off to showdown without zeroing anything.
function sweptStacks(prev, next) {
  if (!prev || !next || !prev.isRunning) return [];
  if (prev.roundCount !== next.roundCount) return [];
  const out = [];
  for (const p of prev.players) {
    if (!(p.bet > 0)) continue;
    const now = next.players.find((q) => q.id === p.id);
    const stillShown = next.isRunning && now && now.bet > 0;
    if (!stillShown) out.push({ id: p.id, amount: p.bet });
  }
  return out;
}

// Where those stacks are, read before anything in this frame writes to the
// DOM. It is the only chance: renderFeltBets wipes the layer on every push.
function measureSweep(prev, next) {
  const stacks = sweptStacks(prev, next);
  if (!stacks.length) return [];
  const wrap = document.querySelector('.poker-table-wrapper');
  if (!wrap) return [];
  const wrapRect = wrap.getBoundingClientRect();
  const out = [];
  for (const s of stacks) {
    const el = feltBetElementFor(s.id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    out.push({
      amount: s.amount,
      point: {
        x: r.left + r.width / 2 - wrapRect.left,
        y: r.top + r.height / 2 - wrapRect.top,
      },
    });
  }
  out.sort((a, b) => b.amount - a.amount); // the big bets get the chips
  return out;
}

function animateChipMovement(prevBets, prevWinnerKey, sweeps) {
  if (!gameState) return;

  // Chips in: any player whose street bet rose, blinds included.
  if (gameState.isRunning) {
    gameState.players.forEach((p) => {
      if (!prevBets.has(p.id)) return; // first time we have seen this player
      const delta = (p.bet || 0) - prevBets.get(p.id);
      if (delta <= 0) return; // a between-streets reset, not a bet
      const seat = seatElementForPlayer(p.id);
      const stack = document.querySelector(
        `#feltBets .felt-bet[data-player-id="${CSS.escape(p.id)}"]`
      );
      if (seat) flyChips(seat, stack || potTarget(), chipCountForAmount(delta));
    });
  }

  // The street is over: everything in front of a player goes to the middle.
  // The pot number does not move here, because the engine credited it action
  // by action; this is the money catching up with the arithmetic.
  if (sweeps && sweeps.length) {
    const target = potTarget();
    let budget = SWEEP_CHIP_BUDGET;
    sweeps.forEach((s, i) => {
      if (budget <= 0) return;
      const n = Math.min(budget, Math.max(2, Math.min(4, chipCountForAmount(s.amount))));
      budget -= n;
      flyChips(s.point, target, n, 'chip-sweep', { delayMs: i * 40, durMs: SWEEP_DUR_MS });
    });
    bumpPotPile();
    window.__anim.sweeps++;
  }

  // Chips out: only for a result we have not already animated. At a hand end
  // this lands on the same push as the sweep, so it waits for the money to
  // arrive before pushing it across.
  const winners = gameState.lastRoundWinnerIds || [];
  const winnerKey = winners.join(',');
  if (winnerKey && winnerKey !== prevWinnerKey) {
    const wait = sweeps && sweeps.length ? SWEEP_DUR_MS : 0;
    winners.forEach((id) => {
      const seat = seatElementForPlayer(id);
      if (seat) flyChips(potTarget(), seat, CHIP_FLY_MAX, 'chip-win', { delayMs: wait });
    });
  }
}

function updateGameState(state) {
  const oldRound = gameState ? gameState.roundCount : -1;
  const oldCommunityLen = gameState ? gameState.communityCards.length : 0;
  const hadGameOver = !!(gameState && gameState.gameOver);
  const previousMe = gameState && myId ? gameState.players.find((p) => p.id === myId) : null;
  // Snapshot the chip picture before it is overwritten. The animation needs the
  // delta: a rising bet is chips going in, and a winner id we have not seen
  // before is a pot being pushed out.
  const prevBets = new Map();
  if (gameState) gameState.players.forEach((p) => prevBets.set(p.id, p.bet || 0));
  const prevWinnerKey = gameState ? (gameState.lastRoundWinnerIds || []).join(',') : '';
  // Where the stacks that are about to leave the felt currently sit. Read here
  // because renderFeltBets is about to wipe them, and read before any write in
  // this handler so it costs no forced reflow.
  const sweeps = measureSweep(gameState, state);
  _boardFlipDelayMs = sweeps.length ? SWEEP_DUR_MS : 0;
  // The server sends the ten-hand history only on the first push after a hand
  // ends, because it is the bulk of the payload and identical for the whole
  // street in between. Carrying the last set forward is what lets every reader
  // below go on treating it as a plain field of the state.
  if (!state.recentHands && gameState) state.recentHands = gameState.recentHands;
  gameState = state;

  // Detect new round → force full rebuild
  if (state.roundCount !== oldRound) {
    prevCommunityCount = 0;
    _potPileTier = -1;
    _builtBoardKey = '';
    _builtRound = -1; // force player seat rebuild
    _dealAnimationRound = state.roundCount;
  }
  if ((hadGameOver && !state.gameOver) || state.roundCount < oldRound) {
    document.getElementById('resultModal').classList.add('hidden');
  }
  const nextMe = state && myId ? state.players.find((p) => p.id === myId) : null;
  if (previousMe && nextMe) {
    if (previousMe.isConnected !== false && nextMe.isConnected === false) {
      addLog('⚠️ Connection lost · this seat sits out until you are back');
    } else if (previousMe.isConnected === false && nextMe.isConnected !== false) {
      addLog(
        // Coming back resumes the seat on its own, unless sitting out was the
        // player's own choice, which no reconnect should override.
        nextMe.autoPlay
          ? '✅ Reconnected · still sitting out by your choice, tap sit in to play'
          : '✅ Reconnected · you are back in the hand'
      );
    }
    if (!previousMe.isSpectator && nextMe.isSpectator) {
      addLog('👀 Spectating until the next hand');
    } else if (previousMe.isSpectator && !nextMe.isSpectator) {
      addLog('🪑 Back in the game');
    }
  }

  renderTable(oldCommunityLen);
  // After render, so the seat elements the chips fly to and from exist.
  animateChipMovement(prevBets, prevWinnerKey, sweeps);
  updateActionsPanel();
  updatePreActionPanel();
  updateHandStrength();
  updateBarStack();
  updateTopBar();
  updateBlindClock();
  if (window.SidePanel) {
    SidePanel.refresh('info');
    SidePanel.refresh('stats');
    SidePanel.refresh('history');
  }
  updateModeUI(); // v11
  const resultModal = document.getElementById('resultModal');
  if (
    resultModal &&
    !resultModal.classList.contains('hidden') &&
    (state.gameOver || state.phase === 'showdown')
  ) {
    showResult({ refreshOnly: true });
  }
}

function renderTable(oldCommunityLen) {
  if (!gameState) return;

  // ── Community cards ──
  const cc = document.getElementById('communityCards');
  const curCount = gameState.communityCards.length;
  const prevCount = oldCommunityLen !== undefined ? oldCommunityLen : prevCommunityCount;

  // Rebuilt only when the board itself changes. Two pushes land back to back
  // when a street opens, and a blind rebuild on the second one would re-render
  // the card mid-flip without its animation and snap it flat.
  // The winners are part of the key, not just the cards. At showdown the board
  // does not change, so keying on the cards alone would skip the rebuild and
  // the highlight would never appear on the community cards while working
  // perfectly on the hole cards.
  const boardWinners = winningCardKeys();
  const boardKey =
    gameState.isRunning || gameState.phase === 'showdown'
      ? gameState.communityCards.map((c) => `${c.rank}${c.suit}`).join(',') +
        '|' +
        [...boardWinners].join(',')
      : 'none';
  if (boardKey !== _builtBoardKey || !cc.children.length) {
    _builtBoardKey = boardKey;
    const heardOnBoard = [];
    cc.textContent = '';
    if (gameState.isRunning || gameState.phase === 'showdown') {
      for (let i = 0; i < 5; i++) {
        if (i < curCount) {
          const isNew = i >= prevCount;
          const card = gameState.communityCards[i];
          const marks = [isNew ? 'flipping' : '', showdownClassFor(card, boardWinners)]
            .filter(Boolean)
            .join(' ');
          const cardEl = createCardElement(card, marks);
          if (isNew) {
            setAnimationDelay(cardEl, (_boardFlipDelayMs + (i - prevCount) * 110) / 1000);
            // The card turns over behind its own back, which is dropped when
            // the fold finishes. Clearing the class matters as much as the
            // back: the animation fills both ways, so leaving it on freezes
            // the card's transform for the rest of the hand and kills hover.
            const back = document.createElement('div');
            back.className = 'card-flipback';
            cardEl.appendChild(back);
            const drop = () => {
              back.remove();
              cardEl.classList.remove('flipping');
            };
            cardEl.addEventListener('animationend', drop, { once: true });
            setTimeout(drop, _boardFlipDelayMs + (i - prevCount) * 110 + 900);
            heardOnBoard.push((_boardFlipDelayMs + (i - prevCount) * 110) / 1000 + FLIP_TURN_S);
            window.__anim.flips++;
          }
          cc.appendChild(cardEl);
        } else {
          const ph = document.createElement('div');
          ph.className = 'card-back card-placeholder';
          cc.appendChild(ph);
        }
      }
    }
    // A flop is three cards turning over, so it is three snaps.
    if (typeof SFX !== 'undefined') SFX.cardsPlaced(heardOnBoard);
  }
  prevCommunityCount = curCount;

  // ── Pot ──
  document.getElementById('potDisplay').querySelector('.pot-amount').textContent =
    gameState.isRunning ? `${gameState.pot}` : '';
  renderPotPile(gameState.pot);

  // ── Players: INCREMENTAL ──
  renderPlayersIncremental();

  // ── Round overlay ──
  // The director deals on its own clock; the overlay only says so before the
  // first hand.
  const overlay = document.getElementById('roundOverlay');
  if (overlay) {
    overlay.classList.toggle(
      'hidden',
      gameState.isRunning || gameState.roundCount > 0 || gameState.phase === 'showdown'
    );
  }
}

// Track what's been built to avoid unnecessary DOM rebuilds
let _builtRound = -1;
let _builtPlayerCount = -1;
let _builtCapacity = -1;
let _builtPhase = '';
let _builtHostId = '';
let _builtMyId = null;
let _builtIdentityKey = '';
let _dealAnimationRound = -1;
let _builtBoardKey = '';
// Set for the one render where a street just closed: the board waits for the
// chips to reach the middle before it turns over, so the two read as a
// sequence rather than as one busy frame.
let _boardFlipDelayMs = 0;

function getPlayerIdentityKey(players) {
  return players
    .map((p) => {
      return [
        p.id,
        p.name,
        p.avatar || '',
        p.isReady ? 'ready' : '',
        p.autoPlay ? 'auto' : '',
        p.isConnected === false ? 'offline' : 'online',
        p.isSpectator ? 'spectator' : '',
        // Rotating the view changes no player's state, so without this the
        // incremental path would leave every plate exactly where it was.
        String(viewerSlot(players.length)),
        // Whether this seat's cards are face up. The skeleton holds the cards,
        // so the moment the server tables a hand - at showdown, or on an
        // all-in run-out - the seats have to be built again to show them.
        p.holeCards ? 'up' : '',
      ].join(':');
    })
    .join('|');
}

function renderPlayersIncremental() {
  const container = document.getElementById('playerSeats');
  const playerCount = gameState.players.length;
  const capacity = seatCapacity(playerCount);
  const identityKey = getPlayerIdentityKey(gameState.players);
  const needsFullRebuild =
    _builtRound !== gameState.roundCount ||
    _builtPlayerCount !== playerCount ||
    _builtCapacity !== capacity ||
    _builtHostId !== (gameState.hostId || '') ||
    // Who the viewer is decides which chair everyone is drawn in, and it is
    // not part of any player's state, so nothing else here notices when it
    // changes. It changes on every reconnect: a refresh mid-hand lands a game
    // state before tournamentJoined has said who we are, the seats get built
    // unrotated, and then no later push has any reason to build them again -
    // the felt bets are redrawn every time and would be correct while the
    // plates under them stayed wrong, until the next deal forced a rebuild.
    _builtMyId !== myId ||
    _builtIdentityKey !== identityKey ||
    (_builtPhase === 'showdown' && gameState.phase !== 'showdown') ||
    (_builtPhase !== 'showdown' && gameState.phase === 'showdown') ||
    container.children.length === 0;

  if (needsFullRebuild) {
    _builtRound = gameState.roundCount;
    _builtPlayerCount = playerCount;
    _builtCapacity = capacity;
    _builtPhase = gameState.phase;
    _builtHostId = gameState.hostId || '';
    _builtMyId = myId;
    _builtIdentityKey = identityKey;
    renderPlayersFull(container);
    return;
  }

  _builtPhase = gameState.phase;
  // ── Fast path: the skeleton stands, only the per-hand state is rewritten ──
  const ordered = getOrderedPlayersForView();
  const ctx = seatRenderContext();
  ordered.forEach((player) => {
    const seat = seatElementForPlayer(player.id);
    if (seat) updateSeatDynamic(seat, player, ctx);
  });
  const betCapacity = seatCapacity(ordered.length);
  renderFeltBets(ordered, getSeatPositions(betCapacity, viewerSlot(betCapacity)));
  updateTurnTimerBars(ordered);
}

// How many chairs to lay out: the table's full size, always. The chairs are
// fixed positions now rather than an arc redrawn to fit whoever is left, so a
// player keeps their place on screen as the table empties and the seats that
// nobody is in read as empty seats. The engine compacts its seat indices when
// somebody leaves, so those empty chairs collect at the end of the order
// rather than staying where the player who left was sitting.
function seatCapacity(playerCount) {
  if (!gameState) return playerCount;
  return Math.max(playerCount, gameState.maxPlayers || 0);
}

// Which chair the viewer has asked to be shown in. Persisted per device, and
// clamped on the way out: a 7 stored from an eight-max table must not blank
// the felt on a six-max one.
function viewerSlot(capacity) {
  const n = Math.max(1, capacity || 1);
  const raw = window.Store ? Store.get(VIEWER_SLOT_KEY) : null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < n ? parsed : 0;
}

// ── Seat state ────────────────────────────────────────────────────────────
// A seat has two layers. The skeleton (hole cards, avatar, name and its
// badges, D/SB/BB chips, tooltip) is built by buildSeatSkeleton once per hand
// and only rebuilt when the identity key or the round changes. Everything
// that moves during a hand (stack, bets, all-in, fold, action badge, whose
// turn it is) is written by updateSeatDynamic and nowhere else, so the full
// build and the fast path cannot drift apart.

const SEAT_ACTION_LABELS = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  raise: 'raise',
  allin: 'ALL IN',
};
const SEAT_ACTION_CSS = {
  fold: 'action-fold',
  check: 'action-check',
  call: 'action-call',
  raise: 'action-raise',
  allin: 'action-allin',
};

// Seat geometry depends on the viewport (CSS radii, capacity), so a resize
// or orientation change re-lays the ring. Debounced; a rebuild is cheap.
let _seatRelayoutTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_seatRelayoutTimer);
  _seatRelayoutTimer = setTimeout(() => {
    if (typeof invalidateRingCache === 'function') invalidateRingCache();
    if (!gameState) return;
    _builtIdentityKey = '';
    renderPlayersIncremental();
  }, 150);
});

function seatRenderContext() {
  return {
    isRunning: !!gameState.isRunning,
    currentPlayerIndex: gameState.currentPlayerIndex,
    winnerIds: gameState.lastRoundWinnerIds || [],
    now: Date.now(),
  };
}

function actionBadgeLabel(action) {
  let label = SEAT_ACTION_LABELS[action.action] || action.action;
  if (action.amount > 0 && action.action !== 'fold') label += ' ' + action.amount;
  return label;
}

// Show, fill or hide one of the plate's dynamic nodes. The skeleton creates
// them as hidden placeholders in layout order; a missing one (a plate built
// by something else) is appended so the writer still works.
function setSeatNode(info, className, show, text) {
  let el = info.querySelector('.' + className);
  if (!show) {
    if (el) el.classList.add('hidden');
    return el;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = className;
    info.appendChild(el);
  }
  el.classList.remove('hidden');
  if (text !== undefined && el.textContent !== String(text)) el.textContent = text;
  return el;
}

function updateSeatDynamic(seat, player, ctx) {
  seat.classList.toggle('folded', !!player.folded);
  seat.classList.toggle('auto-play', !!player.autoPlay);
  seat.classList.toggle('offline', player.isConnected === false);
  seat.classList.toggle('spectating', !!player.isSpectator);
  // The seat that took the pot. At showdown the cards carry the story, but a
  // hand won by everyone folding reveals nothing, and that ending should not
  // be silent.
  seat.classList.toggle('hand-winner', !!(ctx.winnerIds && ctx.winnerIds.includes(player.id)));
  seat.classList.toggle(
    'active-turn',
    ctx.isRunning && player.originalIndex === ctx.currentPlayerIndex
  );

  const info = seat.querySelector('.player-info');
  if (!info) return;
  // A status line takes the stack's place while it applies.
  const status = seatStatus(player, ctx);
  setSeatNode(info, 'player-chips', !status, player.chips);
  const statusEl = setSeatNode(info, 'seat-status', !!status, status ? status.label : undefined);
  if (status && statusEl) statusEl.dataset.status = status.code;
  setSeatNode(
    info,
    'player-totalbet',
    ctx.isRunning && player.totalBet > 0,
    `in ${player.totalBet}`
  );
  if (player.id === myId) {
    const hand = gameState.myHand;
    const cap = setSeatNode(info, 'seat-caption', !!hand, hand ? hand.detail : undefined);
    if (cap && hand) cap.title = hand.text;
  }

  const action =
    player.lastAction && ctx.now - player.lastAction.time < 3000 ? player.lastAction : null;
  const badge = setSeatNode(
    info,
    'player-action-badge',
    !!action,
    action ? actionBadgeLabel(action) : undefined
  );
  if (action && badge) {
    badge.className = 'player-action-badge ' + (SEAT_ACTION_CSS[action.action] || '');
    badge.title = badge.textContent;
  }
}

// One status wins, in this order.
function seatStatus(player, ctx) {
  if (player.isSpectator) return { code: 'out', label: 'Sitting out' };
  if (player.isConnected === false) return { code: 'offline', label: 'Disconnected' };
  if (player.allIn) return { code: 'allin', label: 'All in' };
  if (player.folded && ctx.isRunning) return { code: 'folded', label: 'Folded' };
  return null;
}

// Street bets drawn as chip stacks on the felt, one per player with chips in
// front of them. Rebuilt on every update, so it needs no cache of its own.
function renderFeltBets(ordered, seatPositions) {
  const layer = document.getElementById('feltBets');
  if (!layer) return;
  layer.textContent = '';
  if (!gameState || !gameState.isRunning) return;
  ordered.forEach((player, seatIdx) => {
    const pos = seatPositions[seatIdx];
    if (!pos || !(player.bet > 0)) return;
    const bet = document.createElement('div');
    bet.className = 'felt-bet';
    bet.dataset.playerId = player.id;
    bet.style.left = pos.betLeft;
    bet.style.top = pos.betTop;
    const count = chipCountForAmount(player.bet);
    const chips = document.createElement('div');
    chips.className = 'felt-bet-chips';
    chips.style.setProperty('--n', count);
    for (let i = 0; i < count; i++) {
      const chip = document.createElement('span');
      chip.className = 'felt-chip';
      chip.style.setProperty('--i', i);
      chips.appendChild(chip);
    }
    bet.append(chips, createTextElement('div', 'felt-bet-amount', player.bet));
    layer.appendChild(bet);
  });
}

function createTextElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function getPlayerDisplayName(player) {
  return player ? player.name : '';
}

function appendPlayerIdentity(info, text, player) {
  info.appendChild(createTextElement('span', 'seat-avatar', player.avatar || '🧑'));

  const name = document.createElement('div');
  name.className = 'player-name';
  // Its own element, not a bare text node: an anonymous flex item cannot take
  // text-overflow, so a name beside two badges was being cut mid-letter.
  name.appendChild(createTextElement('span', 'player-name-text', player.name));
  if (player.uid && player.uid === gameState.hostId) {
    const hostBadge = createTextElement('span', 'player-host-badge', 'host');
    hostBadge.title = 'Tournament host';
    name.appendChild(hostBadge);
  }
  // A badge that repeats the status line directly under it is not worth the
  // width. The plate is one line now, and a name beside three badges does not
  // fit one - it used to wrap to three lines instead, standing the plate up
  // tall enough to land on its neighbour. seatStatus() already says "Sitting
  // out" for a spectator and "Disconnected" for a seat that has dropped, and
  // both of those are sat out by definition.
  const statusSpeaksForIt = !!player.isSpectator || player.isConnected === false;
  if (player.autoPlay && !statusSpeaksForIt) {
    const autoBadge = createTextElement('span', 'player-auto-badge', 'sitting out');
    autoBadge.title = 'Sitting out: checks when free, folds to a bet';
    name.appendChild(autoBadge);
  }
  if (player.isSpectator) {
    const spectatorBadge = createTextElement('span', 'player-spectator-badge', 'watch');
    spectatorBadge.title = 'Spectating this hand';
    name.appendChild(spectatorBadge);
  }
  // Only when the status line is busy saying something else: on its own, a
  // dropped seat already reads "Disconnected" underneath.
  if (player.isConnected === false && player.isSpectator) {
    const offlineBadge = createTextElement('span', 'player-offline-badge', 'offline');
    offlineBadge.title = 'Disconnected';
    name.appendChild(offlineBadge);
  }
  if (
    player.isReady &&
    gameState &&
    !gameState.isRunning &&
    gameState.roundCount === 0 &&
    gameState.gameMode !== 'practice'
  ) {
    const readyBadge = createTextElement('span', 'player-ready-badge', 'ready');
    readyBadge.title = 'Ready to start';
    name.appendChild(readyBadge);
  }
  text.appendChild(name);

  // The caption slot holds the viewer's own hand readout (see
  // updateSeatDynamic). Every seat gets one; only the viewer's is ever filled.
  text.appendChild(createTextElement('div', 'seat-caption is-hand hidden', ''));
}

// ── The deal ──────────────────────────────────────────────────────────────
// Cards go out one at a time from the button, starting to its left, twice
// round, the way a person deals them.

function holeCardNodes(seat) {
  const row = seat.querySelector('.player-hole-cards');
  return row ? Array.from(row.children) : [];
}

// Display order is rotated so the viewer sits at the bottom, so it is not
// dealing order. getOrderedPlayersForView stamps originalIndex, which is the
// index into gameState.players and therefore the same space dealerIndex uses.
function dealSlots(ordered) {
  const n = ordered.length;
  if (!n) return { slots: [], dealerSlot: -1 };
  const dealerSlot = ordered.findIndex((p) => p.originalIndex === gameState.dealerIndex);
  const start = dealerSlot < 0 ? n - 1 : dealerSlot;
  const slots = [];
  for (let i = 1; i <= n; i++) slots.push((start + i) % n);
  return { slots, dealerSlot };
}

// Where the cards come from. The button itself when it is on screen, then the
// dealer's seat, then the middle of the felt: a seat can be missing because
// its player left between the deal and this render.
function dealOrigin(ordered, dealerSlot, wrapRect) {
  const centre = (r) => ({
    x: r.left + r.width / 2 - wrapRect.left,
    y: r.top + r.height / 2 - wrapRect.top,
  });
  const seat = dealerSlot >= 0 ? seatElementForPlayer(ordered[dealerSlot].id) : null;
  const chip = seat && seat.querySelector('.dealer-chip');
  if (chip) return centre(chip.getBoundingClientRect());
  if (seat) return centre(seat.getBoundingClientRect());
  const board = document.querySelector('.board-stack');
  if (board) return centre(board.getBoundingClientRect());
  return { x: wrapRect.width / 2, y: wrapRect.height * 0.44 };
}

function clearDealClass(node, delaySeconds) {
  const done = () => {
    node.classList.remove('dealing');
    node.style.removeProperty('--deal-dx');
    node.style.removeProperty('--deal-dy');
    node.style.removeProperty('--deal-rot');
    node.style.removeProperty('--deal-delay');
    node.style.removeProperty('--deal-dur');
  };
  node.addEventListener('animationend', done, { once: true });
  // The animation fills both ways, so a card that never hears animationend
  // would hold its final transform for the rest of the hand and lose hover.
  setTimeout(done, delaySeconds * 1000 + 900);
}

// Two passes: all the reads, then all the writes. Measuring each card as it is
// built would force a layout per card.
function applyDealFlight(ordered) {
  const wrap = document.querySelector('.poker-table-wrapper');
  const wrapRect = wrap ? wrap.getBoundingClientRect() : null;
  const { slots, dealerSlot } = dealSlots(ordered);
  const origin = wrapRect ? dealOrigin(ordered, dealerSlot, wrapRect) : null;

  const plan = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const slot of slots) {
      const seat = seatElementForPlayer(ordered[slot].id);
      const node = seat ? holeCardNodes(seat)[pass] : null;
      if (!node) continue;
      plan.push({ node, pass, rect: node.getBoundingClientRect() });
    }
  }

  const step = plan.length > 12 ? DEAL_STEP_TIGHT_S : DEAL_STEP_S;
  const heard = [];
  plan.forEach((item, i) => {
    // Released before the early return below, so a card is revealed even when
    // nothing can animate. deal-pending is visibility:hidden; leaving one on
    // would hide that hand's cards for good.
    item.node.classList.remove('deal-pending');
    item.node.dataset.dealOrder = String(i);
    if (!origin || !wrapRect) return;
    const cx = item.rect.left + item.rect.width / 2 - wrapRect.left;
    const cy = item.rect.top + item.rect.height / 2 - wrapRect.top;
    item.node.style.setProperty('--deal-dx', Math.round(origin.x - cx) + 'px');
    item.node.style.setProperty('--deal-dy', Math.round(origin.y - cy) + 'px');
    item.node.style.setProperty('--deal-rot', (item.pass ? 16 : -20) + 'deg');
    item.node.style.setProperty('--deal-dur', DEAL_DUR_S + 's');
    const at = DEAL_LEAD_S + i * step;
    setAnimationDelay(item.node, Number(at.toFixed(3)));
    item.node.classList.add('dealing');
    clearDealClass(item.node, at);
    heard.push(at + DEAL_LAND_S);
  });
  // One snap per card, on the same schedule the cards are flying to. Cards
  // that could not animate (no origin to fly from) get a single sound: they
  // appear all at once, so a patter would be describing motion that is not
  // there.
  if (typeof SFX !== 'undefined') {
    // The deck first, then the cards it pitched. Gated on there being cards to
    // deal: a render with nothing to fly should make no sound at all.
    if (plan.length) SFX.deckShuffled();
    SFX.cardsPlaced(heard.length ? heard : plan.length ? [0] : []);
  }
  if (plan.length) window.__anim.deals++;
}

function renderPlayersFull(container) {
  container.textContent = '';
  const ordered = getOrderedPlayersForView();
  const capacity = seatCapacity(ordered.length);
  const seatPositions = getSeatPositions(capacity, viewerSlot(capacity));
  const animateDeal =
    _dealAnimationRound === gameState.roundCount &&
    gameState.phase === 'preflop' &&
    gameState.communityCards.length === 0;
  const ctx = seatRenderContext();

  ordered.forEach((player, seatIdx) => {
    if (seatIdx >= seatPositions.length) return;
    const seat = buildSeatSkeleton(player, seatIdx, seatPositions[seatIdx], animateDeal);
    updateSeatDynamic(seat, player, ctx);
    container.appendChild(seat);
  });
  for (let seatIdx = ordered.length; seatIdx < seatPositions.length; seatIdx++) {
    container.appendChild(buildEmptySeat(seatPositions[seatIdx]));
  }
  renderFeltBets(ordered, seatPositions);

  if (animateDeal) {
    applyDealFlight(ordered);
    _dealAnimationRound = -1;
  }
  updateTurnTimerBars(ordered);
}

function buildEmptySeat(pos) {
  const seat = document.createElement('div');
  seat.className = 'player-seat seat-empty';
  // An empty chair is right-clickable too: it is a place to ask to be shown,
  // and often the one you want.
  if (pos.slot !== undefined) seat.dataset.slot = String(pos.slot);
  seat.style.left = pos.left;
  seat.style.top = pos.top;
  seat.style.transform = pos.transform;
  const plate = document.createElement('div');
  plate.className = 'player-info seat-plate seat-empty-plate';
  plate.appendChild(createTextElement('span', 'seat-empty-label', 'Empty'));
  seat.appendChild(plate);
  return seat;
}

// The static part of a seat: hole cards, identity, the D/SB/BB chips, and the
// hidden placeholders updateSeatDynamic fills. Never touched by the fast path.
function buildSeatSkeleton(player, seatIdx, pos, animateDeal) {
  const seat = document.createElement('div');
  seat.className = 'player-seat';
  // Lets chip animations and the fast path find a player's seat without
  // depending on display ordering, which is rotated so the viewer always sits
  // at the bottom.
  seat.dataset.playerId = player.id;
  if (pos.slot !== undefined) seat.dataset.slot = String(pos.slot);
  seat.style.left = pos.left;
  seat.style.top = pos.top;
  seat.style.transform = pos.transform;

  // Hole cards
  const holeCardsDiv = document.createElement('div');
  holeCardsDiv.className = 'player-hole-cards';
  // Cards start hidden when a deal is coming: applyDealFlight measures them
  // where they will land, then releases them. visibility rather than display,
  // so they still have a box to measure.
  const anim = animateDeal ? ' deal-pending' : '';
  if (player.holeCards && player.holeCards.length === 2) {
    const winners = winningCardKeys();
    for (const card of player.holeCards) {
      const marks = [anim.trim(), showdownClassFor(card, winners)].filter(Boolean).join(' ');
      holeCardsDiv.appendChild(createCardElement(card, marks));
    }
  } else if (gameState.isRunning && !player.folded) {
    const b1 = document.createElement('div');
    b1.className = 'card-back' + anim;
    const b2 = document.createElement('div');
    b2.className = 'card-back' + anim;
    holeCardsDiv.appendChild(b1);
    holeCardsDiv.appendChild(b2);
  }
  seat.appendChild(holeCardsDiv);

  // The plate: a square avatar beside a text column of name, caption, and
  // the stack (or the status line that stands in for it).
  const info = document.createElement('div');
  info.className = 'player-info seat-plate';
  const text = document.createElement('div');
  text.className = 'seat-plate-text';
  appendPlayerIdentity(info, text, player);

  // Dynamic placeholders, in layout order. The action badge is absolutely
  // positioned so its slot only matters for the writer to find it.
  ['player-chips', 'seat-status', 'player-totalbet', 'player-action-badge'].forEach((cls) => {
    const el = document.createElement('div');
    el.className = cls + ' hidden';
    text.appendChild(el);
  });
  info.appendChild(text);

  // D/SB/BB chips
  if (player.originalIndex === gameState.dealerIndex) {
    const dc = document.createElement('div');
    dc.className = 'dealer-chip';
    dc.textContent = 'D';
    info.appendChild(dc);
  }
  if (gameState.sbIndex !== undefined && player.originalIndex === gameState.sbIndex) {
    const sc = document.createElement('div');
    sc.className = 'sb-chip';
    sc.textContent = 'SB';
    info.appendChild(sc);
  }
  if (gameState.bbIndex !== undefined && player.originalIndex === gameState.bbIndex) {
    const bc = document.createElement('div');
    bc.className = 'bb-chip';
    bc.textContent = 'BB';
    info.appendChild(bc);
  }

  seat.appendChild(info);
  return seat;
}

function getOrderedPlayersForView() {
  if (!gameState || !Array.isArray(gameState.players) || gameState.players.length === 0) return [];
  const myIndex = gameState.players.findIndex((p) => p.id === myId);
  if (myIndex < 0) {
    return gameState.players.map((player, index) => ({ ...player, originalIndex: index }));
  }
  const ordered = [];
  for (let i = 0; i < gameState.players.length; i++) {
    const idx = (myIndex + i) % gameState.players.length;
    ordered.push({ ...gameState.players[idx], originalIndex: idx });
  }
  return ordered;
}

// The five cards that won the last showdown, as a lookup. Empty at every
// other moment, and empty for a hand won by everyone folding, so "is there a
// highlight running" is just a size check.
function winningCardKeys() {
  const list = (gameState && gameState.showdownWinningCards) || [];
  return new Set(list);
}

// The mark a card carries at showdown: the ones that made the winning hand, or
// dimmed if a hand was shown and this card was not part of it. Face-down cards
// never get either; a folded player's back is not a losing hand.
function showdownClassFor(card, winners) {
  if (!winners.size) return '';
  return winners.has(`${card.rank}${card.suit}`) ? 'is-winning' : 'is-dimmed';
}

function createCardElement(card, animClass) {
  const el = document.createElement('div');
  const color = SUIT_COLORS[card.suit];
  const ariaName = `${RANK_NAMES[card.rank] || card.rank} of ${SUIT_NAMES[card.suit] || card.suit}`;
  el.className = `card ${color}` + (animClass ? ' ' + animClass : '');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', ariaName);

  const front = document.createElement('div');
  front.className = 'card-front';

  const suitSym = SUIT_SYMBOLS[card.suit];
  const corner = document.createElement('div');
  corner.className = 'card-corner';
  corner.append(document.createTextNode(card.rank), document.createElement('br'), suitSym);
  const rank = createTextElement('div', 'card-rank', card.rank);
  const suit = createTextElement('div', 'card-suit', suitSym);
  const cornerBr = document.createElement('div');
  cornerBr.className = 'card-corner-br';
  cornerBr.append(document.createTextNode(card.rank), document.createElement('br'), suitSym);
  front.append(corner, rank, suit, cornerBr);
  el.appendChild(front);
  return el;
}

function updateActionsPanel() {
  const panel = document.getElementById('actionsPanel');
  if (!gameState || !gameState.isMyTurn) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const me = gameState.players.find((p) => p.id === myId);
  if (!me || me.autoPlay) {
    panel.classList.add('hidden');
    return;
  }

  // Request Time: shown while a clock is running, disabled once this hand's
  // allowance is spent.
  const timeBtn = document.getElementById('btnRequestTime');
  if (timeBtn) {
    const bank = gameState.timeBank;
    const hasClock = !!(bank && gameState.turnExpiresAt);
    timeBtn.classList.toggle('hidden', !hasClock);
    timeBtn.disabled = !(hasClock && bank.extensionsLeft > 0);
    timeBtn.textContent = `+${Math.round(((bank && bank.grantMs) || 30000) / 1000)}s`;
    timeBtn.title = timeBtn.disabled
      ? 'No time left to request this hand'
      : 'Add time to your clock';
  }

  const toCall = gameState.currentBet - me.bet;
  const minRaise = gameState.currentBet + gameState.minRaise;

  // Show/hide check vs call
  document.getElementById('btnCheck').style.display = toCall === 0 ? '' : 'none';
  document.getElementById('btnCall').style.display = toCall > 0 ? '' : 'none';
  if (toCall > 0) {
    const callCost = Math.min(toCall, me.chips);
    if (callCost >= me.chips) {
      document.getElementById('btnCall').textContent = `all-in call ${callCost}`;
    } else {
      document.getElementById('btnCall').textContent = `call ${callCost}`;
    }
  }

  // Hide raise/allin when no opponents can respond (all are all-in or folded)
  const canRaise = gameState.canRaise !== false;
  document.querySelector('.raise-slider-group').style.display = canRaise ? '' : 'none';
  document.getElementById('btnRaise').style.display = canRaise ? '' : 'none';
  document.getElementById('btnAllIn').style.display = canRaise ? '' : 'none';
  const presetGroup = document.getElementById('presetGroup');
  if (presetGroup) presetGroup.style.display = canRaise ? '' : 'none';

  // Update raise slider
  if (canRaise) {
    const slider = document.getElementById('raiseSlider');
    const maxRaiseTo = me.chips + me.bet; // most many can add to

    if (minRaise > maxRaiseTo) {
      // Chips below min raise threshold: can only call or all-in, hide raise
      document.querySelector('.raise-slider-group').style.display = 'none';
      document.getElementById('btnRaise').style.display = 'none';
      if (presetGroup) presetGroup.style.display = 'none';
    } else {
      const raiseInput = document.getElementById('raiseInput');
      const currentValue = parseInt(raiseInput.value, 10);
      const turnKey = [
        gameState.roundCount,
        gameState.phase,
        gameState.currentPlayerIndex,
        me.id,
        minRaise,
        maxRaiseTo,
        gameState.currentBet,
        me.bet,
      ].join(':');
      const preserveCurrent =
        slider.dataset.turnKey === turnKey &&
        slider.dataset.userAdjusted === 'true' &&
        Number.isFinite(currentValue);
      const raiseTo = preserveCurrent
        ? Math.max(minRaise, Math.min(maxRaiseTo, currentValue))
        : minRaise;
      slider.min = minRaise;
      slider.max = maxRaiseTo;
      slider.value = raiseTo;
      slider.dataset.turnKey = turnKey;
      if (!preserveCurrent) slider.dataset.userAdjusted = 'false';
      slider.setAttribute('aria-valuemin', minRaise);
      slider.setAttribute('aria-valuemax', maxRaiseTo);
      slider.setAttribute('aria-valuenow', raiseTo);
      raiseInput.value = raiseTo;
      const npEl = document.getElementById('raiseNeedPay');
      if (npEl) npEl.textContent = `to ${raiseTo} · +${Math.max(0, raiseTo - me.bet)}`;
      renderRaisePresets(me, minRaise, maxRaiseTo);
    }
  }
}

// The bar for a turn that has not opened yet. It renders from the same snapshot
// as the action bar and the sit-out banner, one pass, so the three can never
// disagree about which of them is up.
function updatePreActionPanel() {
  const panel = document.getElementById('preActionPanel');
  if (!panel) return;
  const me = gameState ? gameState.players.find((p) => p.id === myId) : null;
  // Not seated, sitting out, or it is your turn — in which case the action bar
  // owns this slot and arming would race the beat the arm fires on.
  if (!gameState || !me || me.autoPlay || gameState.isMyTurn) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  // The three action toggles need a live hand and a seat still in it. The
  // sit-out toggle does not: between hands, folded and all-in are exactly when
  // somebody decides they are done for now.
  const row = document.getElementById('preActionRow');
  const inHand = !!gameState.isRunning && !me.folded && !me.allIn && !me.isSpectator;
  row.classList.toggle('hidden', !inHand);

  const armed = gameState.myPreAction ? gameState.myPreAction.kind : null;
  if (inHand) {
    // Unlike the action bar, this renders between hands too, where toCall goes
    // negative and canCheck is meaninglessly true. Clamp rather than trust it.
    const toCall = Math.max(0, gameState.currentBet - (me.bet || 0));
    const callCost = Math.min(toCall, me.chips);
    // Facing a bet there is nothing to check, so the same armed line reads as
    // the fold it would be. Free, it reads as the choice between the two.
    const labels = {
      checkfold: toCall > 0 ? 'fold' : 'check / fold',
      check: 'check',
      // Say the word before they arm it, not after it has taken the stack:
      // a call bigger than the stack is an all-in, exactly as the action bar
      // spells out when the turn is live.
      call: callCost >= me.chips ? `all-in call ${callCost}` : `call ${callCost}`,
      callany: toCall >= me.chips ? 'call any · all-in' : 'call any',
    };
    for (const btn of row.querySelectorAll('.preaction-btn')) {
      const kind = btn.dataset.kind;
      // check only when there is nothing to answer; call only when there is.
      const shown = kind === 'check' ? toCall === 0 : kind === 'call' ? toCall > 0 : true;
      btn.classList.toggle('hidden', !shown);
      btn.textContent = labels[kind];
      const on = armed === kind;
      btn.classList.toggle('is-armed', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  const sitOutBtn = document.getElementById('btnSitOutNextHand');
  if (sitOutBtn) {
    const queued = !!gameState.mySitOutNextHand;
    sitOutBtn.classList.toggle('is-armed', queued);
    sitOutBtn.setAttribute('aria-pressed', queued ? 'true' : 'false');
    sitOutBtn.textContent = queued ? 'sitting out next hand' : 'sit out next hand';
  }
}

// Raise presets are raise-TO amounts, like the slider. One below the table
// minimum is disabled rather than silently bumped up, and one at or past the
// stack becomes "All in". Pot: call first, then raise by the pot that makes.
// The four sizings offered above the slider. Postflop the unit that means
// anything is the pot, so they are fractions of it; preflop the pot is two
// blinds and a limp or two, where "50% pot" is a number nobody thinks in and
// multiples of the big blind are how the bet is actually chosen. Four either
// way, so the row is the same width on every street.
//
// A fraction f of the pot is the standard raise: call first, then bet f of
// what the pot has become. Hence currentBet + f x (pot + toCall) - and at
// f = 1 that is the pot-sized raise the Pot button has always sent.
function computeRaisePresets(me, minRaiseTo, maxRaiseTo) {
  const toCall = Math.max(0, gameState.currentBet - me.bet);
  const bb = gameState.bigBlind || 20;
  const potAfterCall = (gameState.pot || 0) + toCall;
  const fraction = (f) => gameState.currentBet + Math.round(f * potAfterCall);
  const specs =
    gameState.phase === 'preflop'
      ? [
          { id: '3bb', label: '3bb', to: 3 * bb },
          { id: '4bb', label: '4bb', to: 4 * bb },
          { id: '5bb', label: '5bb', to: 5 * bb },
          { id: 'pot', label: 'Pot', to: fraction(1) },
        ]
      : [
          { id: '33', label: '33%', to: fraction(1 / 3) },
          { id: '50', label: '50%', to: fraction(1 / 2) },
          { id: '75', label: '75%', to: fraction(3 / 4) },
          { id: 'pot', label: 'Pot', to: fraction(1) },
        ];
  return specs.map((p) => ({
    ...p,
    value: Math.min(p.to, maxRaiseTo),
    isAllIn: p.to >= maxRaiseTo,
    disabled: p.to < minRaiseTo,
  }));
}

// Filled by position rather than by looking each id up in the markup: the four
// slots are fixed, what sits in them changes with the street.
function renderRaisePresets(me, minRaiseTo, maxRaiseTo) {
  const group = document.getElementById('presetGroup');
  if (!group) return;
  const buttons = group.querySelectorAll('.preset-btn');
  computeRaisePresets(me, minRaiseTo, maxRaiseTo).forEach((p, i) => {
    const btn = buttons[i];
    if (!btn) return;
    btn.textContent = p.isAllIn ? 'All in' : p.label;
    btn.disabled = p.disabled;
    btn.dataset.preset = p.id;
    btn.dataset.to = p.value;
    btn.title = p.disabled ? `Below the minimum raise (${minRaiseTo})` : `Raise to ${p.value}`;
  });
}

// A preset fills the slider and the input; the raise button still sends.
function applyRaisePreset(value) {
  const slider = document.getElementById('raiseSlider');
  const input = document.getElementById('raiseInput');
  const me = gameState && gameState.players.find((p) => p.id === myId);
  if (!slider || !input || !me) return;
  const lo = Number(slider.min) || 0;
  const hi = Number(slider.max) || value;
  const v = Math.max(lo, Math.min(hi, value));
  slider.value = v;
  input.value = v;
  slider.dataset.userAdjusted = 'true';
  slider.setAttribute('aria-valuenow', v);
  const npEl = document.getElementById('raiseNeedPay');
  if (npEl) npEl.textContent = `to ${v} · +${Math.max(0, v - me.bet)}`;
}

// The viewer's own stack, on the bar. The bar sits over their plate on a short
// screen, and the stack is the one thing on that plate they cannot act without.
function updateBarStack() {
  const el = document.getElementById('barStack');
  if (!el) return;
  const me = gameState ? gameState.players.find((p) => p.id === myId) : null;
  const show = !!me && !!gameState.isMyTurn;
  el.classList.toggle('hidden', !show);
  if (!show) return;
  el.textContent = Number(me.chips || 0).toLocaleString();
  if (me.totalBet > 0) {
    el.appendChild(createTextElement('span', 'bar-stack-in', `in ${me.totalBet}`));
  }
}

// "You have ..." in the action bar, from the server's description of the
// viewer's hand. The viewer's plate caption carries the same words off-turn.
function updateHandStrength() {
  const el = document.getElementById('handStrength');
  if (!el) return;
  const hand = gameState && gameState.myHand;
  el.classList.toggle('hidden', !hand);
  if (!hand) return;
  el.textContent = 'You have ';
  el.appendChild(createTextElement('strong', '', hand.detail));
  // Then the five that make it, so "Two Pair" says which two pair. Preflop
  // there is no five-card hand and the server sends none, which is why this
  // is a list to walk rather than a flag to check.
  for (const card of hand.cards || []) {
    const span = createTextElement(
      'span',
      'hand-card ' + (SUIT_COLORS[card.suit] || 'black'),
      `${card.rank}${SUIT_SYMBOLS[card.suit] || ''}`
    );
    span.setAttribute(
      'aria-label',
      `${RANK_NAMES[card.rank] || card.rank} of ${SUIT_NAMES[card.suit] || card.suit}`
    );
    el.appendChild(span);
  }
}

function updateTurnTimerBars(orderedPlayers) {
  const container = document.getElementById('playerSeats');
  if (!container || !gameState) return;
  const ordered = orderedPlayers || getOrderedPlayersForView();
  const currentSeat = ordered.find(
    (player) =>
      player.originalIndex === gameState.currentPlayerIndex && !player.folded && !player.allIn
  );
  const remainingMs =
    gameState.turnExpiresAt && gameState.turnDurationMs
      ? Math.max(0, gameState.turnExpiresAt - Date.now())
      : 0;
  const ratio =
    gameState.turnExpiresAt && gameState.turnDurationMs
      ? Math.max(0, Math.min(1, remainingMs / gameState.turnDurationMs))
      : 0;
  const secondsLeft = Math.max(1, Math.ceil(remainingMs / 1000));

  ordered.forEach((player) => {
    const seat = seatElementForPlayer(player.id);
    if (!seat) return;
    let timer = seat.querySelector('.player-turn-timer');
    const shouldShow =
      !!currentSeat &&
      player.originalIndex === currentSeat.originalIndex &&
      gameState.gameMode !== 'cash' &&
      gameState.isRunning &&
      gameState.turnExpiresAt;
    if (!shouldShow) {
      if (timer) timer.remove();
      return;
    }
    if (!timer) {
      timer = document.createElement('div');
      timer.className = 'player-turn-timer';
      const icon = document.createElement('span');
      icon.className = 'player-turn-timer-icon';
      icon.textContent = '⌛';
      const text = document.createElement('span');
      text.className = 'player-turn-timer-text';
      timer.append(icon, text);
      seat.appendChild(timer);
    }
    timer.classList.toggle('is-critical', ratio <= 0.35);
    timer.style.setProperty('--timer-ratio', `${Math.max(0, ratio)}`);
    timer.title = `${secondsLeft}s left`;
    timer.setAttribute('aria-label', `${secondsLeft} seconds left to act`);
    const text = timer.querySelector('.player-turn-timer-text');
    if (text) text.textContent = `${secondsLeft}s`;
  });
}

function updateTopBar() {
  if (!gameState) return;
  const phaseNames = {
    waiting: 'Waiting',
    preflop: 'Preflop',
    flop: 'Flop',
    turn: 'Turn',
    river: 'River',
    showdown: 'Showdown',
  };
  const me = gameState.players.find((p) => p.id === myId);
  const topInfo = document.getElementById('topInfo');
  if (!topInfo) return;

  let text = '';
  const field = window.mttField;
  if (!me && field && field.you && field.you.eliminated) {
    text = `Watching table ${field.you.watchingTable || ''}`.trim();
    if (field.you.place) text += ` · out in #${field.you.place}`;
  } else if (me && me.isConnected === false) {
    text = me.autoPlay ? 'Disconnected · sitting out' : 'Disconnected';
  } else if (me && me.isSpectator && !gameState.gameOver) {
    text =
      me.chips > 0
        ? 'Spectating · joins next hand'
        : gameState.tournament && gameState.tournament.isActive
          ? 'Spectating · eliminated from tournament'
          : 'Spectating';
  } else if (!gameState.isRunning && gameState.roundCount === 0) {
    text = 'Waiting for the first deal';
    if (gameState.hostName) text += ` · Host ${gameState.hostName}`;
  } else {
    // Showdown deliberately has no special case: it reads as
    // "Round N · Showdown · chips" like every other phase. The old
    // "Hand complete" wording announced a pause that does not exist, since the
    // server deals the next hand on its own timer.
    text =
      `Round ${gameState.roundCount} · ${phaseNames[gameState.phase] || gameState.phase}` +
      (me ? ` · ${me.chips}` : '');
  }

  if (me && me.autoPlay) text += ' · sitting out';

  topInfo.textContent = text;
}

function showResult(options = {}) {
  const { refreshOnly = false } = options;
  const modal = document.getElementById('resultModal');
  const details = document.getElementById('resultDetails');
  const title = document.getElementById('resultTitle');

  if (!gameState) return;

  // No "Hand Complete" popup between hands.
  //
  // It interrupted the table after every single hand while doing nothing: the
  // server has no 'nextRound' handler, so the button's socket.emit('nextRound')
  // was a no-op, and the next hand is dealt by the server's own _autoTimer
  // regardless of whether anyone clicked. Everything the popup listed (winner,
  // split pots, unmatched chips returned) is already emitted to the message log
  // by engine.js, so nothing is lost by dropping it.
  //
  // The modal is still the game-over UI, where its buttons genuinely do
  // something (Play Again, Exit Table, ready toggle), so only that case shows.
  if (!gameState.gameOver) {
    modal.classList.add('hidden');
    return;
  }

  // Check if human player won this hand
  const me = gameState.players.find((p) => p.id === myId);

  details.textContent = '';

  // War report highlights
  if (gameState.warReport && gameState.warReport.highlights) {
    const report = document.createElement('div');
    report.className = 'war-report-details';
    for (const h of gameState.warReport.highlights) {
      report.appendChild(createTextElement('div', 'wr-highlight', h));
    }
    details.appendChild(report);
    const separator = document.createElement('hr');
    separator.className = 'result-separator';
    details.appendChild(separator);
  }

  const refundEntries = Array.isArray(gameState.lastRoundRefunds) ? gameState.lastRoundRefunds : [];
  const myRefund = refundEntries.find((entry) => entry.playerId === myId);
  if (myRefund) {
    details.appendChild(
      createTextElement(
        'div',
        'result-refund result-refund-me',
        `Returned ${myRefund.amount} unmatched chips`
      )
    );
  } else if (refundEntries.length > 0) {
    refundEntries.forEach((entry) => {
      const refundPlayer = gameState.players.find((player) => player.id === entry.playerId);
      const refundName = getPlayerDisplayName(refundPlayer) || entry.playerName;
      details.appendChild(
        createTextElement(
          'div',
          'result-refund',
          `${refundName} had ${entry.amount} unmatched chips returned`
        )
      );
    });
  }

  const sorted = [...gameState.players].sort((a, b) => b.chips - a.chips);
  for (const p of sorted) {
    const isMe = p.id === myId;
    details.appendChild(
      createTextElement(
        'div',
        isMe ? 'winner-line' : '',
        `${getPlayerDisplayName(p)}: ${p.chips} chips (${p.wins} wins)`
      )
    );
  }

  // Server tells us exactly who won — no message parsing needed
  const iWon = gameState.lastRoundWinnerIds && gameState.lastRoundWinnerIds.includes(myId);
  const gameOver = gameState.gameOver;
  const gameOverWinner = gameOver
    ? gameState.players.find((player) => player.id === gameOver.winnerId)
    : null;

  if (gameOver) {
    const winnerName = getPlayerDisplayName(gameOverWinner) || gameOver.winnerName || 'Winner';
    title.textContent = iWon ? 'You cleared the table!' : `${winnerName} cleared the table`;
    title.classList.add('result-title-winner');
    details.appendChild(document.createElement('hr')).className = 'result-separator';
    const rematchGuests = gameState.players.filter((player) => player.uid !== gameState.hostId);
    const readyGuests = rematchGuests.filter((player) => player.isReady);
    details.appendChild(
      createTextElement(
        'div',
        'result-refund',
        'The table is finished. Choose Play Again to reset all chips, or Exit Table to leave.'
      )
    );
    if (rematchGuests.length > 0) {
      const waitingGuests = rematchGuests.filter((player) => !player.isReady);
      details.appendChild(
        createTextElement(
          'div',
          'result-refund',
          `Rematch readiness: ${readyGuests.length}/${rematchGuests.length} guests ready`
        )
      );
      if (readyGuests.length > 0) {
        details.appendChild(
          createTextElement(
            'div',
            'result-refund',
            `Ready: ${readyGuests.map((player) => getPlayerDisplayName(player)).join(', ')}`
          )
        );
      }
      if (waitingGuests.length > 0) {
        details.appendChild(
          createTextElement(
            'div',
            'result-refund',
            `Waiting: ${waitingGuests.map((player) => getPlayerDisplayName(player)).join(', ')}`
          )
        );
      }
    }
    if (iWon && !refreshOnly) launchConfetti();
  } else if (iWon) {
    title.textContent = 'You won!';
    title.classList.add('result-title-winner');
    // Confetti celebration
    if (!refreshOnly) launchConfetti();
  } else {
    // Only reachable at game over now that the between-hands popup is gone.
    title.textContent = 'Table over';
    title.classList.remove('result-title-winner');
  }

  const latestHand =
    gameState.recentHands && gameState.recentHands.length > 0
      ? gameState.recentHands[gameState.recentHands.length - 1]
      : null;
  if (latestHand && Array.isArray(latestHand.winners) && latestHand.winners.length > 0) {
    const winSummary = latestHand.winners
      .map((winner) => `${winner.playerName} won with ${winner.handName || 'the pot'}`)
      .join(' · ');
    details.appendChild(createTextElement('div', 'result-victory-line', winSummary));
  }

  modal.classList.remove('hidden');
}

// Confetti celebration effect for human winners
function launchConfetti() {
  const container = document.createElement('div');
  container.className = 'confetti-layer';
  document.body.appendChild(container);

  const colors = ['#c9a84c', '#e8e0d0', '#5c3d1a', '#4a7a5a', '#8a7e6a', '#f5f0e8'];
  const emojis = ['✨', '♠', '♦', '♣', '♥'];

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    const isEmoji = Math.random() < 0.2;
    piece.className = isEmoji ? 'confetti-piece confetti-piece-emoji' : 'confetti-piece';
    piece.style.setProperty('--confetti-left', `${Math.random() * 100}%`);
    piece.style.setProperty('--confetti-delay', `${Math.random() * 0.8}s`);
    piece.style.setProperty('--confetti-duration', `${2 + Math.random() * 2}s`);
    piece.style.setProperty('--confetti-drift', `${-50 + Math.random() * 100}px`);
    if (isEmoji) {
      piece.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      piece.style.setProperty('--confetti-size', `${16 + Math.random() * 16}px`);
    } else {
      const color = colors[Math.floor(Math.random() * colors.length)];
      piece.style.setProperty('--confetti-width', `${6 + Math.random() * 6}px`);
      piece.style.setProperty('--confetti-height', `${4 + Math.random() * 8}px`);
      piece.style.setProperty('--confetti-color', color);
      piece.style.setProperty('--confetti-rotation', `${Math.random() * 360}deg`);
    }
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 4000);
}
