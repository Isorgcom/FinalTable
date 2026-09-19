// admin-mail.spec.js - setting up mail from the Admin page, in a browser.
//
// The server starts with nothing configured, which is what a new install looks
// like: no mail, no GameNight, and a sign-in screen that says so. The whole
// point of the page is that somebody can fix that from here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const helpers = require('./helpers');

const SECRET = 'correct-horse-battery';

let serverModule;
let baseUrl;
let tempDir;
const originalEnv = { ...process.env };
const repoRoot = path.join(__dirname, '..');

test.beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-mail-pw-'));
  process.env.SAVE_DIR = tempDir;
  // A database of its own per spec file, as every other one here has.
  process.env.DB_NAME = 'e2e-mail';
  process.env.HOST = '127.0.0.1';
  process.env.HTTP_RATE_LIMIT = '1000';
  // Nothing set up: this is the server somebody has just brought up.
  delete process.env.PUBLIC_URL;
  delete process.env.SMTP_URL;
  delete process.env.MAIL_TRANSPORT;
  delete process.env.MAIL_FROM;
  delete process.env.GAMENIGHT_URL;
  delete process.env.GAMENIGHT_PUBLIC_KEY;
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

async function openMail(page, name) {
  await helpers.signInAs(page, name, { admin: true });
  await page.click('#lobbyMenuToggle');
  await page.click('#btnLobbyAdmin');
  await expect(page.locator('#lobbyAdmin')).toBeVisible();
  await page.click('#tabAdminMail');
  await expect(page.locator('#adminPageMail')).toBeVisible();
}

test('mail is set up from the page, and every browser hears about it', async ({
  browser,
  page,
}) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  // Somebody standing at the sign-in screen while it is still broken.
  const onlooker = await browser.newContext();
  const waiting = await onlooker.newPage();
  await waiting.goto(baseUrl);
  await expect(waiting.locator('#accountWhy')).toBeVisible();
  await expect(waiting.locator('#accountWhy')).toContainText('no way to sign anybody in');

  await openMail(page, 'MailBoss');
  await expect(page.locator('#adminMailStatus')).toContainText('cannot send mail');

  // The log transport, which is what a server with no mail host can still do.
  await page.fill('#adminMailPublicUrl', baseUrl);
  await page.selectOption('#adminMailMode', 'log');
  await page.click('#btnAdminMailSave');
  await expect(page.locator('#adminMailStatus')).toContainText('Saved');

  // And the screen the onlooker is looking at fixes itself, with nobody
  // reloading anything.
  await expect(waiting.locator('#accountWhy')).toBeHidden({ timeout: 10000 });
  await expect(waiting.locator('#btnCreateAccount')).toBeVisible();

  await onlooker.close();
  expect(errors).toEqual([]);
});

test('a mail server that is not there is reported in its own words', async ({ page }) => {
  await openMail(page, 'Prodder');
  await page.fill('#adminMailPublicUrl', baseUrl);
  await page.selectOption('#adminMailMode', 'smtp');
  await expect(page.locator('#adminMailServer')).toBeVisible();
  await page.fill('#adminMailHost', '127.0.0.1');
  await page.fill('#adminMailPort', '1');
  await page.click('#btnAdminMailTest');
  await expect(page.locator('#adminMailStatus')).toContainText(/ECONNREFUSED|connect|refused/i, {
    timeout: 15000,
  });
});

// The password is the one thing this server will not hand back.
test('the password is typed once and never comes back', async ({ page }) => {
  await openMail(page, 'Keeper');
  await page.fill('#adminMailPublicUrl', baseUrl);
  await page.selectOption('#adminMailMode', 'smtp');
  await page.fill('#adminMailHost', 'smtp.example.com');
  await page.fill('#adminMailPort', '465');
  await page.fill('#adminMailUser', 'postie');
  await page.fill('#adminMailPass', SECRET);
  await page.click('#btnAdminMailSave');
  await expect(page.locator('#adminMailStatus')).toContainText('Saved');

  // Cleared from the box the moment it is saved, and the page says one is
  // stored rather than showing it.
  await expect(page.locator('#adminMailPass')).toHaveValue('');
  await expect(page.locator('#adminMailDetail')).toContainText('password  stored');

  // Not in the page, and not in anything the page was told.
  expect(await page.content()).not.toContain(SECRET);
  const known = await page.evaluate(() => JSON.stringify(window.__serverInfo || {}));
  expect(known).not.toContain(SECRET);

  // Still there after a reload, still not shown.
  await page.reload();
  await page.click('#lobbyMenuToggle');
  await page.click('#btnLobbyAdmin');
  await page.click('#tabAdminMail');
  await expect(page.locator('#adminMailHost')).toHaveValue('smtp.example.com');
  await expect(page.locator('#adminMailPass')).toHaveValue('');
  await expect(page.locator('#adminMailDetail')).toContainText('password  stored');
  expect(await page.content()).not.toContain(SECRET);
});
