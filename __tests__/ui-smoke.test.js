const fs = require('fs');
const os = require('os');
const path = require('path');

jest.setTimeout(15000);

describe('UI smoke', () => {
  const originalEnv = { ...process.env };
  let serverModule;
  let baseUrl;
  let tempDir;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finaltable-ui-'));
    process.env.SAVE_DIR = tempDir;
    process.env.HOST = '127.0.0.1';
    jest.resetModules();
    serverModule = require('../server');
    await serverModule.startServer({
      port: 0,
      host: '127.0.0.1',
      unrefServer: true,
    });
    baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => serverModule.io.close(resolve));
    if (serverModule.server.listening) {
      await new Promise((resolve) => serverModule.server.close(resolve));
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  // The page carries the ?v= stamp for every script and stylesheet, so a stale
  // copy of it pins the browser to the previous build and deploying changes
  // nothing the player can see. It has to revalidate.
  test('the page itself is never served stale', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.headers.get('cache-control')).toMatch(/no-cache|max-age=0/);
    expect(response.headers.get('etag')).toBeTruthy();
  });

  // Every script the page loads has to be in the list the version hash is
  // computed from, or editing that file never busts the cache.
  test('every script the page loads is one the asset version watches', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const { ASSET_VERSION_FILES } = require('../server/asset-version');
    const referenced = [...html.matchAll(/src="\/(js\/[^?"]+)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(ASSET_VERSION_FILES).toContain('public/' + file);
    }
  });

  test('served lobby html contains the tournament lobby shell and rendered asset version', async () => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('id="identityCard"');
    expect(html).toContain('id="sectionRegistering"');
    expect(html).toContain('id="btnCreateTournament"');
    expect(html).toContain('Create a tournament');
    expect(html).toMatch(/\/js\/lobby\.js\?v=[a-f0-9]{10}/);
    expect(html).toMatch(/\/js\/socket-client\.js\?v=[a-f0-9]{10}/);
    expect(html).not.toContain('__ASSET_VERSION__');
    expect(html).toMatch(/\/css\/style\.css\?v=[a-f0-9]{10}/);
    expect(html).toMatch(/\/js\/app-state\.js\?v=[a-f0-9]{10}/);
  });

  test('api status stays reachable alongside the rendered lobby shell', async () => {
    const response = await fetch(`${baseUrl}/api/status`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ activeTournaments: 0 });
  });
});
