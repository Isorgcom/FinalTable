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
  await expect(guest.locator('#playerSeats .player-seat')).toHaveCount(2);
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

  await expect(page.locator('#playerSeats .player-seat')).toHaveCount(2);

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
    seats: [...document.querySelectorAll('#playerSeats .player-seat')].map(
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
  const pageErrors = await seatAtTournamentTable(page, 'ShowTester');
  await deal(page);

  // Check or call whenever the action arrives. The opponent is sitting out, so
  // it checks its blind and checks down; a hand where the viewer is the small
  // blind reaches a showdown.
  // Bounded by the clock, not by a loop count: hands take as long as the
  // street and hand pauses make them, so a fixed number of turns either gives
  // up early or outlives the test timeout, and a timeout reports nothing.
  let reached = false;
  const deadline = Date.now() + 30000;
  while (!reached && Date.now() < deadline) {
    const st = await page.evaluate(() => ({
      phase: gameState && gameState.phase,
      lit: ((gameState && gameState.showdownWinningCards) || []).length,
      btn: ['btnCheck', 'btnCall'].find((id) => {
        const el = document.getElementById(id);
        return el && !el.disabled && el.offsetParent !== null;
      }),
    }));
    if (st.phase === 'showdown' && st.lit > 0) {
      reached = true;
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
  expect(reached).toBe(true);

  const marks = await page.evaluate(() => ({
    winning: gameState.showdownWinningCards.length,
    boardLit: document.querySelectorAll('#communityCards .card.is-winning').length,
    holeLit: document.querySelectorAll('#playerSeats .card.is-winning').length,
    dimmed: document.querySelectorAll('.card.is-dimmed').length,
    seatsLit: document.querySelectorAll('#playerSeats .player-seat.hand-winner').length,
  }));

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
