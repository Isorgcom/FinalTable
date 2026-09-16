// sso.spec.js - the GameNight sign-in in a real browser. GameNight itself is
// not here; the spec plays its part by putting a token it signed into the
// URL fragment the way GameNight's redirect does, with the state the lobby
// stashed before leaving.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');

let serverModule;
let baseUrl;
let tempDir;
const originalEnv = { ...process.env };
const repoRoot = path.join(__dirname, '..');

const ISSUER = 'http://gamenight.test:8080';
const AUDIENCE = 'finaltable';
const ADMIN_PASSWORD = 'admin-secret';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

let seq = 0;
function signToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  seq += 1;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: '270',
    iat: now,
    exp: now + 120,
    jti: `pw-${String(seq).padStart(12, '0')}-abcdef`,
    name: 'Bryce',
    tier: 'Free',
    ...overrides,
  };
  const input = `${b64({ typ: 'JWT', alg: 'ES256' })}.${b64(claims)}`;
  const sig = crypto.sign('sha256', Buffer.from(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${sig.toString('base64url')}`;
}

test.beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-sso-pw-'));
  process.env.SAVE_DIR = tempDir;
  process.env.HOST = '127.0.0.1';
  process.env.TOURNAMENT_SWEEP_MS = '100';
  process.env.GAMENIGHT_URL = ISSUER;
  process.env.GAMENIGHT_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
  process.env.GAMENIGHT_AUDIENCE = AUDIENCE;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(repoRoot) && !key.includes(`${path.sep}node_modules${path.sep}`)) {
      delete require.cache[key];
    }
  }
  serverModule = require('../server');
  await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
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

// The lobby's menu holds the admin link and the GameNight sign-out.
async function openLobbyMenu(page) {
  await page.click('#lobbyMenuToggle');
  await expect(page.locator('#lobbyMenuDropdown')).toHaveClass(/open/);
}

// What the lobby leaves in sessionStorage before it sends the browser away.
async function stash(page, state, code = null) {
  await page.addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
    },
    ['finaltable_gn_state', JSON.stringify({ state, code })]
  );
}

test('the button is offered, and leaves for GameNight with a state', async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.locator('#btnGameNight')).toBeVisible();
  // Do not actually navigate to a host that does not exist: read the target.
  await page.route('**/connect.php*', (route) => route.fulfill({ status: 200, body: 'gamenight' }));
  await page.click('#btnGameNight');
  await page.waitForURL(/connect\.php/);
  const url = new URL(page.url());
  expect(url.origin).toBe(ISSUER);
  expect(url.searchParams.get('app')).toBe(AUDIENCE);
  expect(url.searchParams.get('return')).toBe(`${baseUrl}/`);
  expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
});

test('a signed token in the fragment signs the player in, and the device remembers it', async ({
  page,
}) => {
  await stash(page, 'state-abcdefghijklmnop');
  await page.goto(`${baseUrl}/#gn_token=${signToken()}&state=state-abcdefghijklmnop`);
  await expect(page.locator('#identityStatus')).toContainText('Signed in with GameNight as Bryce');
  await expect(page.locator('#playerName')).toHaveValue('Bryce');
  await expect(page.locator('#playerName')).toHaveAttribute('readonly', '');
  await expect(page.locator('#btnGameNight')).toBeHidden();
  await openLobbyMenu(page);
  await expect(page.locator('#btnGameNightSignOut')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#lobbyMenuDropdown')).not.toHaveClass(/open/);
  expect(new URL(page.url()).hash).toBe('');
  const uid = await page.evaluate(() => window.__identity.uid);
  expect(uid).toBe('gn_270');
  expect(await page.evaluate(() => localStorage.getItem('finaltable_identity_provider'))).toBe(
    'gamenight'
  );

  // A reload identifies by the device token, with no GameNight round trip.
  await page.reload();
  await expect(page.locator('#identityStatus')).toContainText('Signed in with GameNight as Bryce');
  expect(await page.evaluate(() => window.__identity.uid)).toBe('gn_270');

  // Sign out: back to a guest with an empty name.
  await openLobbyMenu(page);
  await page.click('#btnGameNightSignOut');
  await expect(page.locator('#btnGameNight')).toBeVisible();
  await expect(page.locator('#playerName')).toHaveValue('');
  await expect(page.locator('#playerName')).not.toHaveAttribute('readonly', '');
});

// The devices a GameNight account is signed in on, and signing one out from
// another. Two browser contexts because two devices is two device tokens.
test('your devices lists both, and one signs the other out', async ({ page, browser }) => {
  await stash(page, 'state-abcdefghijklmnop');
  await page.goto(`${baseUrl}/#gn_token=${signToken()}&state=state-abcdefghijklmnop`);
  await expect(page.locator('#identityStatus')).toContainText('Signed in with GameNight as Bryce');

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await stash(other, 'state-qrstuvwxyz012345');
  await other.goto(`${baseUrl}/#gn_token=${signToken()}&state=state-qrstuvwxyz012345`);
  await expect(other.locator('#identityStatus')).toContainText('Signed in with GameNight as Bryce');
  // The same player, two devices.
  expect(await other.evaluate(() => window.__identity.uid)).toBe(
    await page.evaluate(() => window.__identity.uid)
  );

  await openLobbyMenu(page);
  await page.click('#btnSessions');
  await expect(page.locator('#lobbySessions')).toBeVisible();
  const rows = page.locator('#sessionsList .session-row');
  await expect(rows).toHaveCount(2);
  // One of them is the one being read, and it says so.
  await expect(page.locator('#sessionsList .session-here')).toHaveCount(1);
  await expect(page.locator('#sessionsList')).toContainText('Last here');
  // A device is named, never carrying its token to the page.
  const shown = await page.locator('#sessionsList').textContent();
  const token = await page.evaluate(() => localStorage.getItem('finaltable_identity_token'));
  expect(token).toBeTruthy();
  expect(shown).not.toContain(token);

  // Sign the other one out from this one. Its row goes, and it is told.
  const notThisOne = rows.filter({ hasNot: page.locator('.session-here') }).first();
  await notThisOne.locator('button').click();
  await expect(rows).toHaveCount(1);
  // The signed-out device lands back in the lobby as a stranger, and is told
  // why rather than simply finding itself signed out.
  await expect(other.locator('#btnGameNight')).toBeVisible({ timeout: 10000 });
  await expect(other.locator('#playerName')).toHaveValue('');
  await expect(other.locator('#appDialogBody')).toContainText('signed out from somewhere else');

  await otherContext.close();
});

test('a token whose state does not match the one stashed is thrown away', async ({ page }) => {
  await stash(page, 'the-state-that-was-sent');
  await page.goto(`${baseUrl}/#gn_token=${signToken()}&state=some-other-state-xx`);
  await expect(page.locator('#appDialogBody')).toContainText('could not be verified');
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => window.__identity || null)).toBeNull();
});

test('a join link survives the round trip', async ({ page, browser }) => {
  // Somebody else's tournament to join.
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto(baseUrl);
  await host.fill('#playerName', 'Host');
  await host.locator('#playerName').blur();
  await expect(host.locator('#identityStatus')).toContainText('Playing as Host');
  await host.click('#btnCreateTournament');
  await host.fill('#tName', 'Round trip');
  await host.click('#tStartQuick button[data-min="15"]');
  await host.click('#btnCreateSubmit');
  await expect(host.locator('#lobbyWaiting')).toBeVisible();
  const code = (await host.locator('#wrCode').textContent()).trim();

  await stash(page, 'state-with-a-code-1234', code);
  await page.goto(
    `${baseUrl}/#gn_token=${signToken({ sub: '271', name: 'Guest270' })}&state=state-with-a-code-1234`
  );
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  await expect(page.locator('#wrRoster')).toContainText('Guest270');
  await expect(page.locator('#wrRoster .wr-badge-gn')).toHaveCount(1);
  await hostContext.close();
});

// The Admin page lists every game the server holds, listed or not, with
// its code, and can end one from there. Runs before the pairing test below,
// which changes the admin password for the rest of this file.
test('the admin sees every game, listed or not, and can end one', async ({ browser, page }) => {
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto(baseUrl);
  await host.fill('#playerName', 'Quiet Host');
  await host.locator('#playerName').blur();
  await expect(host.locator('#lobbyHome')).toBeVisible();
  await host.click('#btnCreateTournament');
  await host.fill('#tName', 'Back Room');
  await host.click('#tStartQuick button[data-min="15"]');
  await host.click('#btnCreateSubmit');
  await expect(host.locator('#lobbyWaiting')).toBeVisible();
  const code = (await host.locator('#wrCode').textContent()).trim();

  await page.goto(baseUrl);
  await openLobbyMenu(page);
  await page.click('#btnLobbyAdmin');
  await page.fill('#appDialogInput', ADMIN_PASSWORD);
  await page.click('#btnAppDialogConfirm');
  await expect(page.locator('#lobbyAdmin')).toBeVisible();
  const card = page.locator('#adminGamesList .t-card', { hasText: 'Back Room' });
  await expect(card).toBeVisible();
  await expect(card.locator('.admin-code')).toHaveText(code);
  await expect(card.locator('.t-card-vis')).toHaveText('private');
  await expect(card.locator('.t-card-meta')).toContainText('1/1 connected');
  // Earlier tests leave games of their own on this server, so the count is
  // only ever "some".
  await expect(page.locator('#adminGamesStatus')).toContainText('game');
  // And still nowhere a player could see it.
  const pub = await (await fetch(`${baseUrl}/api/tournaments`)).json();
  expect(pub.find((t) => t.name === 'Back Room')).toBeUndefined();

  await card.locator('button', { hasText: 'End game' }).click();
  await page.click('#btnAppDialogConfirm');
  await expect(host.locator('#lobbyHome')).toBeVisible();
  await expect(host.locator('#appDialogBody')).toContainText('cancelled by the admin');
  await expect(page.locator('#adminGamesList .t-card', { hasText: 'Back Room' })).toHaveCount(0);
  await hostContext.close();
});

// The Admin page: unlock with the admin password, see the pairing the
// environment seeded, unpair, then pair again against a GameNight stood up
// here, and watch the sign-in button follow.
// The page is four pages behind one strip now, so that a fifth can join
// without making it a longer scroll. This is the shape, not the contents.
test('the Admin page is tabs, opening on Games, with one page showing', async ({ page }) => {
  await page.goto(baseUrl);
  await openLobbyMenu(page);
  await page.click('#btnLobbyAdmin');
  await page.fill('#appDialogInput', ADMIN_PASSWORD);
  await page.click('#btnAppDialogConfirm');
  await expect(page.locator('#lobbyAdmin')).toBeVisible();

  const tabs = page.locator('#lobbyAdmin .admin-tabs .side-tab');
  await expect(tabs).toHaveCount(4);
  // It opens on Games, and exactly one page is showing.
  await expect(page.locator('#adminPageGames')).toBeVisible();
  for (const id of ['#adminPageGameNight', '#adminPagePassword', '#adminPageLog']) {
    await expect(page.locator(id)).toBeHidden();
  }
  await expect(page.locator('#tabAdminGames')).toHaveAttribute('aria-selected', 'true');

  // Picking one swaps which page is up and moves the selection with it.
  await page.click('#tabAdminPassword');
  await expect(page.locator('#adminPagePassword')).toBeVisible();
  await expect(page.locator('#adminPageGames')).toBeHidden();
  await expect(page.locator('#tabAdminPassword')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tabAdminGames')).toHaveAttribute('aria-selected', 'false');

  // The arrows walk the strip, and Home goes back to the first.
  await page.locator('#tabAdminPassword').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#adminPageLog')).toBeVisible();
  // The page asks as it opens, and this server has at least started once.
  await expect(page.locator('#adminLogList .admin-log-row').first()).toBeVisible({
    timeout: 5000,
  });
  await page.keyboard.press('Home');
  await expect(page.locator('#adminPageGames')).toBeVisible();
  await expect(page.locator('#tabAdminGames')).toHaveAttribute('aria-selected', 'true');

  // Leaving and coming back opens on Games again, whatever was last picked.
  await page.click('#tabAdminLog');
  await page.click('#btnAdminBack');
  await expect(page.locator('#lobbyHome')).toBeVisible();
  await openLobbyMenu(page);
  await page.click('#btnLobbyAdmin');
  await expect(page.locator('#adminPageGames')).toBeVisible();
});

// What the server has done, which used to be answerable only with a shell on
// the box and a container that had not been recreated.
test('the Log holds what the server has done, behind the same password', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(baseUrl);
  await page.fill('#playerName', 'LogReader');
  await page.locator('#playerName').blur();
  await expect(page.locator('#identityStatus')).toContainText('Playing as LogReader');

  await openLobbyMenu(page);
  await page.click('#btnLobbyAdmin');
  await page.fill('#appDialogInput', ADMIN_PASSWORD);
  await page.click('#btnAppDialogConfirm');
  await expect(page.locator('#lobbyAdmin')).toBeVisible();

  await page.click('#tabAdminLog');
  await expect(page.locator('#adminPageLog')).toBeVisible();

  // A restart is always there - the server did start - and signing in a moment
  // ago put a row of its own in.
  const rows = page.locator('#adminLogList .admin-log-row');
  await expect(rows.first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#adminLogList')).toContainText('Server started');
  await expect(page.locator('#adminLogList')).toContainText('LogReader signed in');
  await expect(page.locator('#adminLogStatus')).toContainText('entr');

  // Nothing a browser must not have, on the page itself.
  const shown = await page.locator('#adminLogList').textContent();
  expect(shown).not.toContain(ADMIN_PASSWORD);

  expect(errors).toEqual([]);
});

// The Log is a live page, and the unlock is not: it lives on the socket, so a
// server restart takes it and every admin request is then answered with
// silence. From inside the page that used to be indistinguishable from a page
// that had stopped working - the Log simply sat on "Loading...".
test('the Log follows the server, and says so when the unlock goes', async ({ browser, page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(baseUrl);
  await page.fill('#playerName', 'Watcher');
  await page.locator('#playerName').blur();
  await expect(page.locator('#identityStatus')).toContainText('Playing as Watcher');

  await openLobbyMenu(page);
  await page.click('#btnLobbyAdmin');
  await page.fill('#appDialogInput', ADMIN_PASSWORD);
  await page.click('#btnAppDialogConfirm');
  await expect(page.locator('#lobbyAdmin')).toBeVisible();
  await expect(page.locator('#adminLocked')).toBeHidden();

  await page.click('#tabAdminLog');
  await expect(page.locator('#adminLogList .admin-log-row').first()).toBeVisible({ timeout: 5000 });

  // Somebody signs in elsewhere. Nothing is clicked here and the row arrives.
  const other = await browser.newContext();
  const stranger = await other.newPage();
  await stranger.goto(baseUrl);
  await stranger.fill('#playerName', 'Latecomer');
  await stranger.locator('#playerName').blur();
  await expect(page.locator('#adminLogList')).toContainText('Latecomer signed in', {
    timeout: 15000,
  });
  await other.close();

  // The transport drops the way a server restart drops it. The socket comes
  // back; the unlock does not, because nothing keeps the password.
  await page.evaluate(() => socket.io.engine.close());
  await expect(page.locator('#adminLocked')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#adminLocked')).toContainText('locked again');

  // And the way back in is on the banner, landing where the reader was rather
  // than starting again at Games.
  await page.click('#btnAdminUnlock');
  await page.fill('#appDialogInput', ADMIN_PASSWORD);
  await page.click('#btnAppDialogConfirm');
  await expect(page.locator('#adminLocked')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('#tabAdminLog')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#adminLogList .admin-log-row').first()).toBeVisible();

  expect(errors).toEqual([]);
});

test('the admin unpairs and re-pairs from the lobby', async ({ page }) => {
  const fakeGn = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            issuer: fakeGn.url,
            connect_url: `${fakeGn.url}/connect.php`,
            keys: [
              {
                kid: 'kid-from-page',
                alg: 'ES256',
                pem: publicKey.export({ type: 'spki', format: 'pem' }),
              },
            ],
          },
        })
      );
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, s }));
  });
  try {
    await page.goto(baseUrl);
    await expect(page.locator('#btnGameNight')).toBeVisible();
    await openLobbyMenu(page);
    await expect(page.locator('#btnLobbyAdmin')).toBeVisible();
    await page.click('#btnLobbyAdmin');
    // Picking something closes the menu behind it.
    await expect(page.locator('#lobbyMenuDropdown')).not.toHaveClass(/open/);
    await page.fill('#appDialogInput', ADMIN_PASSWORD);
    await page.click('#btnAppDialogConfirm');
    await expect(page.locator('#lobbyAdmin')).toBeVisible();
    // The page opens on Games; the pairing lives on its own tab now.
    await page.click('#tabAdminGameNight');
    await expect(page.locator('#adminGnStatus')).toContainText(`Paired with ${ISSUER}`);
    await expect(page.locator('#adminGnDetail')).toContainText('from the environment');

    await page.click('#btnAdminUnpair');
    await page.click('#btnAppDialogConfirm');
    await expect(page.locator('#adminGnStatus')).toContainText('Unpaired');
    await expect(page.locator('#btnAdminUnpair')).toBeHidden();

    await page.fill('#adminGnUrl', fakeGn.url);
    await page.fill('#adminGnAudience', AUDIENCE);
    await page.click('#btnAdminPair');
    await expect(page.locator('#adminGnStatus')).toContainText(`Paired with ${fakeGn.url}`);
    await expect(page.locator('#adminGnDetail')).toContainText('kid-from-page');

    await page.click('#btnAdminBack');
    await expect(page.locator('#btnGameNight')).toBeVisible();
    // A bad address is an error line, not a broken page.
    await openLobbyMenu(page);
    await page.click('#btnLobbyAdmin');
    await expect(page.locator('#lobbyAdmin')).toBeVisible();
    await page.click('#tabAdminGameNight');
    await page.fill('#adminGnUrl', 'http://127.0.0.1:1');
    await page.click('#btnAdminPair');
    await expect(page.locator('#adminGnStatus')).toContainText('Could not reach');

    // The admin password, changed from the same page, one tab along.
    await page.click('#tabAdminPassword');
    await page.fill('#adminPwNext', 'a-longer-password');
    await page.fill('#adminPwConfirm', 'a-longer-password');
    await page.click('#btnAdminSetPassword');
    await expect(page.locator('#adminPwStatus')).toContainText('Enter the current password');

    await page.fill('#adminPwCurrent', ADMIN_PASSWORD);
    await page.fill('#adminPwConfirm', 'mistyped-the-second-time');
    await page.click('#btnAdminSetPassword');
    await expect(page.locator('#adminPwStatus')).toContainText('do not match');

    await page.fill('#adminPwConfirm', 'a-longer-password');
    await page.click('#btnAdminSetPassword');
    await expect(page.locator('#adminPwStatus')).toContainText('Password changed');
    await expect(page.locator('#adminPwCurrent')).toHaveValue('');

    // The new one is what unlocks now. Reload for a fresh socket and prove it.
    await page.reload();
    await openLobbyMenu(page);
    await page.click('#btnLobbyAdmin');
    await page.fill('#appDialogInput', ADMIN_PASSWORD);
    await page.click('#btnAppDialogConfirm');
    await expect(page.locator('#appDialogBody')).toContainText('Wrong password');
    await page.click('#btnAppDialogConfirm');
    await openLobbyMenu(page);
    await page.click('#btnLobbyAdmin');
    await page.fill('#appDialogInput', 'a-longer-password');
    await page.click('#btnAppDialogConfirm');
    await expect(page.locator('#lobbyAdmin')).toBeVisible();
  } finally {
    await new Promise((r) => fakeGn.s.close(r));
  }
});

test('the menu shows the version, and only the version when nothing is configured', async ({
  page,
}) => {
  await page.goto(baseUrl);
  await openLobbyMenu(page);
  await expect(page.locator('#lobbyMenuVersion')).toHaveText(
    `FinalTable v${require('../package.json').version}`
  );
  // This server has both an admin password and a pairing, so both items are here.
  await expect(page.locator('#btnLobbyAdmin')).toBeVisible();

  // A click anywhere else closes it. A raw mouse click, because "anywhere
  // else" is a point on the page rather than any particular element.
  await page.mouse.click(20, 500);
  await expect(page.locator('#lobbyMenuDropdown')).not.toHaveClass(/open/);

  // And it stays in the corner while the page scrolls under it.
  const before = await page.locator('#lobbyMenuToggle').boundingBox();
  await page.evaluate(() => document.getElementById('loginScreen').scrollTo(0, 400));
  const after = await page.locator('#lobbyMenuToggle').boundingBox();
  expect(after.y).toBe(before.y);
});
