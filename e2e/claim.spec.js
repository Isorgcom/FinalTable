// claim.spec.js - a fresh server, claimed from the lobby in a browser.
//
// The server starts the way a new install does - no mail, no GameNight, no
// administrator - with one thing set: a claim token in its environment. The
// whole point is that whoever brought the box up can make it theirs from the
// sign-in card, with nothing read out of a log and nothing restarted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

const TOKEN = 'a-long-enough-claim-token';

let serverModule;
let baseUrl;
let tempDir;
const originalEnv = { ...process.env };
const repoRoot = path.join(__dirname, '..');

test.beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-claim-pw-'));
  process.env.SAVE_DIR = tempDir;
  process.env.DB_NAME = 'e2e-claim';
  process.env.HOST = '127.0.0.1';
  process.env.HTTP_RATE_LIMIT = '1000';
  process.env.CLAIM_TOKEN = TOKEN;
  delete process.env.PUBLIC_URL;
  delete process.env.SMTP_URL;
  delete process.env.MAIL_TRANSPORT;
  delete process.env.MAIL_FROM;
  delete process.env.GAMENIGHT_URL;
  delete process.env.GAMENIGHT_PUBLIC_KEY;
  delete process.env.ADMIN_PROMOTE;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(repoRoot) && !key.includes(`${path.sep}node_modules${path.sep}`)) {
      delete require.cache[key];
    }
  }
  serverModule = require('../server');
  await serverModule.startServer({ port: 0, host: '127.0.0.1', unrefServer: true });
  baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
  helpers.configure({ baseUrl, serverModule });
});

test.afterAll(async () => {
  serverModule.registry.stop();
  await new Promise((r) => serverModule.io.close(r));
  if (serverModule.server.listening) await new Promise((r) => serverModule.server.close(r));
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.env = originalEnv;
});

test('the server is claimed from the sign-in card, and the Admin page opens on Mail', async ({
  browser,
  page,
}) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(baseUrl);
  // The card is the claim: no sign-in button, no sign-up, and the fields a
  // first account needs.
  await expect(page.locator('#claimHead')).toBeVisible();
  await expect(page.locator('#claimHead')).toContainText('no administrator yet');
  await expect(page.locator('#btnClaimServer')).toBeVisible();
  await expect(page.locator('#btnSignIn')).toBeHidden();
  await expect(page.locator('#btnCreateAccount')).toBeHidden();
  await expect(page.locator('#accountEmailGroup')).toBeVisible();
  await expect(page.locator('#claimTokenGroup')).toBeVisible();
  await expect(page.locator('#accountWhy')).toBeHidden();

  await page.fill('#playerName', 'Owner');
  await page.fill('#accountPassword', 'a good password');
  await page.fill('#accountEmail', 'owner@example.com');

  // The wrong word is answered, and changes nothing.
  await page.fill('#claimToken', 'not it');
  await page.click('#btnClaimServer');
  await expect(page.locator('#accountStatus')).toContainText('not the claim token');
  await expect(page.locator('#claimHead')).toBeVisible();
  expect(serverModule.identity.adminCount()).toBe(0);

  // The right one makes the account, signs it in, and lands on Mail.
  await page.fill('#claimToken', TOKEN);
  await page.click('#btnClaimServer');
  await expect(page.locator('#identityStatus')).toContainText('Playing as');
  await expect(page.locator('#identityStatus')).toContainText('Owner');
  await expect(page.locator('#lobbyAdmin')).toBeVisible();
  await expect(page.locator('#adminPageMail')).toBeVisible();
  await expect(page.locator('#adminMailStatus')).toContainText('cannot send mail');
  expect(serverModule.identity.adminCount()).toBe(1);

  // Every other browser sees an ordinary sign-in card now, with the claim
  // gone and the reason the sign-up button is missing said in its place.
  const later = await browser.newContext();
  const arriving = await later.newPage();
  await arriving.goto(baseUrl);
  await expect(arriving.locator('#btnSignIn')).toBeVisible();
  await expect(arriving.locator('#claimHead')).toBeHidden();
  await expect(arriving.locator('#btnClaimServer')).toBeHidden();
  await expect(arriving.locator('#accountWhy')).toBeVisible();
  await expect(arriving.locator('#accountWhy')).not.toContainText('CLAIM_TOKEN');

  // And the owner can come back the ordinary way, mail or no mail.
  await arriving.fill('#playerName', 'Owner');
  await arriving.fill('#accountPassword', 'a good password');
  await arriving.click('#btnSignIn');
  await expect(arriving.locator('#identityStatus')).toContainText('Owner');
  await later.close();

  expect(errors).toEqual([]);
});
