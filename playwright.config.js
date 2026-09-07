/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: './e2e',
  // Every table test now seats two browser contexts before it can deal, since
  // a tournament of one never starts.
  timeout: 45000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    headless: true,
  },
};
