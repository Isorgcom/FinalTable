// __tests__/load-env.test.js - the .env loader, and the ways a file can refuse
// to be read. A deployment that bind-mounts the tree into the container hands
// the process an .env owned by somebody else at mode 600, and that must not be
// the thing that stops the server booting.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLocalEnv } = require('../server/load-env');

describe('loadLocalEnv', () => {
  let dir;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-env-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  test('reads keys, strips quotes, and leaves an existing variable alone', () => {
    fs.writeFileSync(
      path.join(dir, '.env'),
      ['# a comment', '', 'PLAIN=one', 'QUOTED="two"', "SINGLE='three'", 'ALREADY=fromfile'].join(
        '\n'
      )
    );
    process.env.ALREADY = 'fromenv';
    delete process.env.PLAIN;
    loadLocalEnv(dir);
    expect(process.env.PLAIN).toBe('one');
    expect(process.env.QUOTED).toBe('two');
    expect(process.env.SINGLE).toBe('three');
    expect(process.env.ALREADY).toBe('fromenv');
  });

  test('.env.local is read after .env and does not overwrite it', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'ONLY=first');
    fs.writeFileSync(path.join(dir, '.env.local'), 'ONLY=second\nEXTRA=yes');
    delete process.env.ONLY;
    delete process.env.EXTRA;
    loadLocalEnv(dir);
    expect(process.env.ONLY).toBe('first');
    expect(process.env.EXTRA).toBe('yes');
  });

  test('no file at all is fine', () => {
    expect(() => loadLocalEnv(dir)).not.toThrow();
  });

  // Running as root defeats file permissions, so the check is skipped there
  // rather than asserted falsely.
  const canTestPerms = typeof process.getuid === 'function' && process.getuid() !== 0;
  (canTestPerms ? test : test.skip)('an unreadable .env is skipped, not fatal', () => {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'SECRET=nope');
    fs.chmodSync(file, 0o000);
    delete process.env.SECRET;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => loadLocalEnv(dir)).not.toThrow();
      expect(process.env.SECRET).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    } finally {
      warn.mockRestore();
      fs.chmodSync(file, 0o600);
    }
  });
});
