import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Run sequentially to avoid cross-test interference on the worker
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
    video: 'off',
    channel: 'chrome', // Use Chrome
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream', 
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--autoplay-policy=no-user-gesture-required'
      ]
    }
  },
});
