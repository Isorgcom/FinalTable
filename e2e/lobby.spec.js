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

async function createTournament(
  page,
  { name = 'Friday Night', minutes = 15, bots = false, visibility = null } = {}
) {
  await page.click('#btnCreateTournament');
  await expect(page.locator('#lobbyCreate')).toBeVisible();
  await page.fill('#tName', name);
  // Private is the default; a test that wants a listed game says so.
  if (visibility) await page.click(`#tVisibility button[data-vis="${visibility}"]`);
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
  const code = await createTournament(page, {
    name: 'Sunday Deepstack',
    minutes: 15,
    visibility: 'public',
  });
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
  const card = list.find((t) => t.name === 'Sunday Deepstack');
  expect(card).toMatchObject({ status: 'registering', hostName: 'Host' });
  // Anyone can fetch this list, so the code the waiting room shows is not in it.
  expect(card).not.toHaveProperty('code');
  expect(JSON.stringify(list)).not.toContain(code);
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

test('a guest joins from the lobby card without ever seeing the code', async ({
  browser,
  page,
}) => {
  await identifyAs(page, 'Host');
  const code = await createTournament(page, {
    name: 'Open Door',
    minutes: 15,
    visibility: 'public',
  });

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const guestErrors = [];
  guest.on('pageerror', (err) => guestErrors.push(err.message));
  await identifyAs(guest, 'Walk-in');
  const card = guest.locator('#listRegistering .t-card', { hasText: 'Open Door' });
  await expect(card.locator('.t-card-btn')).toHaveText('Join');
  // Nothing the lobby holds for this card is the code.
  expect(await card.evaluate((el) => el.outerHTML)).not.toContain(code);
  expect(await guest.evaluate(() => JSON.stringify(window.Lobby.current()))).not.toContain(code);

  await card.locator('.t-card-btn').click();
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();
  await expect(guest.locator('#wrName')).toHaveText('Open Door');
  // Once in, the waiting room shows the same code the host has, for sharing on.
  await expect(guest.locator('#wrCode')).toHaveText(code);
  for (const p of [page, guest]) {
    await expect(p.locator('#wrRoster .wr-row')).toHaveCount(2);
    await expect(p.locator('#wrRoster')).toContainText('Walk-in');
  }
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
  await createTournament(page, { name: 'Changed My Mind', minutes: 30, visibility: 'public' });
  await page.click('#btnUnregister');
  await expect(page.locator('#lobbyHome')).toBeVisible();
  await expect(page.locator('#lobbyWaiting')).toBeHidden();
  await expect
    .poll(async () => {
      const list = await (await fetch(`${baseUrl}/api/tournaments`)).json();
      return list.some((t) => t.name === 'Changed My Mind');
    })
    .toBe(false);
});

test('the lobby menu holds only the version when nothing else is configured', async ({ page }) => {
  // This spec's server has no ADMIN_PASSWORD and no GameNight pairing.
  await page.goto(baseUrl);
  await page.click('#lobbyMenuToggle');
  await expect(page.locator('#lobbyMenuDropdown')).toHaveClass(/open/);
  await expect(page.locator('#lobbyMenuVersion')).toContainText('FinalTable v');
  await expect(page.locator('#btnOperator')).toBeHidden();
  await expect(page.locator('#btnGameNightSignOut')).toBeHidden();
  await expect(page.locator('#btnGameNight')).toBeHidden();
});

test('the create form is private by default, and the hint follows the choice', async ({ page }) => {
  await identifyAs(page, 'Host');
  await page.click('#btnCreateTournament');
  await expect(page.locator('#tVisibility button.active')).toHaveAttribute('data-vis', 'private');
  await expect(page.locator('#tVisibilityHint')).toContainText('Unlisted');
  await page.click('#tVisibility button[data-vis="public"]');
  await expect(page.locator('#tVisibilityHint')).toContainText('anyone can join');
  await page.click('#tVisibility button[data-vis="invite"]');
  await expect(page.locator('#tVisibilityHint')).toContainText('let them in');
});

test("a private game is nowhere on a stranger's lobby, and joins by link", async ({
  browser,
  page,
}) => {
  await identifyAs(page, 'Host');
  const code = await createTournament(page, { name: 'Just Us', minutes: 15 });
  await expect(page.locator('#wrSettings')).toContainText('private');
  await expect(page.locator('#listYours .t-card-vis')).toHaveText('private');

  const stranger = await browser.newContext();
  const other = await stranger.newPage();
  await identifyAs(other, 'Nosy');
  // Earlier tests leave public games behind on the shared server, so the
  // check is that this one is not among them, on the wire or on the page.
  expect(JSON.stringify(await (await fetch(`${baseUrl}/api/tournaments`)).json())).not.toContain(
    'Just Us'
  );
  await other.waitForTimeout(250); // the list push lands just after identified
  await expect(other.locator('.t-card', { hasText: 'Just Us' })).toHaveCount(0);

  // The link is the invitation.
  await other.goto(`${baseUrl}/?t=${code.toLowerCase()}`);
  await expect(other.locator('#lobbyWaiting')).toBeVisible();
  await expect(other.locator('#wrRoster .wr-row')).toHaveCount(2);
  await stranger.close();
});

test('an invite-only game: the link knocks, the host lets you in', async ({ browser, page }) => {
  await identifyAs(page, 'Host');
  const code = await createTournament(page, { name: 'Doorman', minutes: 15, visibility: 'invite' });
  await expect(page.locator('#wrCodeHint')).toContainText('you let them in');

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`${baseUrl}/?t=${code.toLowerCase()}`);
  await guest.fill('#playerName', 'Knocker');
  await guest.locator('#playerName').blur();
  await expect(guest.locator('#lobbyPending')).toBeVisible();
  await expect(guest.locator('#pdName')).toHaveText('Doorman');
  await expect(guest.locator('#pdStatus')).toContainText('Waiting for Host to let you in');
  await expect(guest.locator('#lobbyWaiting')).toBeHidden();

  const row = page.locator('#wrPendingList .wr-row', { hasText: 'Knocker' });
  await expect(row).toBeVisible();
  await row.locator('.wr-admit').click();
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();
  await expect(guest.locator('#lobbyPending')).toBeHidden();
  for (const p of [page, guest]) {
    await expect(p.locator('#wrRoster .wr-row')).toHaveCount(2);
    await expect(p.locator('#wrRoster')).toContainText('Knocker');
  }
  await expect(page.locator('#wrPending')).toBeHidden();
  await guestContext.close();
});

test('an invite-only game: turned away lands back in the lobby with a reason', async ({
  browser,
  page,
}) => {
  await identifyAs(page, 'Host');
  const code = await createTournament(page, {
    name: 'No Entry',
    minutes: 15,
    visibility: 'invite',
  });
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`${baseUrl}/?t=${code.toLowerCase()}`);
  await guest.fill('#playerName', 'Hopeful');
  await guest.locator('#playerName').blur();
  await expect(guest.locator('#lobbyPending')).toBeVisible();
  const row = page.locator('#wrPendingList .wr-row', { hasText: 'Hopeful' });
  await row.locator('.wr-decline').click();
  await expect(guest.locator('#lobbyHome')).toBeVisible();
  await expect(guest.locator('#appDialogBody')).toContainText('did not let you in');
  await expect(page.locator('#wrPending')).toBeHidden();
  await guestContext.close();
});

// The page marks itself stale by hand: the server's build never changes
// under a test, so the meta is edited to disagree with it, and a reconnect
// brings the serverInfo that makes the page look.
async function pretendStale(page) {
  await page.evaluate(() => {
    document
      .querySelector('meta[name="finaltable-asset-version"]')
      .setAttribute('content', 'stale00000');
    socket.disconnect();
    socket.connect();
  });
}

test('a page served before an update reloads itself when it reconnects', async ({ page }) => {
  await identifyAs(page, 'Host');
  const served = await page.getAttribute('meta[name="finaltable-asset-version"]', 'content');
  expect(served).toMatch(/^[0-9a-f]{10}$/);
  const reloaded = page.waitForEvent('load');
  await pretendStale(page);
  await reloaded;
  await expect(page.locator('meta[name="finaltable-asset-version"]')).toHaveAttribute(
    'content',
    served
  );
  await expect(page.locator('#updateStatus')).toBeHidden();
  await expect(page.locator('#lobbyHome')).toBeVisible();
});

test('a page that is stale at a table says so and reloads once you leave', async ({
  browser,
  page,
}) => {
  await identifyAs(page, 'Host');
  const code = await createTournament(page, { name: 'Stale Table', minutes: 15 });
  // By code rather than by link: a ?t= link would rejoin the table on the
  // reload at the end, and the point is to land in the lobby.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await identifyAs(guest, 'Guest');
  await guest.fill('#joinCodeInput', code);
  await guest.click('#btnJoinCode');
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();
  await page.click('#btnStartNow');
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });

  let loads = 0;
  guest.on('load', () => loads++);
  await pretendStale(guest);
  await expect(guest.locator('#updateStatus')).toBeVisible();
  await guest.waitForTimeout(1500);
  expect(loads).toBe(0);
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/);

  const reloaded = guest.waitForEvent('load');
  await guest.click('#menuToggle');
  await guest.click('#btnExit');
  await guest.click('#btnAppDialogConfirm'); // "leave the table?"
  await reloaded;
  await expect(guest.locator('#updateStatus')).toBeHidden();
  await expect(guest.locator('#lobbyHome')).toBeVisible();
  await guestContext.close();
});
