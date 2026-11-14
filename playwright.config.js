import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: true,
  timeout: 75000,
  workers: 2,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1050 }, trace: 'retain-on-failure' }
});
