// tournament.spec.js - two browsers in one tournament, and a reload
// mid-tournament that lands back at the same table.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');

let serverModule;
let baseUrl;
let tempDir;
const originalEnv = { ...process.env };
const repoRoot = path.join(__dirname, '..');

test.setTimeout(60000);

test.beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-tourney-pw-'));
  process.env.SAVE_DIR = tempDir;
  process.env.HOST = '127.0.0.1';
  process.env.NPC_DELAY_MIN = '40';
  process.env.NPC_DELAY_MAX = '90';
  process.env.TOURNAMENT_SWEEP_MS = '100';
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
  serverModule.registry.stop();
  await new Promise((resolve) => serverModule.io.close(resolve));
  if (serverModule.server.listening) {
    await new Promise((resolve) => serverModule.server.close(resolve));
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.env = originalEnv;
});

test('two players reach one table, and one comes back to it after a reload', async ({
  browser,
  page,
}) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(baseUrl);
  await page.fill('#playerName', 'Host');
  await page.locator('#playerName').blur();
  await expect(page.locator('#identityStatus')).toContainText('Playing as Host');
  await page.click('#btnCreateTournament');
  await page.fill('#tName', 'Reload Night');
  await page.click('#tStartQuick button[data-min="15"]');
  await page.fill('#tBots', '2');
  await page.click('#btnCreateSubmit');
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  const code = (await page.locator('#wrCode').textContent()).trim();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  guest.on('pageerror', (err) => errors.push(err.message));
  await guest.goto(`${baseUrl}/?t=${code}`);
  await guest.fill('#playerName', 'Guest');
  await guest.locator('#playerName').blur();
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();
  await expect(page.locator('#wrRoster')).toContainText('Guest');

  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.locator('#playerSeats .player-seat')).toHaveCount(4);

  const before = await guest.evaluate(() => ({
    uid: window.__identity.uid,
    table: gameState.id,
    seated: gameState.players.some((p) => p.id === myId),
  }));
  expect(before.seated).toBe(true);

  await guest.reload();
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 15000 });
  await expect(guest.locator('#playerSeats .player-seat')).toHaveCount(4);
  const after = await guest.evaluate(() => ({
    uid: window.__identity.uid,
    table: gameState.id,
    seated: gameState.players.some((p) => p.id === myId),
    resumed: !!window.__identity.resume,
  }));
  expect(after.uid).toBe(before.uid);
  expect(after.table).toBe(before.table);
  expect(after.seated).toBe(true);
  expect(after.resumed).toBe(true);
  expect(errors).toEqual([]);
  await guestContext.close();
});
