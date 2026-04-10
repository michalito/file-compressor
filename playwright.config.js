const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5010',
    trace: 'on-first-retry',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: 'python3 tests/e2e/run_test_server.py',
    url: 'http://127.0.0.1:5010/login',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
