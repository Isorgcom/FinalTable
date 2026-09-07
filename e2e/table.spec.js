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
  await expect(guest.locator('#btnAutoPlay')).toHaveText('sit in', { timeout: 10000 });
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
