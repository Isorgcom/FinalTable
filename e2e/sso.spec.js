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
const OPERATOR_PASSWORD = 'operator-secret';
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
  process.env.ADMIN_PASSWORD = OPERATOR_PASSWORD;
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
  await expect(page.locator('#btnGameNightSignOut')).toBeVisible();
  await expect(page.locator('#btnGameNight')).toBeHidden();
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
  await page.click('#btnGameNightSignOut');
  await expect(page.locator('#btnGameNight')).toBeVisible();
  await expect(page.locator('#playerName')).toHaveValue('');
  await expect(page.locator('#playerName')).not.toHaveAttribute('readonly', '');
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

// The Operator page: unlock with the admin password, see the pairing the
// environment seeded, unpair, then pair again against a GameNight stood up
// here, and watch the sign-in button follow.
test('the operator unpairs and re-pairs from the lobby', async ({ page }) => {
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
    await expect(page.locator('#btnOperator')).toBeVisible();
    await page.click('#btnOperator');
    await page.fill('#appDialogInput', OPERATOR_PASSWORD);
    await page.click('#btnAppDialogConfirm');
    await expect(page.locator('#lobbyOperator')).toBeVisible();
    await expect(page.locator('#opGnStatus')).toContainText(`Paired with ${ISSUER}`);
    await expect(page.locator('#opGnDetail')).toContainText('from the environment');

    await page.click('#btnOpUnpair');
    await page.click('#btnAppDialogConfirm');
    await expect(page.locator('#opGnStatus')).toContainText('Unpaired');
    await expect(page.locator('#btnOpUnpair')).toBeHidden();

    await page.fill('#opGnUrl', fakeGn.url);
    await page.fill('#opGnAudience', AUDIENCE);
    await page.click('#btnOpPair');
    await expect(page.locator('#opGnStatus')).toContainText(`Paired with ${fakeGn.url}`);
    await expect(page.locator('#opGnDetail')).toContainText('kid-from-page');

    await page.click('#btnOpBack');
    await expect(page.locator('#btnGameNight')).toBeVisible();
    // A bad address is an error line, not a broken page.
    await page.click('#btnOperator');
    await expect(page.locator('#lobbyOperator')).toBeVisible();
    await page.fill('#opGnUrl', 'http://127.0.0.1:1');
    await page.click('#btnOpPair');
    await expect(page.locator('#opGnStatus')).toContainText('Could not reach');

    // The operator password, changed from the same page.
    await page.fill('#opPwNext', 'a-longer-password');
    await page.fill('#opPwConfirm', 'a-longer-password');
    await page.click('#btnOpSetPassword');
    await expect(page.locator('#opPwStatus')).toContainText('Enter the current password');

    await page.fill('#opPwCurrent', OPERATOR_PASSWORD);
    await page.fill('#opPwConfirm', 'mistyped-the-second-time');
    await page.click('#btnOpSetPassword');
    await expect(page.locator('#opPwStatus')).toContainText('do not match');

    await page.fill('#opPwConfirm', 'a-longer-password');
    await page.click('#btnOpSetPassword');
    await expect(page.locator('#opPwStatus')).toContainText('Password changed');
    await expect(page.locator('#opPwCurrent')).toHaveValue('');

    // The new one is what unlocks now. Reload for a fresh socket and prove it.
    await page.reload();
    await page.click('#btnOperator');
    await page.fill('#appDialogInput', OPERATOR_PASSWORD);
    await page.click('#btnAppDialogConfirm');
    await expect(page.locator('#appDialogBody')).toContainText('Wrong password');
    await page.click('#btnAppDialogConfirm');
    await page.click('#btnOperator');
    await page.fill('#appDialogInput', 'a-longer-password');
    await page.click('#btnAppDialogConfirm');
    await expect(page.locator('#lobbyOperator')).toBeVisible();
  } finally {
    await new Promise((r) => fakeGn.s.close(r));
  }
});
