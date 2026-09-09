// table.spec.js - the table screen, end to end in a real browser.
//
// The Jest suite covers the engine thoroughly and the DOM barely at all. This
// spec is the safety net for the table UI: it boots the real server, seats two
// humans at a tournament table, deals, and checks that the seats, the action
// bar, the log and a raise all round-trip through the socket. Server-side
// assertions go through game.onMessage rather than the log DOM so they survive
// the log moving between containers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');

let serverModule;
let baseUrl;
let tempDir;
const originalEnv = { ...process.env };
const repoRoot = path.join(__dirname, '..');

test.beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-table-pw-'));
  process.env.SAVE_DIR = tempDir;
  process.env.HOST = '127.0.0.1';
  // A sit-out acts almost at once so the viewer's turn comes round quickly.
  process.env.AUTO_TURN_DELAY_MS = '40';
  // A tournament created to start now deals on the next sweep.
  process.env.TOURNAMENT_SWEEP_MS = '100';
  // The table holds a beat between streets and between hands so a person can
  // follow it. Long enough here to be observable, short enough to test with.
  process.env.STREET_PAUSE_MS = '400';
  process.env.HAND_PAUSE_MS = '400';
  // Every test in this file creates a tournament against one in-process
  // server, and the default cap of eight is reached part way down the file.
  // The short abandon grace also clears each finished test's table instead of
  // leaving it dealing hands to nobody for the rest of the run.
  process.env.MAX_TOURNAMENTS = '50';
  process.env.TOURNAMENT_ABANDON_GRACE_MS = '3000';
  // engine.js reads AUTO_TURN_DELAY_MS at load, and another spec in this worker may
  // already have loaded it. Drop every repo module so the env takes effect.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(repoRoot) && !key.includes(`${path.sep}node_modules${path.sep}`)) {
      delete require.cache[key];
    }
  }
  serverModule = require('../server');
  await serverModule.startServer({
    port: 0,
    host: '127.0.0.1',
    unrefServer: true,
  });
  baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => serverModule.io.close(resolve));
  if (serverModule.server.listening) {
    await new Promise((resolve) => serverModule.server.close(resolve));
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.env = originalEnv;
});

let guestContext = null;
let browserRef = null;

test.beforeEach(({ browser }) => {
  browserRef = browser;
});

test.afterEach(async () => {
  if (guestContext) await guestContext.close();
  guestContext = null;
  // Both seats of a finished test's table are sitting out once the pages
  // close, and a table of sit-outs keeps dealing itself hands until the
  // abandon reaper notices. Stop the field so it does not compete with the
  // next test for the box.
  for (const entry of serverModule.registry.tournaments.values()) {
    if (entry.director && entry.director.isRunning) entry.director.holdField();
  }
});

// The table a page is seated at, through the registry: the page knows its
// identity uid, and the registry knows where that uid sits right now.
async function gameForPage(page) {
  const uid = await page.evaluate(() => window.__identity && window.__identity.uid);
  const entry = serverModule.registry.findByUid(uid);
  const seat = entry ? entry.director.playerByUid(uid) : null;
  return seat ? seat.table : null;
}

// A dealt heads-up table. A field of one never starts, so the viewer needs an
// opponent: a second browser context joins by link and the host starts.
//
// The opponent sits out the moment it is seated. Left as a live human it would
// never act, and the viewer would wait out its whole 25-second clock before the
// action came round; sitting out, it checks or folds on its own and the turn
// reaches the viewer within a hand. The context is closed in afterEach.
async function seatAtTournamentTable(page, name) {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto(baseUrl);
  await page.fill('#playerName', name);
  await page.locator('#playerName').blur();
  await expect(page.locator('#identityStatus')).toContainText(`Playing as ${name}`);
  await page.click('#btnCreateTournament');
  await page.fill('#tName', `${name} table`);
  await page.click('#tStartQuick button[data-min="15"]');
  await page.click('#btnCreateSubmit');
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  const code = (await page.locator('#wrCode').textContent()).trim();

  guestContext = await browserRef.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`${baseUrl}/?t=${code.toLowerCase()}`);
  await guest.fill('#playerName', `${name}Foe`);
  await guest.locator('#playerName').blur();
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();

  // Enabled only once the guest's registration has reached the host.
  await expect(page.locator('#btnStartNow')).toBeEnabled();
  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 15000 });
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 15000 });
  // The game screen opens on tournamentJoined, before the first gameState
  // arrives; clicking sit-out any earlier is a no-op because the client has no
  // seat to toggle yet.
  await expect(guest.locator('#playerSeats .player-seat:not(.seat-empty)')).toHaveCount(2);
  await guest.click('#btnAutoPlay');
  await expect(guest.locator('#seatBanner')).toBeVisible({ timeout: 10000 });
  return pageErrors;
}

async function deal(page) {
  await expect(page.locator('#actionsPanel')).not.toHaveClass(/hidden/, { timeout: 20000 });
}

test('a tournament table seats every player, deals, and hands the viewer the action bar', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'TableTester');

  await expect(page.locator('#playerSeats .player-seat:not(.seat-empty)')).toHaveCount(2);

  await deal(page);

  await expect(page.locator('#logLast')).not.toContainText('joined the table');
  await expect(page.locator('#panelChatBody .log-entry')).not.toHaveCount(0);
  await expect(page.locator('#panelChatBody .log-entry[data-kind="handStart"]')).not.toHaveCount(0);
  // Two blinds a hand. The opponent is sitting out, so a hand it opens ends
  // at once and the viewer's turn can arrive on the second one; the count is
  // a multiple of two rather than exactly two.
  const blinds = await page.locator('#panelChatBody .log-entry[data-kind="blind"]').count();
  expect(blinds).toBeGreaterThanOrEqual(2);
  expect(blinds % 2).toBe(0);
  await expect(page.locator('#tabChat')).toHaveAttribute('aria-selected', 'true');
  await page.click('#tabInfo');
  await expect(page.locator('#panelInfo')).toBeVisible();
  await expect(page.locator('#panelChat')).toBeHidden();
  await page.keyboard.press('Home');
  await expect(page.locator('#panelChat')).toBeVisible();
  await expect(page.locator('#panelInfoBody')).toContainText('Multi-table');
  await expect(page.locator('#panelInfoBody')).toContainText('Blinds');
  await page.click('#btnLeaderboard');
  await expect(page.locator('#panelStats')).toBeVisible();
  await expect(page.locator('#panelStatsBody')).toContainText('Leaderboard');
  await expect(page.locator('#lbPanel')).toBeHidden();
  await page.click('#btnReplay');
  await expect(page.locator('#panelHistory')).toBeVisible();
  await expect(page.locator('#replayPanel')).toBeHidden();
  await expect(page.locator('#btnFold')).toBeVisible();
  // Blinds are on the felt as chip stacks, and every plate carries an avatar
  await expect(page.locator('#feltBets .felt-bet')).not.toHaveCount(0);
  await expect(page.locator('#playerSeats .seat-plate .seat-avatar')).toHaveCount(2);
  await expect(page.locator('.player-bet-badge')).toHaveCount(0);
  await expect(page.locator('#handStrength')).toContainText('You have');
  await expect(page.locator('#presetGroup .preset-btn')).toHaveCount(4);
  await expect(page.locator('#playerSeats .player-seat.active-turn')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('a raise from the action bar reaches the engine', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'RaiseTester');
  await deal(page);

  const game = await gameForPage(page);
  expect(game).toBeTruthy();
  const messages = [];
  const forward = game.onMessage;
  game.onMessage = (msg, meta) => {
    messages.push(msg);
    if (forward) forward(msg, meta);
  };

  await expect(page.locator('#btnRaise')).toBeVisible();
  // A preset fills the slider and input; the raise button sends that amount.
  const preset = page.locator('#presetGroup .preset-btn:enabled').first();
  await expect(preset).toBeVisible();
  const amount = Number(await preset.getAttribute('data-to'));
  expect(amount).toBeGreaterThan(0);
  await preset.click();
  await expect(page.locator('#raiseInput')).toHaveValue(String(amount));
  await page.click('#btnRaise');

  await expect
    .poll(() => messages.some((msg) => msg === `RaiseTester raises to ${amount}`), {
      timeout: 5000,
    })
    .toBe(true);
  expect(pageErrors).toEqual([]);
});

test('requesting time extends the clock once per hand', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'TimeTester');
  await deal(page);
  const game = await gameForPage(page);
  expect(game).toBeTruthy();
  const messages = [];
  const forward = game.onMessage;
  game.onMessage = (msg, meta) => {
    messages.push(msg);
    if (forward) forward(msg, meta);
  };

  const button = page.locator('#btnRequestTime');
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  const before = game.turnExpiresAt;
  await button.click();
  await expect.poll(() => game.turnExpiresAt > before, { timeout: 5000 }).toBe(true);
  expect(game.turnExpiresAt - before).toBeGreaterThanOrEqual(25000);
  expect(messages).toContain('⏱ TimeTester requested time');
  await expect(button).toBeDisabled();
  expect(pageErrors).toEqual([]);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the side panel is a drawer: toggle, Escape, scrim, and the stats button', async ({
    page,
  }) => {
    const pageErrors = await seatAtTournamentTable(page, 'PhoneTester');
    const panel = page.locator('#sidePanel');
    await expect(panel).toBeHidden();
    await expect(page.locator('#btnPanelToggle')).toHaveAttribute('aria-expanded', 'false');

    await page.click('#btnPanelToggle');
    await expect(panel).toBeVisible();
    await expect(page.locator('#panelScrim')).toBeVisible();
    await expect(page.locator('#btnPanelToggle')).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    await page.click('#btnPanelToggle');
    await expect(panel).toBeVisible();
    await page.locator('#panelScrim').click({ position: { x: 5, y: 400 } });
    await expect(panel).toBeHidden();

    await page.click('#btnLeaderboard');
    await expect(panel).toBeVisible();
    await expect(page.locator('#panelStats')).toBeVisible();
    await expect(page.locator('#lbPanel')).toBeHidden();
    await page.click('#btnPanelClose');
    await expect(panel).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});

test('the pot sits above the board and carries a pile of chips', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'PotTester');
  await deal(page);

  const pot = await page.locator('#potDisplay').boundingBox();
  const board = await page.locator('#communityCards').boundingBox();
  // The whole point of .board-stack: the pot hangs off the top of the card
  // row, so this holds at every card size without a per-breakpoint offset.
  expect(pot.y + pot.height).toBeLessThanOrEqual(board.y + 1);

  await expect(page.locator('#potPile .pot-chip')).not.toHaveCount(0);
  // The pile must never collide with a bet stack; on a short felt they are
  // neighbours, and a bounding-box check between the pot and the board misses
  // it because the colliding element is in a different layer.
  const bets = await page.locator('#feltBets .felt-bet').all();
  for (const bet of bets) {
    const b = await bet.boundingBox();
    const overlaps =
      b.x < pot.x + pot.width &&
      pot.x < b.x + b.width &&
      b.y < pot.y + pot.height &&
      pot.y < b.y + b.height;
    expect(overlaps).toBe(false);
  }
  expect(pageErrors).toEqual([]);
});

test('the street bets sweep into the pot when the board turns over', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'SweepTester');
  await deal(page);
  const game = await gameForPage(page);
  expect(game).toBeTruthy();

  // Calling closes the preflop round: the opponent is sitting out, so it
  // checks its big blind and the flop lands.
  const before = await page.evaluate(() => window.__anim.sweeps);
  const potBefore = await page.evaluate(() => gameState.pot);
  await expect(page.locator('#feltBets .felt-bet')).not.toHaveCount(0);
  await page.click('#btnCall');

  await expect.poll(() => game.communityCards.length, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  // Exactly one sweep for one street. Two would mean it also fired on a push
  // it should have ignored.
  await expect.poll(() => page.evaluate(() => window.__anim.sweeps)).toBe(before + 1);
  await expect(page.locator('#feltBets .felt-bet')).toHaveCount(0);
  // The engine credits the pot action by action, so the sweep is the money
  // catching up with a number that already moved. If the pot jumps here,
  // something has started double-counting.
  expect(await page.evaluate(() => gameState.pot)).toBeGreaterThanOrEqual(potBefore);

  // Nothing left behind: a leaked ghost accumulates over a long session.
  await expect(page.locator('.chip-fly')).toHaveCount(0, { timeout: 5000 });

  // The flop turns over rather than sliding in, one card at a time.
  expect(await page.evaluate(() => window.__anim.flips)).toBeGreaterThanOrEqual(3);
  // Both halves of the flip clean up. The animation fills both ways, so a
  // card left with the class keeps its final transform for the rest of the
  // hand, which silently breaks hover on every board card.
  await expect(page.locator('#communityCards .card-flipback')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('#communityCards .card.flipping')).toHaveCount(0);
  const stuck = await page.$$eval('#communityCards .card', (els) =>
    els.filter((el) => {
      const t = getComputedStyle(el).transform;
      return t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';
    })
  );
  expect(stuck).toHaveLength(0);
  expect(pageErrors).toEqual([]);
});

test('the hole cards are dealt from the button, one at a time, twice round', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'DealTester');
  await deal(page);

  // Sit out so hands cycle in a second or two instead of waiting out the
  // viewer's 25s action clock; the seat is still dealt in.
  await page.click('#btnAutoPlay');

  // Wait for a fresh deal so the schedule under test is the one just written.
  const round = await page.evaluate(() => gameState.roundCount);
  await page.waitForFunction((r) => gameState && gameState.roundCount > r, round, {
    timeout: 30000,
  });
  await expect.poll(() => page.evaluate(() => window.__anim.deals)).toBeGreaterThan(0);

  const info = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('#playerSeats .player-hole-cards > *')].map((el) => ({
      order: Number(el.dataset.dealOrder),
      seat: el.closest('.player-seat').dataset.playerId,
    })),
    seats: [...document.querySelectorAll('#playerSeats .player-seat:not(.seat-empty)')].map(
      (el) => el.dataset.playerId
    ),
    dealer: (document.querySelector('#playerSeats .player-seat:has(.dealer-chip)') || {}).dataset
      ?.playerId,
  }));

  // Every card has a place in the order, and the places are 0..n-1.
  const orders = info.cards.map((c) => c.order).sort((a, b) => a - b);
  expect(orders).toEqual(orders.map((_, i) => i));

  // The first card goes to the seat left of the button. Heads-up this also
  // means the button takes the second card, which is the real rule.
  const first = info.cards.find((c) => c.order === 0);
  const leftOfButton = info.seats[(info.seats.indexOf(info.dealer) + 1) % info.seats.length];
  expect(first.seat).toBe(leftOfButton);

  // Nothing left hidden or frozen. deal-pending is visibility:hidden, so a
  // stuck one would hide that player's cards for the whole hand, and the
  // animation fills both ways, so a stuck class would freeze the transform.
  await expect(page.locator('.deal-pending')).toHaveCount(0, { timeout: 4000 });
  await expect(page.locator('#playerSeats .dealing')).toHaveCount(0, { timeout: 4000 });
  const stuck = await page.$$eval('#playerSeats .player-hole-cards > *', (els) =>
    els.filter((el) => {
      const t = getComputedStyle(el).transform;
      return t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';
    })
  );
  expect(stuck).toHaveLength(0);
  expect(pageErrors).toEqual([]);
});

test('the chip sound is served, decoded, and played when chips move', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'SoundTester');
  await deal(page);

  // The link is where the script reads the URL from, and it carries the asset
  // version so a replacement sound is not served from cache.
  const href = await page.getAttribute('#sfxChips', 'href');
  expect(href).toMatch(/^\/audio\/chips\.mp3\?v=[a-f0-9]{10}$/);

  // Decoding proves the file is really audio and really reachable; a 404 page
  // or a truncated upload fails here rather than going silently quiet.
  await page.evaluate(() => SFX.init());
  await expect
    .poll(() => page.evaluate(() => !!(SFX.samples && SFX.samples.chips)), { timeout: 10000 })
    .toBe(true);
  const sample = await page.evaluate(() => ({
    duration: SFX.samples.chips.duration,
    channels: SFX.samples.chips.numberOfChannels,
  }));
  expect(sample.duration).toBeGreaterThan(0.1);
  expect(sample.channels).toBeGreaterThan(0);

  // Chips moving is what makes the sound, and a burst makes one sound rather
  // than one per player.
  await page.evaluate(() => {
    window.__played = 0;
    const real = SFX.playSample.bind(SFX);
    // Forward every argument: playSample also takes a schedule offset and a
    // playback rate, and a wrapper that named only two would drop them while
    // still counting, so this test would pass over a broken call.
    SFX.playSample = (...args) => {
      const ok = real(...args);
      if (ok) window.__played++;
      return ok;
    };
  });
  await page.click('#btnCall');
  await expect.poll(() => page.evaluate(() => window.__played), { timeout: 10000 }).toBe(1);

  expect(pageErrors).toEqual([]);
});

test('the turn chime fires once when the action arrives, not on every push', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'ChimeTester');
  await deal(page);

  await page.evaluate(() => {
    window.__chimes = 0;
    window.__edges = 0;
    window.__wasMine = !!(gameState && gameState.isMyTurn);
    const real = SFX.play.bind(SFX);
    SFX.play = (type) => {
      if (type === 'turn') window.__chimes++;
      return real(type);
    };
    socket.on('gameState', (s) => {
      const mine = !!s.isMyTurn;
      if (mine && !window.__wasMine) window.__edges++;
      window.__wasMine = mine;
    });
  });

  // Requesting time pushes fresh state while the turn is still ours. That is
  // the deterministic version of the bug: the chime used to test isMyTurn
  // rather than the edge into it, so anything landing mid-turn re-fired it.
  await expect(page.locator('#btnRequestTime')).toBeEnabled();
  await page.click('#btnRequestTime');
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__chimes)).toBe(0);

  // And it is latched, not silenced: act, and the next turn chimes once.
  // Pick the button that is actually live rather than clicking one and
  // catching: a Playwright click on a hidden target retries until the test
  // times out, so the fallback would never run.
  const action = await page.evaluate(() =>
    ['btnCheck', 'btnCall'].find((id) => {
      const el = document.getElementById(id);
      return el && !el.disabled && el.offsetParent !== null;
    })
  );
  expect(action).toBeTruthy();
  await page.click('#' + action);
  await expect
    .poll(() => page.evaluate(() => window.__edges), { timeout: 20000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => ({ c: window.__chimes, e: window.__edges })))
    .toEqual({ c: 1, e: 1 });

  expect(pageErrors).toEqual([]);
});

test('the table holds a beat between the betting and the next street', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'PaceTester');
  await deal(page);
  const game = await gameForPage(page);

  // Record every distinct shape of the felt so the order of events can be
  // read back: the bets have to be seen on the felt after the round closes
  // and before any card arrives.
  await page.evaluate(() => {
    window.__frames = [];
    let last = '';
    socket.on('gameState', (s) => {
      const key = `${s.phase}|b${s.communityCards.length}|bets${s.players.filter((x) => x.bet > 0).length}`;
      if (key === last) return;
      last = key;
      window.__frames.push({ t: Math.round(performance.now()), key });
    });
  });

  const action = await page.evaluate(() =>
    ['btnCall', 'btnCheck'].find((id) => {
      const el = document.getElementById(id);
      return el && !el.disabled && el.offsetParent !== null;
    })
  );
  expect(action).toBeTruthy();
  await page.click('#' + action);

  await expect.poll(() => game.communityCards.length, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(200);

  const frames = await page.evaluate(() => window.__frames);
  const closed = frames.find((f) => f.key.startsWith('preflop|b0|bets'));
  const opened = frames.find((f) => f.key.startsWith('flop|b3'));
  expect(closed).toBeTruthy();
  expect(opened).toBeTruthy();

  // The gap is the beat. Without it the closing bet and the flop arrive in
  // one frame and there is nothing to watch.
  const held = opened.t - closed.t;
  expect(held).toBeGreaterThan(250);
  expect(pageErrors).toEqual([]);
});

test('at showdown the five winning cards light up and the rest dim', async ({ page }) => {
  // Heads-up against a sitting-out opponent, only about half the hands reach a
  // showdown: the sit-out folds to a bet, so whenever it holds the small blind
  // it folds to the big blind preflop and nothing is turned over. The test
  // therefore waits for a favourable deal, and how long that takes is luck.
  // Observed spread on an idle box is 5s to 21s, so the budget is set well past
  // the worst case rather than just past the average, and the default timeout
  // is raised to leave room for it. A good run still exits in a few seconds;
  // only a bad one spends the budget.
  test.setTimeout(120000);
  const pageErrors = await seatAtTournamentTable(page, 'ShowTester');
  await deal(page);

  // Check or call whenever the action arrives. The opponent is sitting out, so
  // it checks its blind and checks down; a hand where the viewer is the small
  // blind reaches a showdown.
  // Bounded by the clock, not by a loop count: hands take as long as the
  // street and hand pauses make them, so a fixed number of turns either gives
  // up early or outlives the test timeout, and a timeout reports nothing.
  // The highlight lasts exactly one hand pause and then the next deal clears it.
  // Detecting the showdown in one round trip and measuring the DOM in a second
  // races that window and loses it under load, so the measurement is taken in
  // the same evaluate that finds the showdown. gameState and the DOM cannot
  // disagree inside one call: the socket handler assigns the state and renders
  // from it synchronously, so nothing can interleave between the two reads.
  let marks = null;
  let last = null;
  const deadline = Date.now() + 90000;
  while (!marks && Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const lit = ((gameState && gameState.showdownWinningCards) || []).length;
      const atShowdown = !!(gameState && gameState.phase === 'showdown' && lit > 0);
      const me = gameState && gameState.players.find((p) => p.id === myId);
      return {
        atShowdown,
        // Carried only so a failure can say what it was stuck on.
        why: {
          phase: gameState && gameState.phase,
          hand: gameState && gameState.roundCount,
          myTurn: !!(gameState && gameState.isMyTurn),
          autoPlay: !!(me && me.autoPlay),
          running: !!(gameState && gameState.isRunning),
        },
        marks: atShowdown
          ? {
              winning: lit,
              boardLit: document.querySelectorAll('#communityCards .card.is-winning').length,
              holeLit: document.querySelectorAll('#playerSeats .card.is-winning').length,
              dimmed: document.querySelectorAll('.card.is-dimmed').length,
              seatsLit: document.querySelectorAll('#playerSeats .player-seat.hand-winner').length,
            }
          : null,
        btn: ['btnCheck', 'btnCall'].find((id) => {
          const el = document.getElementById(id);
          return el && !el.disabled && el.offsetParent !== null;
        }),
      };
    });
    last = st.why;
    if (st.atShowdown) {
      marks = st.marks;
      break;
    }
    if (st.btn) {
      // The action bar hides itself during the between-street pause, and a
      // click on a hidden target retries until the *test* times out, so the
      // catch never runs. Give it its own short deadline instead.
      await page.click('#' + st.btn, { timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(120);
    } else {
      await page.waitForTimeout(200);
    }
  }
  expect(marks, `never reached a showdown; last saw ${JSON.stringify(last)}`).not.toBeNull();

  // Five is the invariant. It catches the union being built wrong, and it
  // catches the board key not including the winners, which would leave the
  // community cards unmarked while the hole cards looked fine.
  expect(marks.winning).toBe(5);
  expect(marks.boardLit + marks.holeLit).toBe(5);
  expect(marks.boardLit).toBeGreaterThan(0);
  expect(marks.dimmed).toBeGreaterThan(0);
  expect(marks.seatsLit).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('folding when checking is free asks first, and folding to a bet does not', async ({
  page,
}) => {
  test.setTimeout(120000);
  const pageErrors = await seatAtTournamentTable(page, 'FoldGuard');
  await deal(page);

  // Get to a spot where checking is free. Heads-up the viewer is often facing
  // the blind first, so act until nothing is owed.
  const owed = () =>
    page.evaluate(() => {
      const me = gameState.players.find((p) => p.id === myId);
      return gameState.isMyTurn ? Math.max(0, gameState.currentBet - (me.bet || 0)) : -1;
    });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const o = await owed();
    if (o === 0) break;
    // o === -1 means it is not our turn yet; anything above zero is a price to
    // pay to stay in. Only click a button that is actually on screen.
    if (
      o > 0 &&
      (await page
        .locator('#btnCall')
        .isVisible()
        .catch(() => false))
    ) {
      await page
        .locator('#btnCall')
        .click({ timeout: 2000 })
        .catch(() => {});
    }
    await page.waitForTimeout(300);
  }
  expect(await owed()).toBe(0);

  // Folding here would give the hand up for nothing, so it is questioned.
  await page.locator('#btnFold').click();
  await expect(page.locator('#appDialogModal')).not.toHaveClass(/hidden/);
  await expect(page.locator('#appDialogTitle')).toContainText(/fold/i);

  // Backing out leaves the hand exactly as it was: still your turn, still in.
  await page.locator('#btnAppDialogCancel').click();
  await expect(page.locator('#appDialogModal')).toHaveClass(/hidden/);
  expect(
    await page.evaluate(() => {
      const me = gameState.players.find((p) => p.id === myId);
      return me.folded;
    })
  ).toBe(false);

  // Going through with it does fold.
  await page.locator('#btnFold').click();
  await expect(page.locator('#appDialogModal')).not.toHaveClass(/hidden/);
  await page.locator('#btnAppDialogConfirm').click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const me = gameState.players.find((p) => p.id === myId);
        return me ? me.folded : false;
      })
    )
    .toBe(true);

  expect(pageErrors).toEqual([]);
});

test('the bubble is announced on the felt, and goes away again', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'BubbleWatch');
  await deal(page);

  // A heads-up table with one place paid is genuinely on the bubble already —
  // the next bust ends somebody's tournament with nothing — so the starting
  // point is set explicitly rather than assumed.
  await page.evaluate(() => {
    window.mttField = { onBubble: false, remaining: 40, paidPlaces: 20 };
    updateBlindClock();
  });
  await expect(page.locator('#tbBubble')).toHaveClass(/hidden/);
  await expect(page.locator('#tournamentBanner')).not.toHaveClass(/on-bubble/);

  // Reaching a real bubble takes a whole field busting down to the money, so
  // the field summary is set directly: this is about what the felt does with
  // it, not about how the director decides it.
  await page.evaluate(() => {
    window.mttField = { onBubble: true, remaining: 21, paidPlaces: 20 };
    updateBlindClock();
  });
  const badge = page.locator('#tbBubble');
  await expect(badge).not.toHaveClass(/hidden/);
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/bubble/i);
  await expect(badge).toContainText('21');
  await expect(badge).toContainText('20');
  await expect(badge).toContainText(/hand for hand/i);
  await expect(page.locator('#tournamentBanner')).toHaveClass(/on-bubble/);

  // And it is taken away the moment it stops being true, rather than lingering.
  await page.evaluate(() => {
    window.mttField = { onBubble: false, inTheMoney: true, remaining: 20, paidPlaces: 20 };
    updateBlindClock();
  });
  await expect(badge).toHaveClass(/hidden/);
  await expect(page.locator('#tournamentBanner')).not.toHaveClass(/on-bubble/);

  expect(pageErrors).toEqual([]);
});

test('picking a hand in the replay panel opens it', async ({ page }) => {
  // Same shape of wait as the showdown test: a hand has to finish before there
  // is anything to replay, and how long that takes is the luck of the deal.
  test.setTimeout(120000);
  const pageErrors = await seatAtTournamentTable(page, 'ReplayTester');
  await deal(page);

  // Play until the server has banked at least one finished hand.
  const deadline = Date.now() + 90000;
  let banked = 0;
  while (!banked && Date.now() < deadline) {
    const st = await page.evaluate(() => ({
      hands: ((gameState && gameState.recentHands) || []).length,
      btn: ['btnCheck', 'btnCall'].find((id) => {
        const el = document.getElementById(id);
        return el && !el.disabled && el.offsetParent !== null;
      }),
    }));
    banked = st.hands;
    if (banked) break;
    if (st.btn) {
      await page.click('#' + st.btn, { timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(120);
    } else {
      await page.waitForTimeout(200);
    }
  }
  expect(banked).toBeGreaterThan(0);

  // The top-bar button reveals the History tab rather than the modal; the tab
  // lists the hands, and picking one there is what opens the replay.
  await page.click('#btnReplay');
  const first = page.locator('#panelHistoryBody .replay-hand-btn').first();
  await expect(first).toBeVisible();

  // The bug this pins: picking a hand emitted a request nothing answered, so
  // the detail never opened and the panel came up blank.
  await first.click();
  await expect(page.locator('#replayPanel')).not.toHaveClass(/hidden/);
  await expect(page.locator('#replayDetail')).not.toHaveClass(/hidden/);
  await expect(page.locator('#replayDetail')).not.toBeEmpty();

  // What each winner took, not just who won. Two bare names read as one pot
  // shared between them, which is exactly what a side pot is not.
  const summary = page.locator('#replayWinnerSummary');
  await expect(summary).toContainText(/Winner|Winners|Split pot/);
  await expect(summary).toContainText(/\d/);

  expect(pageErrors).toEqual([]);
});

test('the card sound is served, decoded, and played once per card', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'CardSound');
  await deal(page);

  const href = await page.getAttribute('#sfxCard', 'href');
  expect(href).toMatch(/^\/audio\/card\.mp3\?v=[a-f0-9]{10}$/);

  // Decoding is what catches a 404 page or a truncated upload; without it the
  // table would just go quiet and nothing would fail.
  await page.evaluate(() => SFX.init());
  await expect
    .poll(() => page.evaluate(() => !!(SFX.samples && SFX.samples.card)), { timeout: 10000 })
    .toBe(true);
  const sample = await page.evaluate(() => ({
    duration: SFX.samples.card.duration,
    channels: SFX.samples.card.numberOfChannels,
  }));
  expect(sample.duration).toBeGreaterThan(0.05);
  expect(sample.channels).toBeGreaterThan(0);

  // Count the card snaps only, and record the offsets each was booked at.
  await page.evaluate(() => {
    window.__cardSnaps = [];
    const real = SFX.playSample.bind(SFX);
    SFX.playSample = (name, gain, whenOffset, rate) => {
      const ok = real(name, gain, whenOffset, rate);
      if (ok && name === 'card') window.__cardSnaps.push(whenOffset || 0);
      return ok;
    };
  });

  // A fresh deal is two cards each for two seats.
  const round = await page.evaluate(() => gameState.roundCount);
  await page.click('#btnAutoPlay'); // sit out so hands turn over quickly
  await page.waitForFunction((r) => gameState && gameState.roundCount > r, round, {
    timeout: 30000,
  });
  await expect
    .poll(() => page.evaluate(() => window.__cardSnaps.length), { timeout: 10000 })
    .toBeGreaterThanOrEqual(4);

  // Booked ahead, not all at once: a per-card sound that fired immediately
  // would be four snaps in one instant rather than a deal going round.
  const offsets = await page.evaluate(() => window.__cardSnaps.slice(0, 4));
  expect(offsets[0]).toBeGreaterThan(0);
  expect(offsets[3]).toBeGreaterThan(offsets[0]);

  expect(pageErrors).toEqual([]);
});

test('the readout names the hand and then shows the five cards', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Readout');
  await deal(page);
  const game = await gameForPage(page);
  expect(game).toBeTruthy();

  // Preflop there is no five-card hand, so the readout names the holding and
  // shows nothing. A card here would be the client inventing one.
  const readout = page.locator('#handStrength');
  await expect(readout).toContainText('You have');
  await expect(readout.locator('.hand-card')).toHaveCount(0);

  await page.click('#btnCall');
  await expect.poll(() => game.communityCards.length, { timeout: 15000 }).toBeGreaterThanOrEqual(3);

  // From the flop on it is a made five, and the name stays: the cards are an
  // addition to the prose, not a replacement for it.
  await expect(readout.locator('.hand-card')).toHaveCount(5, { timeout: 10000 });
  await expect(readout.locator('strong')).not.toBeEmpty();

  // The five it shows are the five the server picked, in the same order.
  const drawn = await readout.locator('.hand-card').allTextContents();
  const sent = await page.evaluate(() => gameState.myHand.cards.map((c) => c.rank));
  expect(drawn.map((t) => t.slice(0, -1))).toEqual(sent);

  // Suit colour is what separates them at a glance; both must resolve to a
  // real colour rather than inheriting the row's text.
  const coloured = await readout
    .locator('.hand-card')
    .evaluateAll((els) =>
      els.map((el) => ({ cls: el.className, color: getComputedStyle(el).color }))
    );
  for (const c of coloured) {
    expect(c.cls).toMatch(/hand-card (red|black)/);
    expect(c.color).toMatch(/^rgb/);
  }

  // The panel still fits the felt. The readout shares its row with the raise
  // presets and has no max-width of its own, so a long line pushes them off
  // rather than wrapping unless the row is told to wrap.
  const panel = await page.locator('#actionsPanel').boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(page.viewportSize().width + 1);

  expect(pageErrors).toEqual([]);
});

test('the deck is shuffled once as a hand is dealt, ahead of the cards', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Shuffle');
  await deal(page);

  const href = await page.getAttribute('#sfxShuffle', 'href');
  expect(href).toMatch(/^\/audio\/shuffle\.mp3\?v=[a-f0-9]{10}$/);

  // Decoding is the check that matters: a 404 page or a truncated copy would
  // leave the table quiet and nothing else would fail.
  await page.evaluate(() => SFX.init());
  await expect
    .poll(() => page.evaluate(() => !!(SFX.samples && SFX.samples.shuffle)), { timeout: 10000 })
    .toBe(true);
  expect(await page.evaluate(() => SFX.samples.shuffle.duration)).toBeGreaterThan(0.5);

  // Tag every booking with the hand it belongs to, because hands turn over on
  // their own once both seats are sitting out and a plain count would be
  // counting an unknown number of deals.
  await page.evaluate(() => {
    window.__sfxLog = [];
    const real = SFX.playSample.bind(SFX);
    SFX.playSample = (name, gain, whenOffset, rate) => {
      const ok = real(name, gain, whenOffset, rate);
      if (ok) {
        window.__sfxLog.push({
          name,
          offset: whenOffset || 0,
          round: gameState ? gameState.roundCount : -1,
        });
      }
      return ok;
    };
  });

  const round = await page.evaluate(() => gameState.roundCount);
  await page.click('#btnAutoPlay'); // sit out so the next hand comes quickly
  await page.waitForFunction((r) => gameState && gameState.roundCount > r, round, {
    timeout: 30000,
  });
  // Let the deal finish and a few more state pushes land: the failure this
  // guards against is a re-render firing a second shuffle mid-hand.
  await expect
    .poll(() => page.evaluate(() => window.__sfxLog.filter((e) => e.name === 'card').length), {
      timeout: 10000,
    })
    .toBeGreaterThanOrEqual(4);
  await page.waitForTimeout(1500);

  const log = await page.evaluate(() => window.__sfxLog);
  const dealt = round + 1;
  const shuffles = log.filter((e) => e.name === 'shuffle' && e.round === dealt);
  expect(shuffles).toHaveLength(1);
  // Played now, not booked ahead: the cards are what carry the schedule.
  expect(shuffles[0].offset).toBe(0);

  // And it leads. Every card in that hand is booked after the shuffle starts,
  // so its tail runs under the first ones landing rather than into silence.
  const cards = log.filter((e) => e.name === 'card' && e.round === dealt);
  expect(cards.length).toBeGreaterThanOrEqual(4);
  expect(Math.min(...cards.map((e) => e.offset))).toBeGreaterThan(0);

  // No hand gets two. Later hands are fair game to check for free.
  const perHand = new Map();
  for (const e of log.filter((x) => x.name === 'shuffle')) {
    perHand.set(e.round, (perHand.get(e.round) || 0) + 1);
  }
  for (const count of perHand.values()) expect(count).toBe(1);

  expect(pageErrors).toEqual([]);
});

// The seat record behind a page, not just its table: the pre-action lives on
// the player, and the point of the round trip is that the server has it.
async function seatForPage(page) {
  const uid = await page.evaluate(() => window.__identity && window.__identity.uid);
  const entry = serverModule.registry.findByUid(uid);
  return entry ? entry.director.playerByUid(uid) : null;
}

test('a line armed off turn reaches the server, and the two bars never share the slot', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'PreAct');
  await deal(page);

  // The action bar has the slot, so the pre-action bar does not.
  await expect(page.locator('#preActionPanel')).toHaveClass(/hidden/);

  // The opponent comes back to the table so it has a turn it will sit on for
  // its whole clock. Sitting out it acts in a few milliseconds, which leaves no
  // window to arm anything in.
  const guest = guestContext.pages()[0];
  await guest.click('#btnSitIn');
  await expect(guest.locator('#seatBanner')).toHaveClass(/hidden/);

  // Give the turn away. Heads-up the viewer can be first to act on the next
  // street too, so act until the bar goes.
  for (let i = 0; i < 4; i++) {
    if (await page.locator('#actionsPanel').evaluate((el) => el.classList.contains('hidden')))
      break;
    const call = page.locator('#btnCall');
    if (await call.isVisible()) await call.click();
    else await page.locator('#btnCheck').click();
    await page.waitForTimeout(250);
  }

  // Now the slot belongs to the pre-action bar, and to it alone.
  await expect(page.locator('#preActionPanel')).not.toHaveClass(/hidden/, { timeout: 15000 });
  await expect(page.locator('#actionsPanel')).toHaveClass(/hidden/);
  await expect(page.locator('#preActionRow')).not.toHaveClass(/hidden/);

  const armed = page.locator('#preActionRow .preaction-btn[data-kind="checkfold"]');
  await armed.click();
  await expect(armed).toHaveClass(/is-armed/);
  // The round trip: the engine is holding it, not the page.
  await expect
    .poll(async () => {
      const seat = await seatForPage(page);
      return seat && seat.player.preAction ? seat.player.preAction.kind : null;
    })
    .toBe('checkfold');

  // Tapping the armed one takes it back.
  await armed.click();
  await expect(armed).not.toHaveClass(/is-armed/);
  await expect
    .poll(async () => {
      const seat = await seatForPage(page);
      return seat ? seat.player.preAction : 'no seat';
    })
    .toBeNull();

  // The queued sit-out is a separate control and reaches the seat the same way.
  const sitOut = page.locator('#btnSitOutNextHand');
  await sitOut.click();
  await expect(sitOut).toHaveClass(/is-armed/);
  await expect
    .poll(async () => {
      const seat = await seatForPage(page);
      return seat ? seat.player.sitOutNextHand : null;
    })
    .toBe(true);
  // It is queued, not taken: the hand in progress is untouched.
  const seat = await seatForPage(page);
  expect(seat.player.autoPlay).toBe(false);

  expect(pageErrors).toEqual([]);
});

test('the end of a tournament fires a result screen for the winner and the rest', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'Champ');

  // Driven at the handler the socket calls rather than by playing a
  // tournament out: how one finishes is the engine's business and is covered
  // there, and what this asserts is that finishing puts something on screen.
  await page.evaluate(() => {
    window.TournamentField.showFinished({
      winner: 'Champ',
      results: [
        { place: 1, name: 'Champ', prize: 500, inTheMoney: true },
        { place: 2, name: 'ChampFoe', prize: 0, inTheMoney: false },
      ],
      you: { place: 1, prize: 500 },
    });
  });
  await expect(page.locator('#appDialogModal')).toBeVisible();
  await expect(page.locator('#appDialogTitle')).toContainText('You won the tournament');
  await expect(page.locator('#appDialogBody')).toContainText('First of 2');
  await expect(page.locator('#appDialogBody')).toContainText('500');
  await expect(page.locator('#appDialogHint')).toContainText('1st Champ');
  await page.click('#btnAppDialogConfirm');
  await expect(page.locator('#appDialogModal')).toBeHidden();

  // Everyone else is told who won and where they came, ordinals and all.
  await page.evaluate(() => {
    window.TournamentField.showFinished({
      winner: 'ChampFoe',
      results: [
        { place: 1, name: 'ChampFoe', prize: 0 },
        { place: 2, name: 'Champ', prize: 0 },
        { place: 3, name: 'Spare', prize: 0 },
      ],
      you: { place: 2, prize: 0 },
    });
  });
  await expect(page.locator('#appDialogModal')).toBeVisible();
  await expect(page.locator('#appDialogTitle')).toContainText('ChampFoe won');
  await expect(page.locator('#appDialogBody')).toContainText('You finished 2nd of 3');
  await page.click('#btnAppDialogConfirm');

  expect(pageErrors).toEqual([]);
});

test('the action bar keeps its geometry, and the presets price the pot after the flop', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'Steady');
  await deal(page);

  const panelBox = () => page.locator('#actionsPanel').boundingBox();
  const raiseBox = () => page.locator('#btnRaise').boundingBox();
  const panelBefore = await panelBox();
  const raiseBefore = await raiseBox();

  // Preflop the sizings are multiples of the blind, which is how a preflop
  // raise is actually chosen.
  await expect(page.locator('#presetGroup .preset-btn')).toHaveCount(4);
  await expect(page.locator('#presetGroup')).toContainText('3bb');

  // Drag the slider the whole way: the readout under it goes from the minimum
  // raise to the entire stack, several digits wider. Nothing may move.
  const max = await page.locator('#raiseSlider').getAttribute('max');
  await page.locator('#raiseSlider').fill(max);
  await expect(page.locator('#raiseNeedPay')).toContainText(`to ${max}`);
  expect((await panelBox()).width).toBeCloseTo(panelBefore.width, 0);
  expect((await panelBox()).x).toBeCloseTo(panelBefore.x, 0);
  expect((await raiseBox()).x).toBeCloseTo(raiseBefore.x, 0);

  // Call to the flop. The opponent is sitting out, so it checks behind.
  await page.click('#btnCall');
  await expect(page.locator('#communityCards .card')).toHaveCount(3, { timeout: 20000 });
  await expect(page.locator('#actionsPanel')).not.toHaveClass(/hidden/, { timeout: 20000 });

  // Postflop the pot is the unit, so the same four slots price fractions of
  // it - and the panel is the same box it was preflop.
  await expect(page.locator('#presetGroup')).toContainText('33%');
  await expect(page.locator('#presetGroup')).toContainText('50%');
  await expect(page.locator('#presetGroup')).toContainText('75%');
  const potTo = Number(
    await page.locator('#presetGroup .preset-btn').last().getAttribute('data-to')
  );
  const halfTo = Number(
    await page.locator('#presetGroup .preset-btn').nth(1).getAttribute('data-to')
  );
  expect(potTo).toBeGreaterThan(halfTo);
  expect((await panelBox()).width).toBeCloseTo(panelBefore.width, 0);

  expect(pageErrors).toEqual([]);
});

test.describe('landscape phone', () => {
  // The shape a phone is actually held in to play poker, and the one breakpoint
  // where vertical room is genuinely scarce.
  test.use({ viewport: { width: 844, height: 390 } });

  test('the sizing presets are on the bar here too, and take felt rather than seat', async ({
    page,
  }) => {
    const pageErrors = await seatAtTournamentTable(page, 'Land');
    await deal(page);

    await expect(page.locator('.action-presets')).toBeVisible();
    await expect(page.locator('#presetGroup .preset-btn')).toHaveCount(4);

    const panel = await page.locator('#actionsPanel').boundingBox();
    const board = await page.locator('#communityCards').boundingBox();
    const row = await page.locator('.action-row').boundingBox();
    const view = page.viewportSize();

    // The row they cost grows upward into the empty felt between the board and
    // the viewer's seat. The action row keeps the bottom of the panel, so the
    // bar covers no more of the viewer's own plate than it did without them.
    expect(panel.y).toBeGreaterThan(board.y + board.height);
    expect(row.y + row.height).toBeLessThanOrEqual(view.height);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(view.width + 1);

    // Small, but still something a thumb can find.
    for (const pill of await page.locator('#presetGroup .preset-btn').all()) {
      const b = await pill.boundingBox();
      expect(b.height).toBeGreaterThanOrEqual(18);
      expect(b.width).toBeGreaterThanOrEqual(36);
    }

    expect(pageErrors).toEqual([]);
  });
});

// The action bar is a fixed box full of controls whose labels change every
// turn. Overlap is the failure it actually has, so it is checked as overlap -
// pairwise, at the sizes people hold - rather than by asserting widths that
// would pass while two controls sat on top of each other.
for (const vp of [
  { name: 'a desktop window', width: 1440, height: 900 },
  { name: 'an iPad in landscape', width: 1180, height: 700 },
  { name: 'a small laptop', width: 1024, height: 640 },
]) {
  test.describe(`action bar on ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('no two of its controls overlap, and it stays one row', async ({ page }) => {
      const pageErrors = await seatAtTournamentTable(page, 'Fit');
      await deal(page);

      const controls = await page.evaluate(() => {
        const ids = [
          'barStack',
          'handStrength',
          'presetGroup',
          'btnFold',
          'btnCheck',
          'btnCall',
          'raiseSlider',
          'raiseInput',
          'raiseNeedPay',
          'btnRaise',
          'btnAllIn',
          'btnRequestTime',
        ];
        return ids
          .map((id) => {
            const el = document.getElementById(id);
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0
              ? { id, x: b.x, y: b.y, right: b.right, bottom: b.bottom }
              : null;
          })
          .filter(Boolean);
      });

      // Every one of them is on screen at once, or the check below proves
      // nothing: two hidden boxes never collide.
      expect(controls.length).toBeGreaterThanOrEqual(9);

      const collisions = [];
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i];
          const b = controls[j];
          const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
          if (ox > 1 && oy > 1) {
            collisions.push(`${a.id} over ${b.id} by ${Math.round(ox)}x${Math.round(oy)}`);
          }
        }
      }
      expect(collisions).toEqual([]);

      // One row of buttons, not two: the panel is anchored at the bottom, so a
      // wrap grows it upward over the felt and the viewer's own cards.
      const rowIds = ['btnFold', 'btnRaise', 'btnAllIn'];
      const tops = controls.filter((c) => rowIds.includes(c.id)).map((c) => Math.round(c.y));
      expect(new Set(tops).size).toBe(1);

      // The bar covers the viewer's plate on a short screen, so it carries the
      // stack itself - that is the one thing on the plate you cannot act
      // without.
      await expect(page.locator('#barStack')).toBeVisible();
      await expect(page.locator('#barStack')).not.toHaveText('');

      expect(pageErrors).toEqual([]);
    });
  });
}

// ── The seat template ────────────────────────────────────────────────────
//
// Eight fixed chairs, two across the top, two a side, two along the bottom,
// with the top and bottom centre lanes deliberately empty. What that buys is
// checked here as geometry: every collision this table has had came from a
// plate landing on something, and a rule about widths passes happily while two
// things sit on top of each other.
const SEAT_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'iPad landscape', width: 1180, height: 700 },
  { name: 'iPad portrait', width: 834, height: 1000 },
  { name: 'small laptop', width: 1024, height: 640 },
  { name: 'phone landscape', width: 844, height: 390 },
  { name: 'phone portrait', width: 390, height: 844 },
];

// The e2e harness only ever seats two, and a two-handed table proves nothing
// about eight chairs. Paint a full one straight into the renderer.
async function paintFullTable(page, count = 8) {
  await page.evaluate((n) => {
    const me = gameState.players.find((p) => p.id === myId) || gameState.players[0];
    const made = [];
    for (let i = 0; i < n; i++) {
      made.push({
        ...me,
        id: i === 0 ? me.id : `synthetic-${i}`,
        uid: i === 0 ? me.uid : `u-synthetic-${i}`,
        name: i === 0 ? me.name : `Player${i}`,
        seatIndex: i,
        chips: 5000 - i * 100,
        bet: 20,
        totalBet: 20,
        folded: false,
        allIn: false,
        holeCards: i === 0 ? me.holeCards : null,
      });
    }
    gameState.players = made;
    gameState.maxPlayers = 8;
    gameState.isRunning = true;
    _builtIdentityKey = '';
    renderPlayersIncremental();
  }, count);
}

// Everything a plate is not allowed to touch, measured rather than assumed.
async function seatCollisions(page) {
  return page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const hit = (a, b) =>
      Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
    const stage = r(document.querySelector('.table-stage'));
    const plates = [...document.querySelectorAll('#playerSeats .player-seat')].map((el) => ({
      slot: el.dataset.slot,
      box: r(el.querySelector('.player-info')),
    }));
    const out = { offStage: [], plateOnPlate: [], overActionBar: [], overBanner: [] };
    for (const p of plates) {
      if (
        p.box.x < stage.x - 1 ||
        p.box.right > stage.right + 1 ||
        p.box.y < stage.y - 1 ||
        p.box.bottom > stage.bottom + 1
      ) {
        out.offStage.push(`slot ${p.slot}`);
      }
    }
    for (let i = 0; i < plates.length; i++) {
      for (let j = i + 1; j < plates.length; j++) {
        if (hit(plates[i].box, plates[j].box)) {
          out.plateOnPlate.push(`slot ${plates[i].slot} on slot ${plates[j].slot}`);
        }
      }
    }
    const bar = document.querySelector('#actionsPanel');
    if (bar && !bar.classList.contains('hidden')) {
      out.overActionBar = plates.filter((p) => hit(p.box, r(bar))).map((p) => `slot ${p.slot}`);
    }
    const banner = document.querySelector('.tournament-banner');
    if (banner && !banner.classList.contains('hidden')) {
      out.overBanner = plates.filter((p) => hit(p.box, r(banner))).map((p) => `slot ${p.slot}`);
    }
    return out;
  });
}

for (const vp of SEAT_VIEWPORTS) {
  test.describe(`eight seats on ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('every plate is on the stage, clear of its neighbours and of the furniture', async ({
      page,
    }) => {
      const pageErrors = await seatAtTournamentTable(page, 'Geo');
      await deal(page);
      await paintFullTable(page, 8);

      await expect(page.locator('#playerSeats .player-seat')).toHaveCount(8);
      expect(await seatCollisions(page)).toEqual({
        offStage: [],
        plateOnPlate: [],
        overActionBar: [],
        overBanner: [],
      });
      expect(pageErrors).toEqual([]);
    });
  });
}

test('an eight-max table lays out eight chairs and fills the empty ones in', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Chairs');
  await deal(page);

  // Two players at an eight-max table: two plates and six empty chairs, rather
  // than a ring redrawn to fit whoever happens to be sitting down.
  await expect(page.locator('#playerSeats .player-seat')).toHaveCount(8);
  await expect(page.locator('#playerSeats .player-seat:not(.seat-empty)')).toHaveCount(2);
  await expect(page.locator('#playerSeats .seat-empty')).toHaveCount(6);

  // Every chair knows which chair it is, empty ones included - that is what a
  // right-click has to name.
  const slots = await page
    .locator('#playerSeats .player-seat')
    .evaluateAll((els) => els.map((el) => el.dataset.slot).sort((a, b) => a - b));
  expect(slots).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);

  expect(pageErrors).toEqual([]);
});

test('right-clicking a chair turns the table so you are sitting in it', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Turner');
  await deal(page);

  const mySlot = () =>
    page.locator('#playerSeats .player-seat:not(.seat-empty)').first().getAttribute('data-slot');
  expect(await mySlot()).toBe('0');

  await page.locator('#playerSeats .player-seat[data-slot="3"]').click({ button: 'right' });
  await expect(page.locator('#seatMenu')).toBeVisible();
  await page.click('#seatMenuHere');
  await expect(page.locator('#seatMenu')).toBeHidden();
  expect(await mySlot()).toBe('3');

  // Remembered on the device, so it is the same chair next time.
  expect(await page.evaluate(() => localStorage.getItem('finaltable_my_slot'))).toBe('3');

  // The submenu offers every chair this table has, named for where it sits,
  // so you can send yourself somewhere other than the chair under the pointer.
  await page.locator('#playerSeats .player-seat[data-slot="3"]').click({ button: 'right' });
  await page.click('#seatMenuPick');
  await expect(page.locator('#seatMenuList')).toBeVisible();
  const chairs = await page.locator('#seatMenuList .seat-menu-chair').allTextContents();
  expect(chairs).toHaveLength(8);
  expect(chairs[0]).toContain('bottom right');
  expect(chairs[5]).toContain('top right');
  // The one you are in says so.
  await expect(page.locator('#seatMenuList .seat-menu-chair.is-current')).toHaveText(/here now/);
  await page.locator('#seatMenuList .seat-menu-chair[data-slot="6"]').click();
  expect(await mySlot()).toBe('6');

  // And it can be given back.
  await page.locator('#playerSeats .player-seat[data-slot="3"]').click({ button: 'right' });
  await expect(page.locator('#seatMenuReset')).toBeVisible();
  await page.click('#seatMenuReset');
  expect(await mySlot()).toBe('0');

  expect(pageErrors).toEqual([]);
});

test('a parked audio context is woken by the next gesture, not lost for the session', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await seatAtTournamentTable(page, 'Sound');
  await deal(page);

  // A gesture starts it, and the recordings decode.
  await page.mouse.click(5, 5);
  await expect.poll(() => page.evaluate(() => (SFX.ctx ? SFX.ctx.state : null))).toBe('running');
  await expect
    .poll(() => page.evaluate(() => Object.keys(SFX.samples).sort().join(',')))
    .toBe('card,chips,shuffle');

  // iOS parks the context whenever the tab goes to the background or the phone
  // locks. Nothing used to bring it back, and the single once:true unlock had
  // already been spent, so the table stayed silent for the rest of the session.
  await page.evaluate(() => SFX.ctx.suspend());
  expect(await page.evaluate(() => SFX.ctx.state)).toBe('suspended');

  await page.mouse.click(6, 6);
  await expect.poll(() => page.evaluate(() => SFX.ctx.state)).toBe('running');

  expect(pageErrors).toEqual([]);
});

test('the table can be muted from the menu, and stays muted after a reload', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Quiet');
  await deal(page);
  await page.mouse.click(5, 5);

  await page.click('#menuToggle');
  const mute = page.locator('#btnMute');
  await expect(mute).toHaveText('mute sound');
  await mute.click();
  expect(await page.evaluate(() => SFX.isMuted())).toBe(true);

  // Muted means nothing is scheduled, not that the context is torn down: the
  // sound has to come straight back on.
  expect(
    await page.evaluate(() => {
      const before = SFX.ctx ? SFX.ctx.state : null;
      SFX.play('check');
      return before;
    })
  ).toBe('running');
  expect(await page.evaluate(() => localStorage.getItem('finaltable_muted'))).toBe('1');

  // Actually reloaded, rather than trusting the storage key: the state is read
  // once when the sound system is defined, and reading it wrong there is the
  // way a remembered preference quietly stops being remembered.
  await page.reload();
  await expect.poll(() => page.evaluate(() => SFX.isMuted())).toBe(true);

  await page.evaluate(() => SFX.setMuted(false));
  expect(await page.evaluate(() => localStorage.getItem('finaltable_muted'))).toBeNull();
  await page.reload();
  await expect.poll(() => page.evaluate(() => SFX.isMuted())).toBe(false);

  expect(pageErrors).toEqual([]);
});
