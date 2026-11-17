import { defineConfig } from '@playwright/test';

const port = 8790;
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}`, channel: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    // Runs the production build against a throwaway database.
    // Many workshops are created per minute here, far beyond the production rate limits.
    command: `RATE_LIMIT_SCALE=100 PORT=${port} DATA_DIR=./data/e2e-${Date.now()} node --disable-warning=ExperimentalWarning dist/server/index.js`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
