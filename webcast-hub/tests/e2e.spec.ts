import { test, expect } from '@playwright/test';

// Use a shared mock for the worker API if it's not running, or we can just expect the app to load
// Since the frontend relies on the worker for API, we should configure the frontend to hit the local worker if we want full E2E.
// The frontend has VITE_API_URL or defaults to wss://webcast-hub.abdulahadbutt420.workers.dev
// For basic UI testing, we can just verify the UI renders correctly.

test('homepage has expected title and buttons', async ({ page }) => {
  await page.goto('/');

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/WebCast Hub/);

  // Expect the main UI cards to be visible
  await expect(page.getByText('Cast Screen / Tab')).toBeVisible();
  await expect(page.getByText('Cast Local Media')).toBeVisible();
  await expect(page.getByText('Connect Receiver')).toBeVisible();
});

test('can navigate to receiver page', async ({ page }) => {
  await page.goto('/receiver/TEST');
  
  // The receiver should show "Connecting to signaling server..." or "Waiting for sender..."
  await expect(page.getByText(/Connecting to signaling server\.\.\.|Waiting for sender\.\.\./)).toBeVisible();
});
