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
  // The felt's own pacing is what these tests measure, so the table is not
  // held after a pot folds round. Showing a hand has its own test, in
  // tournament.spec.js, which runs at the real five seconds.
  process.env.SHOW_WINDOW_MS = '0';
  // Every test in this file creates a tournament against one in-process
  // server, and the default cap of eight is reached part way down the file.
  // A finished test's table holds as soon as its pages close, so it deals
  // nothing either way; the short write-off is only so the run does not carry
  // fifty held games to the end of the file. A minute is the floor the server
  // allows, and no single test here runs anywhere near that long.
  process.env.MAX_TOURNAMENTS = '50';
  process.env.TOURNAMENT_ZOMBIE_HOLD_MS = '60000';
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
  // The dealer's lines land in the Log tab, and none of them in Chat.
  await expect(page.locator('#panelLogBody .log-entry')).not.toHaveCount(0);
  await expect(page.locator('#panelLogBody .log-entry[data-kind="handStart"]')).not.toHaveCount(0);
  await expect(page.locator('#panelChatBody .log-entry')).toHaveCount(0);
  // Two blinds a hand. The opponent is sitting out, so a hand it opens ends
  // at once and the viewer's turn can arrive on the second one; the count is
  // a multiple of two rather than exactly two.
  const blinds = await page.locator('#panelLogBody .log-entry[data-kind="blind"]').count();
  expect(blinds).toBeGreaterThanOrEqual(2);
  expect(blinds % 2).toBe(0);
  await expect(page.locator('#tabChat')).toHaveAttribute('aria-selected', 'true');
  await page.click('#tabLog');
  await expect(page.locator('#panelLog')).toBeVisible();
  await expect(page.locator('#panelChat')).toBeHidden();
  await page.click('#tabInfo');
  await expect(page.locator('#panelInfo')).toBeVisible();
  await expect(page.locator('#panelLog')).toBeHidden();
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

  test('the action bar is one row of thumb-sized buttons, with raise a tap away', async ({
    page,
  }) => {
    const pageErrors = await seatAtTournamentTable(page, 'ThumbTester');
    await deal(page);
    const panel = page.locator('#actionsPanel');
    await expect(panel).not.toHaveClass(/hidden/, { timeout: 20000 });
    await expect(panel).toHaveClass(/is-compact/);

    // One row of decisions. Held upright there is room for three and no more,
    // and the bar grows upward over the felt when it wraps - which is how it
    // came to be four rows deep and a third of the screen.
    const rows = await page.evaluate(() => {
      const kids = [...document.querySelector('.action-row').children].filter(
        (n) => n.offsetParent !== null
      );
      return new Set(kids.map((n) => Math.round(n.getBoundingClientRect().top))).size;
    });
    expect(rows).toBe(1);

    // Every target a thumb can find. Nothing here reached 44px before.
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('#actionsPanel button:not(.hidden)')]
        .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height < 44)
        .map((el) => el.id || el.className)
    );
    expect(small).toEqual([]);

    // The sizing is behind the raise button rather than always underfoot.
    await expect(page.locator('#raiseSlider')).toBeHidden();
    await page.click('#btnRaise');
    await expect(panel).toHaveClass(/is-sizing/);
    await expect(page.locator('#raiseSlider')).toBeVisible();
    // The confirm says what pressing it will cost.
    await expect(page.locator('#btnRaise')).toHaveText(/^raise \d/);
    // And the slider has most of the bar rather than the fifty-odd pixels that
    // used to be left over beside the number, which was some eighty chips to a
    // pixel of drag on a five thousand stack.
    const track = await page.locator('#raiseSlider').boundingBox();
    expect(track.width).toBeGreaterThan(240);

    // Back leaves the hand exactly as it was.
    await page.click('#btnRaiseBack');
    await expect(panel).not.toHaveClass(/is-sizing/);
    await expect(page.locator('#btnRaise')).toHaveText('raise');
    await expect(page.locator('#btnFold')).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

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

// The pot follows the chips to the chair that took it. The felt already pushes
// the chips across; this is the figure that was sitting in the middle a second
// earlier arriving with them.
test('the pot floats up over the chair that took it', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Payout');
  await deal(page);
  await page.mouse.click(5, 5);
  // Both seats sitting out, so hands resolve as fast as the engine can deal
  // them rather than at the pace of a 25-second clock running down. A pot is
  // still pushed to somebody every hand, which is all this is watching for.
  await page.click('#btnAutoPlay');
  await expect(page.locator('#seatBanner')).toBeVisible({ timeout: 10000 });

  // Every payout the server announces, kept as it arrives. The number floats a
  // beat after the push that carried it - it waits for the chips to cross the
  // felt - and by then the next hand has cleared the state that named the
  // winner. So what is on screen cannot be checked against the state at the
  // moment it is on screen; it has to be checked against what was sent.
  await page.evaluate(() => {
    window.__paid = [];
    socket.on('gameState', (state) => {
      const paid = (state && state.lastRoundPayouts) || [];
      for (const entry of paid) window.__paid.push(entry.playerId + ':' + entry.amount);
    });
  });

  // The opponent sits out and folds, so pots are pushed steadily. Poll until a
  // number on screen matches a payout this spy actually saw: a float already
  // in flight when the spy was installed answers "unmatched" and the next hand
  // comes round, rather than failing for having been early.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const node = document.querySelector('#playerSeats .seat-payout.is-live');
          if (!node) return 'nothing floating';
          const seat = node.closest('.player-seat');
          const key = (seat && seat.dataset.playerId) + ':' + node.textContent.replace('+', '');
          window.__payoutNode = node;
          window.__shown = node.textContent;
          return window.__paid.includes(key) ? 'matched' : 'unmatched ' + key;
        }),
      { timeout: 60000, intervals: [150] }
    )
    .toBe('matched');

  const shown = await page.evaluate(() => ({
    text: window.__shown,
    floaters: document.querySelectorAll('#playerSeats .seat-payout').length,
    seated: document.querySelectorAll('#playerSeats .player-seat[data-player-id]').length,
  }));

  // Plain digits, the way every other number on the felt is written.
  expect(shown.text).toMatch(/^\+\d+$/);
  // One per occupied chair and no more: the element is part of the seat rather
  // than something appended each time a pot is won, which is what stops a long
  // session accumulating ghosts.
  expect(shown.floaters).toBe(shown.seated);

  // And it goes. Either the animation ends or the seats are rebuilt under it
  // by the next hand, and both of those count as gone.
  await page.waitForFunction(
    () => {
      const node = window.__payoutNode;
      return !!node && (!node.isConnected || !node.classList.contains('is-live'));
    },
    null,
    { timeout: 10000 }
  );

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
    cards: [
      ...document.querySelectorAll(
        '#playerSeats .player-hole-cards > .card, #playerSeats .player-hole-cards > .card-back'
      ),
    ].map((el) => ({
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

  // Sit back in before the checks below. While the seat is sitting out the
  // table deals a fresh hand every second or two, and a deal now takes longer
  // than that gap - so "nothing is mid-deal" is never true for long enough to
  // observe. Sitting in holds the next hand on the viewer's clock instead.
  await page.click('#btnSitIn');

  // Nothing left hidden or frozen. deal-pending is visibility:hidden, so a
  // stuck one would hide that player's cards for the whole hand, and the
  // animation fills both ways, so a stuck class would freeze the transform.
  await expect(page.locator('.deal-pending')).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator('#playerSeats .dealing')).toHaveCount(0, { timeout: 8000 });
  const stuck = await page.$$eval(
    '#playerSeats .player-hole-cards > .card, #playerSeats .player-hole-cards > .card-back',
    (els) =>
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
      // Only the chips. The felt plays cards and checks through the same call,
      // and counting all of them makes this a test of how many sounds a hand
      // happens to contain.
      if (ok && args[0] === 'chips') window.__played++;
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
              // How many hands won it, which is what says whether five lit
              // cards is the right number.
              winners: ((gameState && gameState.lastRoundWinnerIds) || []).length,
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

  // Five is the invariant while one hand wins, and only then. What is lit is
  // the union of the winning hands, so a split whose fifth card is a hole card
  // of the same rank in different suits lights six - see the engine test "a
  // split on the same kicker in different suits lights both". Asserting a flat
  // five here made this test fail about one run in ten for years.
  if (marks.winners === 1) {
    expect(marks.winning).toBe(5);
  } else {
    expect(marks.winning).toBeGreaterThanOrEqual(5);
  }
  // The part that holds however many won: every lit card is on the board or in
  // somebody's hand, which is what catches the union being built wrong or the
  // board key missing the winners.
  expect(marks.boardLit + marks.holeLit).toBe(marks.winning);
  expect(marks.boardLit).toBeGreaterThan(0);
  expect(marks.dimmed).toBeGreaterThan(0);
  expect(marks.seatsLit).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('fold is switched off while checking is free, and nothing is asked', async ({ page }) => {
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

  // Folding here would give the hand up for nothing, so the button is off.
  // It used to ask afterwards whether that was really meant; a question on a
  // clock was the worse interruption.
  const fold = page.locator('#btnFold');
  await expect(fold).toBeDisabled();
  await expect(fold).toHaveAttribute('title', 'Checking is free here');

  // Pressing it anyway does nothing at all: no fold, and no dialog in its
  // place. Forced, because a disabled button takes no ordinary click.
  await fold.dispatchEvent('click');
  await page.waitForTimeout(400);
  await expect(page.locator('#appDialogModal')).toBeHidden();
  expect(
    await page.evaluate(() => {
      const me = gameState.players.find((p) => p.id === myId);
      return me.folded;
    })
  ).toBe(false);

  // And checking is still there to be done, which is the whole argument.
  await expect(page.locator('#btnCheck')).toBeVisible();

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
    window.mttField = { onBubble: true, handForHand: true, remaining: 21, paidPlaces: 20 };
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

  // Down to one table there is nobody to hold a hand for, so the bubble is
  // still announced and the phrase that describes waiting on other tables is
  // not.
  await page.evaluate(() => {
    window.mttField = { onBubble: true, handForHand: false, remaining: 21, paidPlaces: 20 };
    updateBlindClock();
  });
  await expect(badge).toContainText(/bubble/i);
  await expect(badge).not.toContainText(/hand for hand/i);
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
      // Worst case on purpose. A plate is only as wide as what it carries, and
      // the widest it gets is a full-length name with the badges and the status
      // line a disconnected seat shows - which is exactly the state a table is
      // in for the seconds after somebody refreshes. Sizing the felt against
      // narrow plates is how a plate ends up hanging off the screen.
      made.push({
        ...me,
        id: i === 0 ? me.id : `synthetic-${i}`,
        uid: i === 0 ? me.uid : `u-synthetic-${i}`,
        name: 'Wenceslas' + i,
        seatIndex: i,
        chips: 5000 - i * 100,
        bet: 20,
        totalBet: 20,
        folded: false,
        allIn: false,
        // Half dropped (a status line, no badge), half sitting out while still
        // connected (a badge, no status). Between them they cover the widest
        // and the tallest a plate gets.
        autoPlay: true,
        isConnected: i % 2 === 0,
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
    .toBe('card,check,chips,shuffle');

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

  // Every way in, not just the one that is easiest to reach from a test. The
  // action sounds go through play(); the chips, the deck and the cards do not,
  // and gating only play() leaves a table that still rattles while muted.
  const count = () =>
    page.evaluate(() => {
      let made = 0;
      const ctx = SFX.ctx;
      const osc = ctx.createOscillator.bind(ctx);
      const buf = ctx.createBufferSource.bind(ctx);
      ctx.createOscillator = () => {
        made++;
        return osc();
      };
      ctx.createBufferSource = () => {
        made++;
        return buf();
      };
      for (const t of ['turn', 'check', 'fold', 'allin', 'win']) SFX.play(t);
      SFX.chipsMoved();
      SFX.deckShuffled();
      SFX.cardsPlaced([0, 0.1]);
      SFX.playSample('card', 0.3);
      ctx.createOscillator = osc;
      ctx.createBufferSource = buf;
      return made;
    });

  expect(await count()).toBe(0);
  // Muted gates the sound, it does not tear the context down, so unmuting is
  // immediate and needs no further gesture.
  expect(await page.evaluate(() => SFX.ctx.state)).toBe('running');
  expect(await page.evaluate(() => localStorage.getItem('finaltable_muted'))).toBe('1');

  // Actually reloaded, rather than trusting the storage key: the state is read
  // once when the sound system is defined, and reading it wrong there is the
  // way a remembered preference quietly stops being remembered.
  await page.reload();
  await expect.poll(() => page.evaluate(() => SFX.isMuted())).toBe(true);

  await page.evaluate(() => SFX.setMuted(false));
  expect(await page.evaluate(() => localStorage.getItem('finaltable_muted'))).toBeNull();
  // And with the sound back on, the same sweep does reach the audio hardware.
  expect(await count()).toBeGreaterThan(0);
  await page.reload();
  await expect.poll(() => page.evaluate(() => SFX.isMuted())).toBe(false);

  expect(pageErrors).toEqual([]);
});

// The same switch, in the corner of the felt, where it can be reached without
// opening anything. The drawing is the state: waves while there is sound, a
// cross when there is not.
test('the speaker in the corner mutes the table, and the menu agrees', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Speaker');
  await deal(page);
  await page.mouse.click(5, 5);

  const speaker = page.locator('#btnFeltMute');
  const drawn = () =>
    page.evaluate(() => ({
      pressed: document.getElementById('btnFeltMute').getAttribute('aria-pressed'),
      waves: getComputedStyle(document.querySelector('#btnFeltMute .sound-waves')).display,
      cross: getComputedStyle(document.querySelector('#btnFeltMute .sound-cross')).display,
    }));

  // There without opening a thing, and drawn with its waves.
  await expect(speaker).toBeVisible();
  expect(await drawn()).toEqual({ pressed: 'false', waves: 'inline', cross: 'none' });
  await expect(speaker).toHaveAttribute('aria-label', 'Mute the table');

  await speaker.click();
  expect(await page.evaluate(() => SFX.isMuted())).toBe(true);
  expect(await drawn()).toEqual({ pressed: 'true', waves: 'none', cross: 'inline' });
  await expect(speaker).toHaveAttribute('aria-label', 'Unmute the table');

  // And the menu item followed it. The hook that repaints a control when the
  // setting moves is one slot, not a list, so two controls have to be painted
  // by one function or exactly this drifts apart.
  await page.click('#menuToggle');
  await expect(page.locator('#btnMute')).toHaveText('unmute sound');
  await page.mouse.click(5, 5);

  await speaker.click();
  expect(await page.evaluate(() => SFX.isMuted())).toBe(false);
  expect(await drawn()).toEqual({ pressed: 'false', waves: 'inline', cross: 'none' });
  await page.click('#menuToggle');
  await expect(page.locator('#btnMute')).toHaveText('mute sound');
  await page.mouse.click(5, 5);

  // The two felt controls sit in the top corners, and the corners are not
  // empty: the top bar is above both of them, and the dealer's last line shares
  // the right one whenever the panel is out of the way. Nothing else in the
  // suite looks at either corner, so this does, at the widths that move them.
  const clear = async () => {
    const boxes = await page.evaluate(() => {
      const r = (sel) => {
        const el = document.querySelector(sel);
        if (!el || getComputedStyle(el).display === 'none') return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, right: b.right, bottom: b.bottom, left: b.left };
      };
      return {
        speaker: r('#btnFeltMute'),
        door: r('#btnToLobby'),
        ticker: r('#logLast'),
        bar: r('.top-bar'),
        banner: r('#tournamentBanner'),
      };
    });
    const hits = (a, b) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (const mine of ['speaker', 'door']) {
      expect(boxes[mine]).not.toBeNull();
      for (const other of ['ticker', 'bar', 'banner', 'speaker', 'door']) {
        if (other === mine || !boxes[other]) continue;
        const verdict = hits(boxes[mine], boxes[other]) ? 'overlaps' : 'clear';
        expect(`${mine} vs ${other}: ${verdict}`).toBe(`${mine} vs ${other}: clear`);
      }
    }
  };

  await page.click('#btnPanelToggle');
  await expect
    .poll(() => page.evaluate(() => document.body.classList.contains('rail-hidden')))
    .toBe(true);
  await clear();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(200);
  await clear();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await clear();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(200);
  await clear();

  expect(pageErrors).toEqual([]);
});

// The settings that belong to the person rather than the browser. Proved by
// wiping the browser's copies and keeping only the identity token: whatever
// comes back after that came back from the server.
test('mute, your chair and the open tab come back from the server, not the browser', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'Settled');
  await deal(page);
  await page.mouse.click(5, 5);

  // The server answers every save with what it kept, so the test can wait on
  // that rather than on a stopwatch: the client gathers changes on a short
  // beat and this is the edge that says the beat has landed.
  await page.evaluate(() => {
    window.__prefsKept = null;
    socket.on('preferences', (p) => {
      window.__prefsKept = p;
    });
  });

  // Three settings, each through the control a player would actually use.
  await page.click('#tabStats');
  await expect(page.locator('#panelStats')).toBeVisible();
  await page.click('#menuToggle');
  await page.click('#btnMute');
  expect(await page.evaluate(() => SFX.isMuted())).toBe(true);
  await page.evaluate(() => Store.set('finaltable_my_slot', '3'));

  await expect
    .poll(() => page.evaluate(() => window.__prefsKept))
    .toEqual({ muted: true, seat: 3, panelTab: 'stats' });

  // Everything the browser remembers about these, gone. The identity token
  // stays, because this is about the same person, not a stranger.
  await page.evaluate(() => {
    for (const key of ['finaltable_muted', 'finaltable_my_slot', 'finaltable_side_panel_tab']) {
      localStorage.removeItem(key);
    }
  });
  expect(await page.evaluate(() => localStorage.getItem('finaltable_muted'))).toBeNull();

  await page.reload();
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });

  // All three are back, and they can only have come from the identity.
  await expect.poll(() => page.evaluate(() => SFX.isMuted())).toBe(true);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('finaltable_my_slot')))
    .toBe('3');
  await expect(page.locator('#panelStats')).toBeVisible();
  // And the menu offers the right half of the toggle rather than a stale label.
  await page.click('#menuToggle');
  await expect(page.locator('#btnMute')).toHaveText('unmute sound');

  expect(pageErrors).toEqual([]);
});

// How the cards look is the viewer's own reading of the same cards, so it is
// three more settings that belong to the person rather than to the browser.
// The colours are the ones the stylesheets name: #b53535 and #2a2a2a for the
// classic deck, and #1f5fa8 and #1c6b43 for the two suits a four-colour deck
// moves - the diamond and the club, never the heart or the spade.
const BLACK = 'rgb(42, 42, 42)';
const RED = 'rgb(181, 53, 53)';
const DECK_COLOURS = {
  two: { spades: BLACK, clubs: BLACK, hearts: RED, diamonds: RED },
  four: { spades: BLACK, clubs: 'rgb(12, 122, 30)', hearts: RED, diamonds: 'rgb(11, 78, 168)' },
};

// The large face grew the rank, the suit under it and both corner indices by
// one number, and on a 84px card there is not room for all four: the heart
// ended up sitting on the index below it, which is how it was reported. The
// fix is that only the rank grows, and it is lifted as it does. This measures
// the ink rather than the boxes, because the boxes overlap at both settings
// and always have - the rank's box and the suit's box share about 3px - and it
// is whether the glyphs inside them meet that decides how the card looks.
//
// The glyphs measured are 10 and a heart whatever is actually dealt: the
// widest rank and the fullest-inked suit, which is the pair that has to fit.
test('the large face leaves the suit and the indices room', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Roomy');
  await deal(page);
  await page.mouse.click(5, 5);

  const gaps = () =>
    page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d');
      // Where a glyph's ink actually falls, from the element's own box and the
      // font it is drawn in.
      const ink = (el, text) => {
        const cs = getComputedStyle(el);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const m = ctx.measureText(text);
        const box = el.getBoundingClientRect();
        const fontPx = parseFloat(cs.fontSize);
        const lineH = cs.lineHeight === 'normal' ? fontPx * 1.2 : parseFloat(cs.lineHeight);
        const half = (lineH - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2;
        const baseline = box.top + half + m.fontBoundingBoxAscent;
        const originX = box.left + (box.width - m.width) / 2;
        return {
          left: originX - m.actualBoundingBoxLeft,
          right: originX + m.actualBoundingBoxRight,
          top: baseline - m.actualBoundingBoxAscent,
          bottom: baseline + m.actualBoundingBoxDescent,
        };
      };
      const card = document.querySelector('#playerSeats .player-seat.is-me .card');
      if (!card) return null;
      const rank = ink(card.querySelector('.card-rank'), '10');
      const suit = ink(card.querySelector('.card-suit'), '\u2665');
      // The corner indices hold whatever was dealt, so their boxes are as wide
      // as that card's rank happens to be - an A is narrow and a 10 is not.
      // Measured against the edge they are anchored to and the width a 10
      // would take, so this asks the same question whatever turns up.
      const widest = (el) => {
        const cs = getComputedStyle(el);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return ctx.measureText('10').width;
      };
      const tlEl = card.querySelector('.card-corner');
      const brEl = card.querySelector('.card-corner-br');
      const tl = { right: tlEl.getBoundingClientRect().left + widest(tlEl) };
      const br = { left: brEl.getBoundingClientRect().right - widest(brEl) };
      const round = (n) => Math.round(n * 10) / 10;
      return {
        // The heart, against the index in the corner below it.
        suitToIndex: round(br.left - suit.right),
        // The rank, against the heart beneath it.
        rankToSuit: round(suit.top - rank.bottom),
        // And the rank against the index above it, which is what stops the
        // rank simply being made bigger and bigger.
        indexToRank: round(rank.left - tl.right),
        suitPx: parseFloat(getComputedStyle(card.querySelector('.card-suit')).fontSize),
      };
    });

  // A card still in flight carries the deal's transform, and measuring one
  // mid-flight reads a box that is not where the card comes to rest.
  const settled = async () => {
    await expect(page.locator('#playerSeats .card.dealing')).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('#playerSeats .card.deal-pending')).toHaveCount(0, {
      timeout: 10000,
    });
  };

  const setFace = async (face) => {
    await page.evaluate((f) => CardLook.set('cardFace', f), face);
    await expect(page.locator('body')).toHaveAttribute('data-face', face);
    await settled();
    return gaps();
  };

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await page.waitForTimeout(250);
    await settled();

    const standard = await setFace('standard');
    const large = await setFace('large');
    expect(standard).not.toBeNull();

    for (const [face, m] of [
      ['standard', standard],
      ['large', large],
    ]) {
      const where = `${face} at ${width}px`;
      expect(`${where} suit/index ${m.suitToIndex > 0 ? 'clear' : 'tight'}`).toBe(
        `${where} suit/index clear`
      );
      expect(`${where} rank/suit ${m.rankToSuit > 0 ? 'clear' : 'tight'}`).toBe(
        `${where} rank/suit clear`
      );
      expect(`${where} index/rank ${m.indexToRank > 0 ? 'clear' : 'tight'}`).toBe(
        `${where} index/rank clear`
      );
    }

    // The pip is the one that does not grow - that is where the room comes
    // from, and it is the whole of the fix.
    expect(large.suitPx).toBe(standard.suitPx);
    // And the rank, which does grow, ends up further from the suit than it
    // ever was at the ordinary size rather than nearer to it.
    expect(large.rankToSuit).toBeGreaterThan(standard.rankToSuit);
  }

  expect(pageErrors).toEqual([]);
});

test('the back, the four-colour deck and the large face are chosen and then kept', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'Picky');
  await deal(page);
  await page.mouse.click(5, 5);

  await page.evaluate(() => {
    window.__prefsKept = null;
    socket.on('preferences', (p) => {
      window.__prefsKept = p;
    });
  });

  // What the felt is drawing: the attributes the stylesheets read, the back of
  // a card that is face down, and the size of a rank that is face up.
  const look = () =>
    page.evaluate(() => {
      const back = document.querySelector('#playerSeats .card-back');
      const rank = document.querySelector('#gameScreen .card .card-rank');
      return {
        chosen: { ...document.body.dataset },
        backGround: back ? getComputedStyle(back).backgroundImage : null,
        rankPx: rank ? parseFloat(getComputedStyle(rank).fontSize) : null,
      };
    });

  // Every card face up on the felt, and the colour its rank is actually being
  // drawn in. Which suits are dealt is the deck's business, so this asserts
  // all of them against the table rather than waiting for a particular one.
  const felt = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('#gameScreen .card')).flatMap((card) => {
        const rank = card.querySelector('.card-rank');
        const suit = Array.from(card.classList).find((name) => name.startsWith('suit-'));
        return rank && suit ? [{ suit: suit.slice(5), colour: getComputedStyle(rank).color }] : [];
      })
    );

  const drawnAs = async (deck) => {
    const cards = await felt();
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card.colour).toBe(DECK_COLOURS[deck][card.suit]);
  };

  const before = await look();
  expect(before.chosen).toEqual({ back: 'green', deck: 'two', face: 'standard' });
  expect(before.rankPx).toBeGreaterThan(0);
  await drawnAs('two');

  await page.click('#menuToggle');
  await page.click('#btnCards');
  await expect(page.locator('#cardsModal')).toBeVisible();

  // The dialog shows both decks at once, which is the one place all four suits
  // are on screen together: this is where the club going green and the diamond
  // going blue is pinned down, whatever the felt happens to have dealt.
  //
  // It is also the case that is easy to get wrong. Each option has to be drawn
  // the way it would look, inside a table currently set to the other one, in
  // both directions - so this is asserted again after the choice is made.
  const previewsAreThemselves = async () => {
    for (const deck of ['two', 'four']) {
      for (const [suit, colour] of Object.entries(DECK_COLOURS[deck])) {
        const pip = page.locator(`#cardsModal [data-deck="${deck}"] .card.suit-${suit} .card-suit`);
        await expect(pip).toHaveCSS('color', colour);
      }
    }
    // And the same of the backs: the green swatch stays green in a blue table.
    const swatch = (value) =>
      page
        .locator(`#cardsModal [data-back="${value}"] .cards-swatch`)
        .evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(await swatch('green')).not.toBe(await swatch('blue'));
  };
  await previewsAreThemselves();

  await page.click('#cardsModal [data-look="cardBack"][data-value="blue"]');
  await page.click('#cardsModal [data-look="deck"][data-value="four"]');
  await page.click('#cardsModal [data-look="cardFace"][data-value="large"]');

  // The felt changed under the dialog, with no Save and no reload.
  const after = await look();
  expect(after.chosen).toEqual({ back: 'blue', deck: 'four', face: 'large' });
  expect(after.backGround).not.toBe(before.backGround);
  expect(after.rankPx).toBeCloseTo(before.rankPx * 1.2, 1);
  await drawnAs('four');

  // And the dialog says which one is chosen, for a screen reader as well as
  // for an eye.
  const option = (value) =>
    page.locator(`#cardsModal [data-look="cardBack"][data-value="${value}"]`);
  await expect(option('blue')).toHaveAttribute('aria-checked', 'true');
  await expect(option('green')).toHaveAttribute('aria-checked', 'false');
  await previewsAreThemselves();

  await page.click('#btnCloseCards');
  await expect(page.locator('#cardsModal')).toBeHidden();

  await expect
    .poll(() => page.evaluate(() => window.__prefsKept))
    .toMatchObject({ cardBack: 'blue', deck: 'four', cardFace: 'large' });

  // Everything this browser remembers about the cards, gone. The identity
  // token stays: whatever comes back came back from the server.
  await page.evaluate(() => {
    for (const key of ['finaltable_card_back', 'finaltable_deck', 'finaltable_card_face']) {
      localStorage.removeItem(key);
    }
  });
  await page.reload();
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect
    .poll(() => page.evaluate(() => ({ ...document.body.dataset })))
    .toMatchObject({ back: 'blue', deck: 'four', face: 'large' });

  expect(pageErrors).toEqual([]);
});

test('learning who you are after the seats are built still puts you in your chair', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'Late');
  await deal(page);

  const me = await page.evaluate(() => ({
    id: myId,
    index: gameState.players.findIndex((p) => p.id === myId),
  }));
  const slotOf = () =>
    page.evaluate((id) => {
      const el = document.querySelector(`#playerSeats .player-seat[data-player-id="${id}"]`);
      return el ? el.dataset.slot : null;
    }, me.id);

  expect(await slotOf()).toBe('0');

  // Both halves in one turn of the event loop. The table is live, so a real
  // push landing between them would rebuild the seats for its own reasons and
  // repair the very thing under test.
  const seen = await page.evaluate((id) => {
    const at = () => {
      const el = document.querySelector(`#playerSeats .player-seat[data-player-id="${id}"]`);
      return el ? el.dataset.slot : null;
    };
    // What a refresh in the middle of a hand does: a game state lands before
    // tournamentJoined has said who we are, so the seats are built for a
    // viewer the table does not contain and nobody is rotated to the front.
    myId = 'not-yet-known';
    _builtIdentityKey = '';
    renderPlayersIncremental();
    const unrotated = at();
    // Then we learn who we are. No player's state changed, so nothing in the
    // identity key moves - only the viewer. The seats have to be built again
    // anyway, or the plates stay put while the felt bets, redrawn on every
    // push, are already going to the right chairs.
    myId = id;
    renderPlayersIncremental();
    return { unrotated, afterLearning: at() };
  }, me.id);

  expect(seen.unrotated).toBe(String(me.index));
  expect(seen.afterLearning).toBe('0');

  expect(pageErrors).toEqual([]);
});

test('the buttons answer a press, and the presets show which sizing is loaded', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'Press');
  await deal(page);

  // Pressing says so straight away - fold and check take the bar with them on
  // the same frame, so the flash starts on pointerdown rather than on click.
  const fold = page.locator('#btnFold');
  await fold.dispatchEvent('pointerdown');
  await expect(fold).toHaveClass(/is-pressed/);

  // The preset the slider is holding is lit, and only that one.
  const presets = page.locator('#presetGroup .preset-btn:enabled');
  const chosen = presets.first();
  await chosen.click();
  await expect(chosen).toHaveClass(/is-picked/);
  await expect(page.locator('#presetGroup .preset-btn.is-picked')).toHaveCount(1);
  expect(await page.evaluate(() => document.getElementById('raiseInput').value)).toBe(
    await chosen.getAttribute('data-to')
  );

  // Drag away and the light goes out: it tracks the amount, not the last click.
  const max = await page.locator('#raiseSlider').getAttribute('max');
  await page.locator('#raiseSlider').fill(max);
  await expect(page.locator('#presetGroup .preset-btn.is-picked')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

// The server arms the turn clock the moment the hand starts, which on a full
// table is a second and a half before the cards have finished flying. The ring
// used to count down over an empty felt.
test('the turn clock waits for the cards to land before it is drawn', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto(baseUrl);
  // Watching from before the table exists, because the thing being measured
  // happens in the first two seconds of it.
  await page.evaluate(() => {
    window.__seen = { armedAt: null, ringAt: null, dealingWhenRingShown: null };
    const tick = () => {
      const gs = typeof gameState === 'undefined' ? null : gameState;
      if (gs && gs.isRunning) {
        if (window.__seen.armedAt === null && gs.turnExpiresAt) {
          window.__seen.armedAt = performance.now();
        }
        const ring = document.querySelector('#playerSeats .hole-clock:not(.hidden)');
        if (window.__seen.ringAt === null && ring) {
          window.__seen.ringAt = performance.now();
          window.__seen.dealingWhenRingShown = document.querySelectorAll(
            '.player-hole-cards .card.dealing'
          ).length;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.fill('#playerName', 'Patience');
  await page.locator('#playerName').blur();
  await page.click('#btnCreateTournament');
  await page.fill('#tName', 'Patience table');
  await page.check('#tBots');
  await page.selectOption('#tBotCount', '5');
  await page.click('#tStartQuick button[data-min="15"]');
  await page.click('#btnCreateSubmit');
  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 15000 });
  await expect(page.locator('#playerSeats .hole-clock:not(.hidden)')).toHaveCount(1, {
    timeout: 15000,
  });

  const seen = await page.evaluate(() => window.__seen);
  // The clock was armed first, as it always was, and the ring waited.
  expect(seen.armedAt).not.toBeNull();
  expect(seen.ringAt).not.toBeNull();
  expect(seen.ringAt - seen.armedAt).toBeGreaterThan(700);
  // And nothing was still in the air when it appeared.
  expect(seen.dealingWhenRingShown).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('the clock is an outline round the cards that escalates and warns once', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Clock');
  await deal(page);
  await page.mouse.click(5, 5); // unlock the audio context

  // Everything in one turn of the event loop: the table is live, and a real
  // push replaces gameState wholesale and would undo the clock being posed.
  const seen = await page.evaluate(() => {
    // The ring is held until the deal that just happened has finished flying.
    // This test poses its own clock, so it poses a settled felt with it rather
    // than waiting out an animation it is not measuring.
    _dealSettledAt = 0;
    const clockFor = (id) =>
      document.querySelector(`#playerSeats .player-seat[data-player-id="${id}"] .hole-clock`);
    const shownCount = () =>
      document.querySelectorAll('#playerSeats .hole-clock:not(.hidden)').length;
    const read = (id) => {
      const c = clockFor(id);
      return {
        dash: c.querySelector('rect').style.strokeDasharray,
        offset: c.querySelector('rect').style.strokeDashoffset,
        cls: c.getAttribute('class'),
        shown: shownCount(),
      };
    };

    let nodes = 0;
    const ctx = SFX.ctx;
    const osc = ctx.createOscillator.bind(ctx);
    ctx.createOscillator = () => {
      nodes++;
      return osc();
    };

    const meIndex = gameState.players.findIndex((p) => p.id === myId);
    const otherIndex = meIndex === 0 ? 1 : 0;
    const other = gameState.players[otherIndex];
    gameState.isRunning = true;
    gameState.gameMode = 'tournament';
    gameState.turnDurationMs = 25000;
    for (const p of gameState.players) {
      p.folded = false;
      p.allIn = false;
    }

    const pose = (msLeft, index) => {
      gameState.currentPlayerIndex = index;
      gameState.turnExpiresAt = Date.now() + msLeft;
      updateTurnClocks();
    };

    gameState.currentPlayerIndex = meIndex;
    pose(20000, meIndex);
    const plenty = read(myId);
    // The box, against the things it must not sit on. An svg with a viewBox is
    // a replaced element with an intrinsic ratio, so sizing it by four insets
    // gave it its own width as a height and hung it over the plate below.
    const seat = document.querySelector(`#playerSeats .player-seat[data-player-id="${myId}"]`);
    const box = (sel) => {
      const r = seat.querySelector(sel).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, w: r.width, h: r.height };
    };
    const fit = {
      clock: box('.hole-clock'),
      row: box('.player-hole-cards'),
      plate: box('.player-info'),
    };
    pose(12000, meIndex);
    const warning = read(myId);
    const quietSoFar = nodes;
    pose(5000, meIndex);
    const urgent = read(myId);
    const afterFirstWarning = nodes;
    // Same turn, still inside the urgent band: the warning must not repeat.
    pose(3000, meIndex);
    const afterSecondTick = nodes;

    // Somebody else's clock, running out. Not our problem and not our noise.
    _warnedTurnKey = null;
    gameState.roundCount += 1;
    pose(5000, otherIndex);
    const theirs = read(other.id);
    const afterTheirClock = nodes;

    // Muted: nothing at all, on any path.
    SFX.setMuted(true);
    _warnedTurnKey = null;
    gameState.roundCount += 1;
    pose(5000, meIndex);
    const afterMuted = nodes;
    SFX.setMuted(false);

    // Time added: the clock refills to full rather than overflowing it.
    gameState.roundCount += 1;
    pose(40000, meIndex);
    const refilled = read(myId);

    ctx.createOscillator = osc;
    return {
      fit,
      plenty,
      warning,
      urgent,
      theirs,
      refilled,
      quietSoFar,
      afterFirstWarning,
      afterSecondTick,
      afterTheirClock,
      afterMuted,
    };
  });

  // One clock on the felt at a time, on the seat that is to act.
  expect(seen.plenty.shown).toBe(1);
  expect(seen.theirs.shown).toBe(1);

  // It hugs the cards and stops short of the plate.
  expect(seen.fit.clock.h).toBeLessThan(seen.fit.row.h + 14);
  expect(seen.fit.clock.w).toBeLessThan(seen.fit.row.w + 14);
  expect(seen.fit.clock.bottom).toBeLessThanOrEqual(seen.fit.plate.top);

  // The gap opens on the top edge and travels clockwise. Drawing the remaining
  // arc forward from the start instead eats the left edge first, which reads as
  // the clock not moving at all for the first several seconds.
  expect(parseFloat(seen.plenty.offset)).toBeCloseTo(parseFloat(seen.plenty.dash) - 100, 0);
  expect(parseFloat(seen.plenty.offset)).toBeLessThan(0);

  // It depletes, and it steps through the three states by seconds remaining.
  expect(parseFloat(seen.plenty.dash)).toBeGreaterThan(parseFloat(seen.warning.dash));
  expect(parseFloat(seen.warning.dash)).toBeGreaterThan(parseFloat(seen.urgent.dash));
  expect(seen.plenty.cls).not.toMatch(/is-warning|is-urgent/);
  expect(seen.warning.cls).toMatch(/is-warning/);
  expect(seen.warning.cls).not.toMatch(/is-urgent/);
  expect(seen.urgent.cls).toMatch(/is-urgent/);

  // Adding time refills it rather than sending it past full.
  expect(parseFloat(seen.refilled.dash)).toBe(100);

  // The warning: once, on our own clock, and never when muted.
  expect(seen.quietSoFar).toBe(0);
  expect(seen.afterFirstWarning).toBeGreaterThan(0);
  expect(seen.afterSecondTick).toBe(seen.afterFirstWarning);
  expect(seen.afterTheirClock).toBe(seen.afterFirstWarning);
  expect(seen.afterMuted).toBe(seen.afterFirstWarning);

  expect(pageErrors).toEqual([]);
});

test('the clock measures the turn, not the gap between two clocks', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Skew');
  await deal(page);

  // turnExpiresAt is an absolute time on the server's clock. A device several
  // seconds behind reads it as more time left than the whole turn is worth, so
  // the ratio clamps at one and the outline sits full and still until real time
  // catches up - which is what "it does not start for eight seconds" is.
  const seen = await page.evaluate(() => {
    // As above: a posed clock wants a settled felt, not the tail of the deal
    // that happened a moment ago.
    _dealSettledAt = 0;
    const me = gameState.players.findIndex((p) => p.id === myId);
    gameState.isRunning = true;
    gameState.gameMode = 'tournament';
    gameState.currentPlayerIndex = me;
    for (const p of gameState.players) {
      p.folded = false;
      p.allIn = false;
    }

    const SKEW = 8000;
    const DURATION = 25000;
    // Half the turn gone, on a clock eight seconds ahead of this device.
    updateGameState({
      ...gameState,
      serverNow: Date.now() + SKEW,
      turnDurationMs: DURATION,
      turnExpiresAt: Date.now() + SKEW + DURATION / 2,
    });
    updateTurnClocks();
    const rect = document
      .querySelector(`#playerSeats .player-seat[data-player-id="${myId}"] .hole-clock`)
      .querySelector('rect');
    return { dash: parseFloat(rect.style.strokeDasharray) };
  });

  // Half gone is half drawn. Uncorrected it reads 82%, and would sit pinned at
  // 100% for the first eight seconds of every turn.
  expect(seen.dash).toBeGreaterThan(45);
  expect(seen.dash).toBeLessThan(55);

  expect(pageErrors).toEqual([]);
});

test('the check sound is served, trimmed and levelled before it is used', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await seatAtTournamentTable(page, 'Checker');
  await deal(page);
  await page.mouse.click(5, 5); // unlock the audio context

  await expect
    .poll(() => page.evaluate(() => !!(SFX.samples && SFX.samples.check)), { timeout: 10000 })
    .toBe(true);

  const sample = await page.evaluate(() => {
    const b = SFX.samples.check;
    // Across both channels: the recording is lopsided, and normalising to the
    // loudest one is what keeps it from clipping.
    let peak = 0;
    let firstLoud = -1;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const data = b.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
        if (v > 0.02 && (firstLoud < 0 || i < firstLoud)) firstLoud = i;
      }
    }
    return { duration: b.duration, peak, startsAt: firstLoud / b.sampleRate };
  });

  // As delivered it is 187ms of sound inside 1.13s, starting 0.371s in and
  // peaking at 0.043. A check that lands a third of a second late and cannot be
  // heard is not feedback.
  expect(sample.duration).toBeLessThan(0.4);
  expect(sample.startsAt).toBeLessThan(0.02);
  expect(sample.peak).toBeGreaterThan(0.5);

  // And it is the recording that plays, not the synthesised tap it replaced.
  expect(
    await page.evaluate(() => {
      let buffers = 0;
      const ctx = SFX.ctx;
      const real = ctx.createBufferSource.bind(ctx);
      ctx.createBufferSource = () => {
        buffers++;
        return real();
      };
      SFX.play('check');
      ctx.createBufferSource = real;
      return buffers;
    })
  ).toBe(1);

  expect(pageErrors).toEqual([]);
});

// The bubble over a chair saying what that seat just did is the one thing on
// the felt that leaves on its own. Nothing re-renders a quiet table, so it
// cannot leave on a timestamp captured at the last state push: it needs the
// page's own tick to sweep it.
test('an action bubble expires on the clock, not on the next state push', async ({ page }) => {
  await page.goto(baseUrl);

  const state = await page.evaluate(async () => {
    const seat = document.createElement('div');
    seat.className = 'player-info';
    document.body.appendChild(seat);
    const make = (id, until) => {
      const el = document.createElement('div');
      el.className = 'player-action-badge';
      el.id = id;
      el.dataset.until = String(until);
      el.textContent = 'raise 90';
      seat.appendChild(el);
      return el;
    };
    const stale = make('badgeStale', Date.now() - 1);
    const fresh = make('badgeFresh', Date.now() + 60000);

    expireActionBadges();
    const fadingImmediately = stale.classList.contains('fading');
    // The fade has to finish before it is taken out of the layout.
    const hiddenDuringFade = stale.classList.contains('hidden');
    await new Promise((r) => setTimeout(r, 500));

    return {
      fadingImmediately,
      hiddenDuringFade,
      staleHidden: stale.classList.contains('hidden'),
      freshUntouched: !fresh.classList.contains('hidden') && !fresh.classList.contains('fading'),
    };
  });

  expect(state).toEqual({
    fadingImmediately: true,
    hiddenDuringFade: false,
    staleHidden: true,
    freshUntouched: true,
  });

  // And the page sweeps on its own tick, with nobody calling the sweep and no
  // state push to prompt it.
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.className = 'player-action-badge';
    el.dataset.until = String(Date.now() + 400);
    el.textContent = 'call 40';
    document.querySelector('.player-info').appendChild(el);
    window.__sweptBadge = el;
  });
  await expect
    .poll(() => page.evaluate(() => window.__sweptBadge.classList.contains('hidden')), {
      timeout: 5000,
    })
    .toBe(true);
});

test('the banner reads the ante, a break and the final level, and the Info tab lists the structure', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'LadderWatch');
  await deal(page);
  await expect(page.locator('#tournamentBanner')).toBeVisible();
  await expect(page.locator('#tbLevelLabel')).toContainText('Level 1');
  await expect(page.locator('#tbBlinds')).toHaveText('10/20');

  // Later levels take a whole night to reach, so the clock's state is set by
  // hand: this is about what the felt says, not how the clock gets there.
  await page.evaluate(() => {
    gameState.tournament = {
      ...gameState.tournament,
      isActive: true,
      levelNumber: 6,
      blinds: { sb: 75, bb: 150, ante: 150 },
      onBreak: false,
      finalLevel: false,
      timeUntilNextLevel: 100,
    };
    updateBlindClock();
  });
  await expect(page.locator('#tbLevelLabel')).toContainText('Level 6');
  await expect(page.locator('#tbBlinds')).toHaveText('75/150 · ante 150');
  await expect(page.locator('#tbNext')).toBeVisible();

  await page.evaluate(() => {
    gameState.tournament = {
      ...gameState.tournament,
      levelNumber: 6,
      blinds: { sb: 100, bb: 200, ante: 200 },
      onBreak: true,
      finalLevel: false,
      timeUntilNextLevel: 300,
    };
    updateBlindClock();
  });
  await expect(page.locator('#tbLevelLabel')).toContainText('Break');
  await expect(page.locator('#tbBlinds')).toHaveText('back at 100/200 · ante 200');
  await expect(page.locator('#tournamentBanner')).toHaveClass(/on-break/);
  // The hand in play finishes at its own pace: the felt is not cleared under it.
  await expect(page.locator('#feltBreak')).toBeHidden();
  await expect(page.locator('#tableStage')).not.toHaveClass(/on-break/);

  // The hand over, the result gets its beat before the felt is cleared, then
  // the middle of the table says break and counts it down.
  await page.evaluate(() => {
    gameState.isRunning = false;
    _breakHandEndedAt = Date.now();
    updateBlindClock();
  });
  await expect(page.locator('#feltBreak')).toBeHidden();
  await expect(page.locator('#feltBreak')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#tableStage')).toHaveClass(/on-break/);
  await expect(page.locator('#feltBreak')).toContainText('On break');
  await expect(page.locator('#feltBreakClock')).toHaveText(/^(5:00|4:5\d)$/);
  await expect(page.locator('#feltBreakNote')).toHaveText('play resumes at 100/200 · ante 200');
  await expect(page.locator('#communityCards')).toBeHidden();
  await expect(page.locator('#potDisplay')).toBeHidden();
  await page.evaluate(() => {
    gameState.isRunning = true;
    updateBlindClock();
  });
  await expect(page.locator('#feltBreak')).toBeHidden();
  await expect(page.locator('#tableStage')).not.toHaveClass(/on-break/);

  await page.evaluate(() => {
    gameState.tournament = {
      ...gameState.tournament,
      levelNumber: 18,
      blinds: { sb: 3000, bb: 6000, ante: 6000 },
      onBreak: false,
      finalLevel: true,
      timeUntilNextLevel: 0,
    };
    updateBlindClock();
  });
  await expect(page.locator('#tbLevelLabel')).toContainText('Level 18');
  await expect(page.locator('#tbNext')).toBeHidden();
  await expect(page.locator('#tournamentBanner')).not.toHaveClass(/on-break/);

  await page.click('#tabInfo');
  await expect(page.locator('#panelInfoBody')).toContainText('Structure · Standard');
  await expect(page.locator('#panelInfoBody .structure-row')).toHaveCount(20);
  expect(pageErrors).toEqual([]);
});

// A dropped connection used to start a clock on the whole tournament. It holds
// now, and the felt has to say which of the two it is: "paused" tells the one
// person left to wait for a host who may be the one who walked off.
test('a table holding for an empty room says so, and not that the host paused it', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'HoldWatch');
  await deal(page);
  await expect(page.locator('#tbLevelLabel')).toContainText('Level 1');

  // The field summary is pushed on every tick and would put the real flag back
  // between the two lines below, so the tick is stopped first. What is being
  // tested here is what the felt says, not how the field comes to say it; the
  // server's half of this is pinned in the registry and director tests.
  const entry = [...serverModule.registry.tournaments.values()].find((e) => e.status === 'running');
  expect(entry).toBeTruthy();
  clearInterval(entry.timer);
  entry.timer = null;

  // The hold stops the blind clock, so the field reports paused alongside it.
  await page.evaluate(() => {
    window.mttField = { ...(window.mttField || {}), paused: true, awayHeld: true };
    updateBlindClock();
  });
  await expect(page.locator('#tbLevelLabel')).toContainText('Holding');
  await expect(page.locator('#tbLevelLabel')).not.toContainText('Paused');
  await expect(page.locator('#tbBlinds')).toHaveText('waiting for players');
  await expect(page.locator('#tournamentBanner')).toHaveClass(/on-pause/);

  // And the middle of the table, once the last hand has had its beat.
  await page.evaluate(() => {
    gameState.isRunning = false;
    _breakHandEndedAt = Date.now() - 10000;
    paintBreakPlate();
  });
  await expect(page.locator('#feltBreak')).toBeVisible();
  await expect(page.locator('#feltBreakTitle')).toHaveText('Holding');
  await expect(page.locator('#feltBreakNote')).toContainText('your chips are safe');

  // Somebody back, and it is a table again.
  await page.evaluate(() => {
    window.mttField = { ...window.mttField, paused: false, awayHeld: false };
    gameState.isRunning = true;
    updateBlindClock();
    paintBreakPlate();
  });
  await expect(page.locator('#tbLevelLabel')).toContainText('Level 1');
  await expect(page.locator('#feltBreak')).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test('the host has controls in the Info tab: the level, a pause, and removing a player', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'Boss');
  await deal(page);
  await page.click('#tabInfo');
  const block = page.locator('#panelInfoHost');
  await expect(block).toBeVisible();
  await expect(block).toContainText('Host');
  await expect(block.locator('.wr-row')).toHaveCount(1); // the guest, not the host
  await expect(block.locator('.host-move')).toHaveCount(0); // one table: nowhere to move to

  // The guest's Info tab has no such block.
  const guest = guestContext.pages()[0];
  await guest.click('#tabInfo');
  await expect(guest.locator('#panelInfoHost')).toBeHidden();

  await block.locator('button', { hasText: 'Level ▶' }).click();
  await expect(page.locator('#tbLevelLabel')).toContainText('Level 2');
  await expect(page.locator('#tbBlinds')).toHaveText('15/30');
  await block.locator('button', { hasText: '◀ Level' }).click();
  await expect(page.locator('#tbLevelLabel')).toContainText('Level 1');

  await block.locator('button', { hasText: 'Pause' }).click();
  await expect(page.locator('#tbLevelLabel')).toContainText('Paused');
  await expect(page.locator('#tournamentBanner')).toHaveClass(/on-pause/);
  await expect(block.locator('button', { hasText: 'Resume' })).toBeVisible();
  await expect(guest.locator('#tbLevelLabel')).toContainText('Paused');

  // The hand in play finishes and no new one deals while paused, so the
  // removal that follows is immediate rather than waiting on a hand.
  await page.locator('#btnFold').click();
  await expect(page.locator('#actionsPanel')).toHaveClass(/hidden/);
  await page.waitForTimeout(1500);
  await expect(page.locator('#actionsPanel')).toHaveClass(/hidden/);

  await block.locator('.host-btn-danger:not(.host-btn-end)').click();
  await expect(page.locator('#appDialogBody')).toContainText('They cannot come back in');
  await page.click('#btnAppDialogConfirm');
  await expect(guest.locator('#lobbyHome')).toBeVisible({ timeout: 10000 });
  await expect(guest.locator('#appDialogBody')).toContainText('removed you from the game');
  expect(pageErrors).toEqual([]);
});

test('the rail link brings a watcher to the table, who can talk but not play', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'Dealer');
  await deal(page);
  const uid = await page.evaluate(() => window.__identity.uid);
  const entry = serverModule.registry.findByUid(uid);

  // The host has the link to hand out.
  await page.click('#tabInfo');
  await expect(page.locator('#panelInfoRail')).toBeVisible();
  await expect(page.locator('#panelInfoRail')).toContainText('Rail link');

  const railContext = await browserRef.newContext();
  const rail = await railContext.newPage();
  const railErrors = [];
  rail.on('pageerror', (err) => railErrors.push(err.message));
  await rail.goto(`${baseUrl}/?w=${entry.rail.toLowerCase()}`);
  await rail.fill('#playerName', 'Rail');
  await rail.locator('#playerName').blur();
  await expect(rail.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(rail.locator('#topInfo')).toContainText('Watching table 1');
  await expect(rail.locator('#actionsPanel')).toHaveClass(/hidden/);
  await expect(rail.locator('#btnAutoPlay')).toBeHidden();
  await expect(rail.locator('#playerSeats .player-seat:not(.seat-empty)')).toHaveCount(2);
  await rail.click('#tabInfo');
  await expect(rail.locator('#panelInfoWatch')).toContainText('Table 1');
  await expect(rail.locator('#panelInfoHost')).toBeHidden();
  await expect(rail.locator('#panelInfoRail')).toBeHidden();
  await expect(page.locator('#panelInfoBody')).toContainText('1 watching');

  // The rail talks, and the table sees who is talking.
  await rail.click('#tabChat');
  await rail.fill('#chatInput', 'go on then');
  await rail.click('#chatSend');
  await page.click('#tabChat');
  const line = page.locator('#panelChatBody .chat-line', { hasText: 'go on then' });
  await expect(line).toBeVisible();
  await expect(line.locator('.chat-badge')).toHaveText('rail');

  // And leaves without a fuss.
  await rail.click('#menuToggle');
  await rail.click('#btnExit');
  await expect(rail.locator('#lobbyHome')).toBeVisible();
  await page.click('#tabInfo');
  await expect(page.locator('#panelInfoBody')).not.toContainText('1 watching');
  expect(railErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  await railContext.close();
});

test('the add-on waits for the felt, then slides in beside the clock', async ({ page }) => {
  const pageErrors = await seatAtTournamentTable(page, 'AddOnee');
  await deal(page);
  const panel = page.locator('#addOnOffer');
  await expect(panel).not.toHaveClass(/show/);
  // Reaching a real break with the add-on on takes a whole structure and a
  // clock, so the field is said to be at one. Every state that reaches the
  // felt is doctored on the way in rather than the socket being silenced:
  // turning the listeners off left the server's own pushes a way back through
  // a reconnect, and one of them landing mid-wait says the offer has closed.
  await page.evaluate(() => {
    const real = TournamentField.render;
    TournamentField.render = (state) =>
      real({
        ...(state || {}),
        status: 'running',
        buyIn: 100,
        startChips: 5000,
        you: { ...((state && state.you) || {}), canAddOn: true, canReenter: false },
      });
  });

  // The clock turns over in the middle of the hand the table is still
  // finishing, which is the usual way a break arrives. Nothing lands on top
  // of that: the pot is still going to whoever won it.
  await page.evaluate(() => {
    gameState = { ...(gameState || {}), isRunning: true };
    gameState.tournament = {
      isActive: true,
      onBreak: true,
      currentLevel: 1,
      blinds: { sb: 100, bb: 200, ante: 200 },
      timeUntilNextLevel: 300,
    };
    TournamentField.render(window.mttField || {});
  });
  await page.waitForTimeout(400);
  await expect(page.locator('#tableStage')).not.toHaveClass(/on-break/);
  await expect(panel).not.toHaveClass(/show/);

  // The hand ends. The felt still holds the result for its few seconds, and
  // the question is not asked over that either.
  await page.evaluate(() => {
    // Through updateGameState, so the action bar goes the way it does when a
    // hand really ends: during a break nobody is being asked to act.
    updateGameState({ ...gameState, isRunning: false, isMyTurn: false });
    _breakHandEndedAt = Date.now();
    updateBlindClock();
  });
  await expect(panel).not.toHaveClass(/show/);

  // The felt clears, ON BREAK comes up, and only then, after a beat, the
  // question arrives - under the clock rather than over it.
  await expect(page.locator('#feltBreak')).toBeVisible({ timeout: 8000 });
  // The order is the assertion: not before the plate, and only after it. The
  // beat itself is a second and a half, but this runs alongside a suite that
  // keeps a machine busy, so the budget for it is generous on purpose.
  await expect(panel).not.toHaveClass(/show/);
  await expect(panel).toHaveClass(/show/, { timeout: 15000 });
  await expect(panel).toContainText('5,000');
  await expect(panel).toContainText('100');
  // The clock it is asking against is still readable.
  await expect(page.locator('#feltBreak')).toBeVisible();
  await expect(page.locator('#appDialogModal')).toBeHidden();

  // Saying no puts it away and does not ask again this break.
  await page.click('#btnAddOnNo');
  await expect(panel).not.toHaveClass(/show/);
  await page.evaluate(() => {
    const field = window.mttField || {};
    TournamentField.render({ ...field, you: { ...field.you, canAddOn: true } });
    updateBlindClock();
  });
  await page.waitForTimeout(2200);
  await expect(panel).not.toHaveClass(/show/);

  expect(pageErrors).toEqual([]);
});

test('the Info tab offers the way back in, and the add-on, when the server says so', async ({
  page,
}) => {
  const pageErrors = await seatAtTournamentTable(page, 'Rebuyer');
  await deal(page);
  await page.click('#tabInfo');
  await expect(page.locator('#panelInfoEntry')).toBeHidden();

  // Whether the offer stands is the server's call, made on a real bust or a
  // real break; what the tab does with it is what this checks. The state is
  // set and read in one go, before the next push from the server replaces it.
  const reenter = await page.evaluate(() => {
    const field = window.mttField || {};
    window.mttField = {
      ...field,
      status: 'running',
      buyIn: 100,
      entrants: 2,
      entries: 3,
      you: { ...(field.you || {}), canReenter: true, canAddOn: false },
    };
    renderInfoTab();
    const block = document.getElementById('panelInfoEntry');
    return {
      hidden: block.classList.contains('hidden'),
      text: block.textContent,
      button: block.querySelector('button').textContent,
      field: document.getElementById('panelInfoBody').textContent,
    };
  });
  expect(reenter.hidden).toBe(false);
  expect(reenter.text).toContain('Re-enter');
  expect(reenter.text).toContain('buy-in of 100');
  expect(reenter.button).toBe('Re-enter');
  expect(reenter.field).toContain('Entries');

  const addOn = await page.evaluate(() => {
    window.mttField.you = { ...window.mttField.you, canReenter: false, canAddOn: true };
    renderInfoTab();
    const block = document.getElementById('panelInfoEntry');
    const button = block.querySelector('button');
    const out = { hidden: block.classList.contains('hidden'), text: block.textContent };
    out.button = button.textContent;
    // Pressing it asks the server, whose answer is a dialog rather than a
    // log line: at this table the first break has not come.
    button.click();
    return out;
  });
  expect(addOn.hidden).toBe(false);
  expect(addOn.text).toContain('Add-on');
  expect(addOn.text).toContain('until the break ends');
  expect(addOn.button).toBe('Take the add-on');
  await expect(page.locator('#appDialogBody')).toContainText('first break only');
  await page.click('#btnAppDialogConfirm');

  const gone = await page.evaluate(() => {
    window.mttField.you = { ...window.mttField.you, canReenter: false, canAddOn: false };
    renderInfoTab();
    return document.getElementById('panelInfoEntry').classList.contains('hidden');
  });
  expect(gone).toBe(true);
  expect(pageErrors).toEqual([]);
});
