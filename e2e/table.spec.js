// table.spec.js - the table screen, end to end in a real browser.
//
// The Jest suite covers the engine thoroughly and the DOM barely at all. This
// spec is the safety net for the table UI: it boots the real server, seats a
// human at a practice table with fast bots, deals, and checks that the seats,
// the action bar, the log and a raise all round-trip through the socket.
// Server-side assertions go through game.onMessage rather than the log DOM so
// they survive the log moving between containers.

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
  process.env.PREFLOP_TABLE = 'off';
  process.env.SAVE_DIR = tempDir;
  process.env.HOST = '127.0.0.1';
  // Bots act almost at once so the viewer's turn comes round in well under a
  // second instead of the human-paced 2.6-5.2s per bot.
  process.env.NPC_DELAY_MIN = '40';
  process.env.NPC_DELAY_MAX = '90';
  // engine.js reads NPC_DELAY_* at load, and another spec in this worker may
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
    buildPreflop: false,
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

// Practice rooms outlive the page that made them, so an earlier test's room
// is still in the map. Ask the page which room it joined.
async function gameForPage(page) {
  const roomId = await page.inputValue('#roomId');
  return serverModule.games.get(roomId) || null;
}

async function seatAtPracticeTable(page, name) {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto(baseUrl);
  await page.fill('#playerName', name);
  await page.click('#modeBtn_practice');
  await page.selectOption('#npcCount', '3');
  await page.click('#btnTakeASeat');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/);
  return pageErrors;
}

async function deal(page) {
  const dealButton = page.locator('#btnStartGame');
  await expect(dealButton).toBeVisible();
  await dealButton.click();
  await expect(page.locator('#actionsPanel')).not.toHaveClass(/hidden/, { timeout: 15000 });
}

test('a practice table seats every player, deals, and hands the viewer the action bar', async ({
  page,
}) => {
  const pageErrors = await seatAtPracticeTable(page, 'TableTester');

  await expect(page.locator('#playerSeats .player-seat')).toHaveCount(4);

  await deal(page);

  await expect(page.locator('#logLast')).not.toContainText('joined the table');
  await expect(page.locator('#panelChatBody .log-entry')).not.toHaveCount(0);
  await expect(page.locator('#tabChat')).toHaveAttribute('aria-selected', 'true');
  await page.click('#tabInfo');
  await expect(page.locator('#panelInfo')).toBeVisible();
  await expect(page.locator('#panelChat')).toBeHidden();
  await page.keyboard.press('Home');
  await expect(page.locator('#panelChat')).toBeVisible();
  await expect(page.locator('#panelInfoBody')).toContainText('Practice');
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
  await expect(page.locator('#playerSeats .seat-plate .seat-avatar')).toHaveCount(4);
  await expect(page.locator('.player-bet-badge')).toHaveCount(0);
  await expect(page.locator('#handStrength')).toContainText('You have');
  await expect(page.locator('#presetGroup .preset-btn')).toHaveCount(4);
  await expect(page.locator('#playerSeats .player-seat.active-turn')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('a raise from the action bar reaches the engine', async ({ page }) => {
  const pageErrors = await seatAtPracticeTable(page, 'RaiseTester');
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
  const pageErrors = await seatAtPracticeTable(page, 'TimeTester');
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
