// chat.spec.js - talking to the people you are playing against, in a real
// browser: the waiting room before the cards, the table after them, what a
// reload gets back, and the host's mute.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-chat-pw-'));
  process.env.SAVE_DIR = tempDir;
  process.env.HOST = '127.0.0.1';
  process.env.AUTO_TURN_DELAY_MS = '40';
  process.env.TOURNAMENT_SWEEP_MS = '100';
  process.env.STREET_PAUSE_MS = '400';
  process.env.HAND_PAUSE_MS = '400';
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

async function identifyAs(page, name) {
  await page.goto(baseUrl);
  await page.fill('#playerName', name);
  await page.locator('#playerName').blur();
  await expect(page.locator('#identityStatus')).toContainText(`Playing as ${name}`);
}

async function hostCreates(page, name, { tableSize = null } = {}) {
  await page.click('#btnCreateTournament');
  await expect(page.locator('#lobbyCreate')).toBeVisible();
  await page.fill('#tName', name);
  if (tableSize) await page.selectOption('#tTableSize', String(tableSize));
  await page.click('#tStartQuick button[data-min="15"]');
  await page.click('#btnCreateSubmit');
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  return (await page.locator('#wrCode').textContent()).trim();
}

async function guestJoins(browser, code, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${baseUrl}/?t=${code.toLowerCase()}`);
  await page.fill('#playerName', name);
  await page.locator('#playerName').blur();
  await expect(page.locator('#lobbyWaiting')).toBeVisible();
  return { context, page, errors };
}

test('the waiting room carries the conversation before there is a table', async ({
  browser,
  page,
}) => {
  await identifyAs(page, 'Host');
  const code = await hostCreates(page, 'Chatty');
  const guest = await guestJoins(browser, code, 'Guest');

  await page.fill('#wrChatInput', 'evening all');
  await page.press('#wrChatInput', 'Enter');

  // Both see it, attributed, and the box empties.
  for (const p of [page, guest.page]) {
    await expect(p.locator('#wrChatLog .chat-line')).toHaveCount(1);
    await expect(p.locator('#wrChatLog .chat-who')).toHaveText('Host');
    await expect(p.locator('#wrChatLog .chat-text')).toHaveText('evening all');
  }
  await expect(page.locator('#wrChatInput')).toHaveValue('');

  await guest.page.fill('#wrChatInput', 'evening');
  await guest.page.press('#wrChatInput', 'Enter');
  await expect(page.locator('#wrChatLog .chat-line')).toHaveCount(2);

  expect(guest.errors).toEqual([]);
  await guest.context.close();
});

test('markup typed into chat stays text', async ({ browser, page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  let dialogs = 0;
  page.on('dialog', async (d) => {
    dialogs++;
    await d.dismiss();
  });
  await identifyAs(page, 'Host');
  const code = await hostCreates(page, 'Injection');
  const guest = await guestJoins(browser, code, 'Guest');

  const payload = '<img src=x onerror=alert(1)>';
  await guest.page.fill('#wrChatInput', payload);
  await guest.page.press('#wrChatInput', 'Enter');

  // The characters survive - "<3" has to work - but they are never markup.
  await expect(page.locator('#wrChatLog .chat-text')).toHaveText(payload);
  expect(await page.locator('#wrChatLog img').count()).toBe(0);
  expect(dialogs).toBe(0);
  expect(errors).toEqual([]);
  expect(guest.errors).toEqual([]);
  await guest.context.close();
});

test('the host can mute someone, and they are told why', async ({ browser, page }) => {
  await identifyAs(page, 'Host');
  const code = await hostCreates(page, 'Quiet please');
  const guest = await guestJoins(browser, code, 'Guest');

  // The mute control belongs to the host and nobody else.
  await expect(page.locator('#wrRoster .wr-mute')).toHaveCount(1);
  await expect(guest.page.locator('#wrRoster .wr-mute')).toHaveCount(0);

  await page.click('#wrRoster .wr-mute');
  await expect(guest.page.locator('#wrChatInput')).toBeDisabled();
  await expect(guest.page.locator('#wrChatNote')).toContainText('muted');

  // And back again.
  await page.click('#wrRoster .wr-mute');
  await expect(guest.page.locator('#wrChatInput')).toBeEnabled();
  expect(guest.errors).toEqual([]);
  await guest.context.close();
});

test('chat follows you to the table, and a reload gets it back', async ({ browser, page }) => {
  await identifyAs(page, 'Host');
  const code = await hostCreates(page, 'To the felt');
  const guest = await guestJoins(browser, code, 'Guest');

  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });

  // The composer that has been an empty reserved div since the table redesign.
  await expect(page.locator('#panelComposer')).toBeVisible();
  await expect(page.locator('#chatInput')).toBeEnabled();

  await page.fill('#chatInput', 'nice table');
  await page.press('#chatInput', 'Enter');
  await expect(
    guest.page.locator('#panelChatBody .log-entry[data-kind="chat"] .chat-text')
  ).toHaveText('nice table');
  // The ticker over the felt carries the last line with its author.
  await expect(guest.page.locator('#logLast')).toContainText('Host: nice table');

  await page.fill('#chatInput', 'second line');
  await page.press('#chatInput', 'Enter');
  await expect(guest.page.locator('#panelChatBody .log-entry[data-kind="chat"]')).toHaveCount(2);

  // A reload holds no log at all, so the server has to send the backlog - and
  // send it once, not once per line already drawn.
  await guest.page.reload();
  await expect(guest.page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.page.locator('#panelChatBody .log-entry[data-kind="chat"]')).toHaveCount(2, {
    timeout: 10000,
  });
  await expect(
    guest.page.locator('#panelChatBody .log-entry[data-kind="chat"] .chat-text').first()
  ).toHaveText('nice table');

  await guest.context.close();
});

test('a line surfaces over the head of whoever said it, then goes', async ({ browser, page }) => {
  await identifyAs(page, 'Host');
  const code = await hostCreates(page, 'Bubbles');
  const guest = await guestJoins(browser, code, 'Guest');
  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });

  // Wait for the chairs to exist before saying anything. A bubble is hung on a
  // seat, so a line that lands in the moment before the table is drawn has
  // nowhere to go - the panel still gets it, but there is nothing to assert.
  const hostUid = await page.evaluate(() => window.__identity.uid);
  await expect(guest.page.locator(`#playerSeats .player-seat[data-uid="${hostUid}"]`)).toHaveCount(
    1,
    { timeout: 10000 }
  );

  await page.fill('#chatInput', 'over my head');
  await page.press('#chatInput', 'Enter');

  // On the guest's screen it belongs to the host's chair, and to no other.
  const bubble = guest.page.locator(
    `#playerSeats .player-seat[data-uid="${hostUid}"] .seat-bubble`
  );
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveText('over my head');
  await expect(guest.page.locator('#playerSeats .seat-bubble:visible')).toHaveCount(1);

  // It is decoration, so it must never eat a click meant for the chair.
  expect(await bubble.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  // A paragraph stops at two lines, and stops cleanly. The clamp has to sit on
  // an element with no padding of its own, or overflow: hidden cuts at the
  // padding edge and hands back a sliver of the line it just hid.
  await page.fill('#chatInput', 'that river was absolutely disgusting and I want everyone to know');
  await page.press('#chatInput', 'Enter');
  await expect(bubble).toContainText('that river');
  const clamp = await bubble.evaluate((el) => {
    const text = el.querySelector('.seat-bubble-text');
    const line = parseFloat(getComputedStyle(text).lineHeight);
    return {
      lines: text.getBoundingClientRect().height / line,
      overflows: text.scrollHeight > text.clientHeight,
    };
  });
  expect(clamp.lines).toBeLessThanOrEqual(2.05);
  // There is more text than fits, which is what makes the cut worth checking.
  expect(clamp.overflows).toBe(true);

  // A second line replaces the first rather than stacking up.
  await page.fill('#chatInput', 'and again');
  await page.press('#chatInput', 'Enter');
  await expect(bubble).toHaveText('and again');
  await expect(guest.page.locator('#playerSeats .seat-bubble:visible')).toHaveCount(1);

  // And it clears itself without anyone doing anything.
  await expect(bubble).toBeHidden({ timeout: 12000 });
  // The panel still has all three: the bubble is a glance, not the record.
  await expect(guest.page.locator('#panelChatBody .log-entry[data-kind="chat"]')).toHaveCount(3);

  expect(guest.errors).toEqual([]);
  await guest.context.close();
});

test('on a phone the composer sits above the keyboard, at a size iOS will not zoom', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await identifyAs(page, 'Pocket');
  const code = await hostCreates(page, 'Phone chat');
  const guest = await guestJoins(browser, code, 'Rail');
  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });

  await page.click('#btnPanelToggle');
  await expect(page.locator('#sidePanel')).toHaveClass(/open/);
  await page.click('#tabChat');

  const box = await page.locator('#chatInput').boundingBox();
  expect(box).not.toBeNull();
  expect(box.y + box.height).toBeLessThanOrEqual(844);

  // Under 16px, iOS zooms the page in on focus and never zooms back out.
  const fontSize = await page
    .locator('#chatInput')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);

  // Escape gives up the box before it closes the drawer, so a thumb typing
  // does not lose the panel on the first press.
  await page.locator('#chatInput').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidePanel')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidePanel')).not.toHaveClass(/open/);

  await guest.context.close();
  await context.close();
});

// A reaction is a chat line with the words taken out: same room, same chair,
// and gone on its own. The strip lives with the pre-action controls, so it is
// there for the seat whose turn it is not, which is the seat with something to
// react to.
test('a reaction floats over the chair of whoever threw it, then goes', async ({
  browser,
  page,
}) => {
  await identifyAs(page, 'Host');
  const code = await hostCreates(page, 'Reacts');
  const guest = await guestJoins(browser, code, 'Guest');
  await page.click('#btnStartNow');
  await expect(page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  await expect(guest.page.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });

  // Whichever of the two is not on turn has the strip; the other has the bar.
  // Decided from the state, not the panel, and only once both have a state.
  const running = (p) =>
    p.waitForFunction(
      () => typeof gameState !== 'undefined' && gameState && gameState.isRunning,
      null,
      {
        timeout: 10000,
      }
    );
  await Promise.all([running(page), running(guest.page)]);
  const hostOnTurn = await page.evaluate(() => gameState.isMyTurn);
  const thrower = hostOnTurn ? guest.page : page;
  const watcher = hostOnTurn ? page : guest.page;
  const throwerUid = await thrower.evaluate(() => window.__identity.uid);
  await expect(watcher.locator(`#playerSeats .player-seat[data-uid="${throwerUid}"]`)).toHaveCount(
    1,
    { timeout: 10000 }
  );

  const strip = thrower.locator('#reactionRow');
  await expect(strip).toBeVisible();
  const buttons = strip.locator('.reaction-btn');
  expect(await buttons.count()).toBeGreaterThanOrEqual(4);
  await expect(buttons.first()).toBeEnabled();
  const emoji = await buttons.first().textContent();
  await buttons.first().click();

  // Over the thrower's chair on the other screen, and on their own.
  const onWatcher = watcher.locator(
    `#playerSeats .player-seat[data-uid="${throwerUid}"] .seat-reaction`
  );
  await expect(onWatcher).toHaveClass(/is-live/);
  await expect(onWatcher).toHaveText(emoji.trim());
  await expect(
    thrower.locator(`#playerSeats .player-seat[data-uid="${throwerUid}"] .seat-reaction`)
  ).toHaveClass(/is-live/);
  // Decoration, never in the way of a click.
  expect(await onWatcher.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  // And it is not a line in the log.
  await expect(watcher.locator('#panelChatBody .chat-line')).toHaveCount(0);

  // Gone on its own, well inside a street.
  await expect(onWatcher).not.toHaveClass(/is-live/, { timeout: 5000 });

  expect(guest.errors).toEqual([]);
  await guest.context.close();
});

// Two tables, and the host at one of them. The strip in the host's Chat tab
// reads and reaches the other; an announcement reaches both and the felt.
test('the host reaches every table', async ({ browser, page }) => {
  await identifyAs(page, 'Host');
  const code = await hostCreates(page, 'Two Tables', { tableSize: 2 });
  const guests = [];
  for (const name of ['Ann', 'Bob', 'Cat']) guests.push(await guestJoins(browser, code, name));
  await page.click('#btnStartNow');
  const pages = [page, ...guests.map((g) => g.page)];
  for (const p of pages) {
    await expect(p.locator('#gameScreen')).toHaveClass(/active/, { timeout: 10000 });
  }
  const tableOf = (p) => p.evaluate(() => window.mttField && window.mttField.myTable);
  await expect.poll(() => tableOf(page), { timeout: 10000 }).toBeTruthy();
  const hostTable = await tableOf(page);
  const far = [];
  const near = [];
  for (const g of guests) {
    await expect.poll(() => tableOf(g.page), { timeout: 10000 }).toBeTruthy();
    ((await tableOf(g.page)) === hostTable ? near : far).push(g);
  }
  expect(near).toHaveLength(1);
  expect(far).toHaveLength(2);
  const farTable = await tableOf(far[0].page);

  // The strip is the host's alone: All, then a pill per table, theirs in force.
  const strip = page.locator('#chatTables');
  await expect(strip).toBeVisible();
  await expect(strip.locator('button')).toHaveCount(3);
  await expect(strip.locator('button.active')).toHaveAttribute('data-view', `t${hostTable}`);
  await expect(page.locator('#chatInput')).toHaveAttribute('placeholder', 'Message your table');
  for (const g of guests) await expect(g.page.locator('#chatTables')).toBeHidden();

  // An announcement: every table hears it, badged, and it flashes on the felt.
  await strip.locator('button[data-view="all"]').click();
  await expect(page.locator('#chatInput')).toHaveAttribute(
    'placeholder',
    'Announce to every table'
  );
  await page.fill('#chatInput', 'break in five');
  await page.press('#chatInput', 'Enter');
  for (const g of guests) {
    const line = g.page.locator('#panelChatBody .chat-line.host', { hasText: 'break in five' });
    await expect(line).toHaveCount(1);
    await expect(line.locator('.chat-badge')).toHaveText('host');
    await expect(line.locator('.chat-scope')).toHaveText('to all tables');
    await expect(g.page.locator('#tbHostNote')).toBeVisible();
    await expect(g.page.locator('#tbHostNote')).toContainText('break in five');
  }
  // Once on the host's own panel, though the host holds both rooms.
  await expect(
    page.locator('#panelChatBody .chat-line.host', { hasText: 'break in five' })
  ).toHaveCount(1);

  // A line said at the far table reaches the host, chipped, and not the near guest.
  await far[0].page.fill('#chatInput', 'anyone here?');
  await far[0].page.press('#chatInput', 'Enter');
  const heard = page.locator('#panelChatBody .chat-line', { hasText: 'anyone here?' });
  await expect(heard).toHaveCount(1);
  await expect(heard.locator('.chat-table-chip')).toHaveText(`T${farTable}`);
  await expect(
    far[1].page.locator('#panelChatBody .chat-line', { hasText: 'anyone here?' })
  ).toHaveCount(1);
  await expect(
    near[0].page.locator('#panelChatBody .chat-line', { hasText: 'anyone here?' })
  ).toHaveCount(0);

  // Speaking to the far table alone: they hear it, the near guest does not.
  await strip.locator(`button[data-view="t${farTable}"]`).click();
  await expect(page.locator('#chatInput')).toHaveAttribute(
    'placeholder',
    `Message table ${farTable}`
  );
  await page.fill('#chatInput', 'on my way over');
  await page.press('#chatInput', 'Enter');
  for (const g of far) {
    await expect(
      g.page.locator('#panelChatBody .chat-line.host', { hasText: 'on my way over' })
    ).toHaveCount(1);
  }
  await expect(
    near[0].page.locator('#panelChatBody .chat-line', { hasText: 'on my way over' })
  ).toHaveCount(0);
  // Not an announcement, so nothing on the felt for it.
  await expect(far[0].page.locator('#tbHostNote')).not.toContainText('on my way over');
  // In the far table's view the announcement, which is every table's, still shows.
  await expect(
    page.locator('#panelChatBody .chat-line.host', { hasText: 'break in five' })
  ).toBeVisible();

  // The felt note clears itself.
  await expect(far[0].page.locator('#tbHostNote')).toBeHidden({ timeout: 12000 });
  for (const g of guests) expect(g.errors).toEqual([]);
  for (const g of guests) await g.context.close();
});
