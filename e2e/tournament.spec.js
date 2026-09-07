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
  await expect(guest.locator('#playerSeats .player-seat')).toHaveCount(2);

  const before = await guest.evaluate(() => ({
    uid: window.__identity.uid,
    table: gameState.id,
    seated: gameState.players.some((p) => p.id === myId),
  }));
  expect(before.seated).toBe(true);

  await guest.reload();
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 15000 });
  await expect(guest.locator('#playerSeats .player-seat')).toHaveCount(2);
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

test('the host can leave the table and rejoin it, back in control', async ({ browser, page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(baseUrl);
  await page.fill('#playerName', 'Leaver');
  await page.locator('#playerName').blur();
  await expect(page.locator('#identityStatus')).toContainText('Playing as Leaver');
  await page.click('#btnCreateTournament');
  await page.fill('#tName', 'Back In A Minute');
  await page.click('#tStartQuick button[data-min="15"]');
  await page.click('#btnCreateSubmit');
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  const code = (await page.locator('#wrCode').textContent()).trim();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  guest.on('pageerror', (err) => errors.push(err.message));
  await guest.goto(`${baseUrl}/?t=${code}`);
  await guest.fill('#playerName', 'Stayer');
  await guest.locator('#playerName').blur();
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();
  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });

  // Leave through the menu, confirming the dialog.
  await page.click('#menuToggle');
  await page.click('#btnExit');
  await page.click('#btnAppDialogConfirm');
  await expect(page.locator('#lobbyHome')).toBeVisible();

  // The card has to say Rejoin. Before the fix it sat in the Running section
  // offering late registration, which closes, and then nothing at all.
  const card = page.locator('#listYours .t-card').first();
  await expect(card).toBeVisible();
  await expect(card.locator('.t-card-btn')).toHaveText('Rejoin');

  await card.locator('.t-card-btn').click();
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });

  // Back in control: the seat is the viewer's again and is not sitting out.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const me = gameState && gameState.players.find((p) => p.id === myId);
        return me ? !!me.autoPlay : null;
      })
    )
    .toBe(false);
  await expect(page.locator('.player-auto-badge')).toHaveCount(0);
  expect(errors).toEqual([]);
  await guestContext.close();
});

test('a dropped connection sits the seat out, and coming back resumes it', async ({
  browser,
  page,
}) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(baseUrl);
  await page.fill('#playerName', 'Dropper');
  await page.locator('#playerName').blur();
  await expect(page.locator('#identityStatus')).toContainText('Playing as Dropper');
  await page.click('#btnCreateTournament');
  await page.fill('#tName', 'Signal Loss');
  await page.click('#tStartQuick button[data-min="15"]');
  await page.click('#btnCreateSubmit');
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  const code = (await page.locator('#wrCode').textContent()).trim();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  guest.on('pageerror', (err) => errors.push(err.message));
  await guest.goto(`${baseUrl}/?t=${code}`);
  await guest.fill('#playerName', 'Steady');
  await guest.locator('#playerName').blur();
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();
  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });

  // The table screen opens on tournamentJoined; the first hand arrives on the
  // director's next tick. Dropping before it is dealt is a no-op, because a
  // seat at an idle table has nothing to sit out of.
  await expect
    .poll(() =>
      page.evaluate(() => !!(typeof gameState !== 'undefined' && gameState && gameState.isRunning))
    )
    .toBe(true);

  const uid = await page.evaluate(() => window.__identity.uid);
  const seatState = () => {
    const entry = serverModule.registry.findByUid(uid);
    const seat = entry ? entry.director.playerByUid(uid) : null;
    return seat ? { auto: !!seat.player.autoPlay, reason: seat.player.sitOutReason } : null;
  };

  // Drop the socket. This half is asserted on the server: a disconnected page
  // stops receiving gameState, so it cannot see its own seat sit out.
  await page.evaluate(() => socket.disconnect());
  await expect.poll(() => seatState() && seatState().auto).toBe(true);
  expect(seatState().reason).toBe('disconnect');

  // Coming back hands the seat straight back, with no button to press.
  await page.evaluate(() => socket.connect());
  await expect.poll(() => seatState() && seatState().auto).toBe(false);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const me = gameState && gameState.players.find((p) => p.id === myId);
        return me ? !!me.autoPlay : null;
      })
    )
    .toBe(false);
  await expect(page.locator('#seatBanner')).toBeHidden();
  await expect(page.locator('#btnAutoPlay')).toBeVisible();
  expect(errors).toEqual([]);
  await guestContext.close();
});

test('the way back in stays put across hand boundaries', async ({ browser, page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(baseUrl);
  await page.fill('#playerName', 'Steady');
  await page.locator('#playerName').blur();
  await page.click('#btnCreateTournament');
  await page.fill('#tName', 'No Flicker');
  await page.click('#tStartQuick button[data-min="15"]');
  await page.click('#btnCreateSubmit');
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  const code = (await page.locator('#wrCode').textContent()).trim();

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  guest.on('pageerror', (err) => errors.push(err.message));
  await guest.goto(`${baseUrl}/?t=${code}`);
  await guest.fill('#playerName', 'Mover');
  await guest.locator('#playerName').blur();
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();
  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect.poll(() => page.evaluate(() => !!(gameState && gameState.isRunning))).toBe(true);

  // Both seats sit out, so hands finish in a couple of folds and the table
  // crosses a hand boundary every second or so. That boundary is what used to
  // take the control away: it was gated on a hand being in progress.
  await page.click('#btnAutoPlay');
  await guest.click('#btnAutoPlay');
  await expect(page.locator('#seatBanner')).toBeVisible();

  const startRound = await page.evaluate(() => gameState.roundCount);
  let hidden = 0;
  let samples = 0;
  for (let i = 0; i < 40; i++) {
    const shown = await page.evaluate(
      () => !document.getElementById('seatBanner').classList.contains('hidden')
    );
    samples += 1;
    if (!shown) hidden += 1;
    await page.waitForTimeout(100);
  }
  const endRound = await page.evaluate(() => gameState.roundCount);

  expect(samples).toBe(40);
  expect(endRound).toBeGreaterThan(startRound); // hands really did turn over
  expect(hidden).toBe(0);
  expect(errors).toEqual([]);
  await guestContext.close();
});
