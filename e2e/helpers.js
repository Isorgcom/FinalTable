// helpers.js - the few things every browser spec does before it can test
// anything: become somebody, and get a game started.
//
// Not a spec itself. Playwright collects `*.spec.js` and `*.test.js`, so this
// sits in the same directory without being run as one.
//
// It exists because establishing an identity is about to change shape, and it
// was written out by hand in ninety-odd places: four copies of the same helper
// across four files and twenty-two more inlined in tournament.spec.js. One
// function, and the change is one edit rather than ninety.
//
// Each spec boots its own server on its own port with its own database, so
// there is nothing to import here - `configure()` is called from the spec's
// beforeAll once it has one.

const { expect } = require('@playwright/test');

let baseUrl = null;
let serverModule = null;

function configure(options = {}) {
  if (options.baseUrl) baseUrl = options.baseUrl;
  if (options.serverModule) serverModule = options.serverModule;
}

function urlFor({ join = null, watch = null } = {}) {
  if (join) return `${baseUrl}/?t=${String(join).toLowerCase()}`;
  if (watch) return `${baseUrl}/?w=${watch}`;
  return baseUrl;
}

// Become somebody, on a page that has not been anybody yet.
//
// `join` and `watch` carry a code in the query string, which is the arriving
// -by-link case: the client holds the code, identifies, and lands in the game
// rather than the lobby. The caller asserts where it landed, because that is
// what those tests are about.
async function signInAs(page, name, { join = null, watch = null } = {}) {
  await page.goto(urlFor({ join, watch }));
  await page.fill('#playerName', name);
  await page.locator('#playerName').blur();
  if (!join && !watch) {
    await expect(page.locator('#identityStatus')).toContainText(`Playing as ${name}`);
  }
}

// A second browser, signed in as somebody else, arriving on a join link. The
// context is returned rather than closed: the caller owns it, because only the
// caller knows when the test is done with it.
async function openAs(browser, name, { join = null, watch = null } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await signInAs(page, name, { join, watch });
  return { context, page, errors };
}

// The create form, filled in and submitted. Answers with the join code, which
// is what every caller wants next.
async function createTournament(
  page,
  { name = 'Friday Night', minutes = 15, bots = false, visibility = null, tableSize = null } = {}
) {
  await page.click('#btnCreateTournament');
  await expect(page.locator('#lobbyCreate')).toBeVisible();
  await page.fill('#tName', name);
  // Private is the default; a test that wants a listed game says so.
  if (visibility) await page.click(`#tVisibility button[data-vis="${visibility}"]`);
  if (tableSize) await page.selectOption('#tTableSize', String(tableSize));
  await page.click(`#tStartQuick button[data-min="${minutes}"]`);
  if (bots) await page.check('#tBots');
  await page.click('#btnCreateSubmit');
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  const code = (await page.locator('#wrCode').textContent()).trim();
  expect(code).toMatch(/^[A-Z2-9]{5}$/);
  return code;
}

// A dealt table with the page's own seat live and an opponent sitting out.
//
// The opponent sits out the moment it is seated. Left as a live human it would
// never act, and the viewer would wait out its whole 25-second clock before
// the action came round; sitting out, it checks or folds on its own and the
// turn reaches the viewer within a hand.
//
// The guest's context comes back for the caller to close.
async function seatAtTournamentTable(page, name, { browser }) {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await signInAs(page, name);
  const code = await createTournament(page, { name: `${name} table` });

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await signInAs(guest, `${name}Foe`, { join: code });
  await expect(guest.locator('#lobbyWaiting')).toBeVisible();

  // Enabled only once the guest's registration has reached the host.
  await expect(page.locator('#btnStartNow')).toBeEnabled();
  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 15000 });
  await expect(guest.locator('#gameScreen')).toHaveClass(/active/, { timeout: 15000 });
  // The game screen opens on tournamentJoined, before the first gameState
  // arrives; clicking sit-out any earlier is a no-op because the client has no
  // seat to toggle yet.
  await expect(guest.locator('#playerSeats .player-seat:not(.seat-empty)')).toHaveCount(2);
  await guest.click('#btnAutoPlay');
  await expect(guest.locator('#seatBanner')).toBeVisible({ timeout: 10000 });
  return { pageErrors, guestContext, guest, code };
}

module.exports = {
  configure,
  signInAs,
  openAs,
  createTournament,
  seatAtTournamentTable,
  get baseUrl() {
    return baseUrl;
  },
  get serverModule() {
    return serverModule;
  },
};
