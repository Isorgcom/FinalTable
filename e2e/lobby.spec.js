// lobby.spec.js - the tournament lobby in a real browser: identity, creating,
// joining by link from a second browser, the host starting, unregistering.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-lobby-pw-'));
  process.env.SAVE_DIR = tempDir;
  process.env.HOST = '127.0.0.1';
  process.env.AUTO_TURN_DELAY_MS = '40';
  process.env.TOURNAMENT_SWEEP_MS = '100';
  // The table holds a beat between streets and between hands. Short here, or
  // a spec that waits for hands to turn over waits out the real pacing.
  process.env.STREET_PAUSE_MS = '400';
  process.env.HAND_PAUSE_MS = '400';
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

async function identifyAs(page, name) {
  await page.goto(baseUrl);
  await page.fill('#playerName', name);
  await page.locator('#playerName').blur();
  await expect(page.locator('#identityStatus')).toContainText(`Playing as ${name}`);
}

async function createTournament(page, { name = 'Friday Night', minutes = 15, bots = false } = {}) {
  await page.click('#btnCreateTournament');
  await expect(page.locator('#lobbyCreate')).toBeVisible();
  await page.fill('#tName', name);
  await page.click(`#tStartQuick button[data-min="${minutes}"]`);
  if (bots) await page.check('#tBots');
  await page.click('#btnCreateSubmit');
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  const code = (await page.locator('#wrCode').textContent()).trim();
  expect(code).toMatch(/^[A-Z2-9]{5}$/);
  return code;
}

test('a name and avatar become an identity that survives a reload', async ({ page }) => {
  await identifyAs(page, 'Ann');
  const uid = await page.evaluate(() => window.__identity.uid);
  const token = await page.evaluate(() => localStorage.getItem('finaltable_identity_token'));
  expect(uid).toMatch(/^u_/);
  expect(token).toBeTruthy();
  expect(token).not.toBe(uid);

  await page.reload();
  await expect(page.locator('#identityStatus')).toContainText('Playing as Ann');
  expect(await page.evaluate(() => window.__identity.uid)).toBe(uid);
  await expect(page.locator('#lobbyEmpty')).toBeVisible();
});

test('creating a tournament lands in the waiting room with roster, code and settings', async ({
  page,
}) => {
  await identifyAs(page, 'Host');
  const code = await createTournament(page, { name: 'Sunday Deepstack', minutes: 15 });
  await expect(page.locator('#wrName')).toHaveText('Sunday Deepstack');
  await expect(page.locator('#wrStatus')).toContainText('Starts in');
  await expect(page.locator('#wrRoster .wr-row')).toHaveCount(1);
  await expect(page.locator('#wrRoster .wr-row').first()).toContainText('Host');
  await expect(page.locator('#wrRoster .wr-badge').first()).toHaveText('host');
  await expect(page.locator('#wrSettings')).toContainText('8-max');
  await expect(page.locator('#wrSettings')).toContainText('late registration through level 3');
  await expect(page.locator('#wrHostControls')).toBeVisible();
  // A field of one cannot deal, so the host waits for a second person.
  await expect(page.locator('#btnStartNow')).toBeDisabled();
  const list = await (await fetch(`${baseUrl}/api/tournaments`)).json();
  expect(list.find((t) => t.code === code)).toMatchObject({
    status: 'registering',
    hostName: 'Host',
  });
});

test('a second player joins by link, both see each other, and the host starts for both', async ({
  browser,
  page,
}) => {
  await identifyAs(page, 'Host');
  const code = await createTournament(page, { name: 'Two Up', minutes: 15 });

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const guestErrors = [];
  guest.on('pageerror', (err) => guestErrors.push(err.message));
  await guest.goto(`${baseUrl}/?t=${code.toLowerCase()}`);
  await expect(guest.locator('#joinCodeInput')).toHaveValue(code);
  await guest.fill('#playerName', 'Guest');
  await guest.locator('#playerName').blur();
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();
  await expect(guest.locator('#wrName')).toHaveText('Two Up');
  await expect(guest.locator('#wrHostControls')).toBeHidden();

  // Both rosters show both humans, connected.
  for (const p of [page, guest]) {
    await expect(p.locator('#wrRoster .wr-row')).toHaveCount(2);
    await expect(p.locator('#wrRoster')).toContainText('Host');
    await expect(p.locator('#wrRoster')).toContainText('Guest');
    await expect(p.locator('#wrRoster .wr-dot.on')).toHaveCount(2);
  }

  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.locator('#playerSeats .player-seat:not(.seat-empty)')).toHaveCount(2);
  await guest.click('#tabInfo');
  await expect(guest.locator('#panelInfoBody')).toContainText('Multi-table');
  await expect(guest.locator('#panelInfoBody')).toContainText('Host');
  expect(guestErrors).toEqual([]);
  await guestContext.close();
});

test('the bot option fills the table so one person can start', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await identifyAs(page, 'Solo');
  await createTournament(page, { name: 'Donkey Show', minutes: 15, bots: true });

  // Five demo seats and the one person, badged so nobody mistakes a bot for a
  // friend who turned up, and none of them showing as away.
  await expect(page.locator('#wrRoster .wr-row')).toHaveCount(6);
  await expect(page.locator('#wrRoster .wr-badge', { hasText: 'bot' })).toHaveCount(5);
  await expect(page.locator('#wrRoster .wr-dot.on')).toHaveCount(6);
  await expect(page.locator('#btnStartNow')).toBeEnabled();

  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(page.locator('#playerSeats .player-seat:not(.seat-empty)')).toHaveCount(6);
  // And they play: chips go in without anyone touching the controls. The
  // blinds alone are 30, so a pot past that is a bot that has acted.
  //
  // Generous on time because the seat draw decides how long this takes. If the
  // one human is first to act, nothing moves until their turn clock runs out,
  // and that is thirty seconds on a tournament table - so anything under it
  // fails on the hands where the draw puts them under the gun.
  await expect
    .poll(() => page.evaluate(() => gameState && gameState.pot), { timeout: 45000 })
    .toBeGreaterThan(30);
  expect(errors).toEqual([]);
});

test('unregistering before the start returns to the lobby', async ({ page }) => {
  await identifyAs(page, 'Solo');
  const code = await createTournament(page, { name: 'Changed My Mind', minutes: 30 });
  await page.click('#btnUnregister');
  await expect(page.locator('#lobbyHome')).toBeVisible();
  await expect(page.locator('#lobbyWaiting')).toBeHidden();
  await expect
    .poll(async () => {
      const list = await (await fetch(`${baseUrl}/api/tournaments`)).json();
      return list.some((t) => t.code === code);
    })
    .toBe(false);
});
