import { test, expect } from '@playwright/test';

test.describe('WebCast Hub E2E Order', () => {
  test('Receiver first, then cast', async ({ browser }) => {
    const context = await browser.newContext();
    const senderPage = await context.newPage();
    await senderPage.goto('/');

    await senderPage.getByText('Generate New').click();
    await senderPage.waitForFunction(() => {
      const el = document.querySelector('input[placeholder="Enter Room Code"]') as HTMLInputElement;
      return el && el.value.length > 0;
    }, { timeout: 5000 });
    const roomCode = await senderPage.locator('input[placeholder="Enter Room Code"]').inputValue();

    const receiverPage = await context.newPage();
    await receiverPage.goto(`/receiver/${roomCode}`);
    
    // Wait for receiver to connect to signaling
    await receiverPage.waitForFunction(() => {
      return document.body.innerText.includes('SENDER PRESENT. REQUESTING STREAM...');
    }, { timeout: 10000 });

    // NOW click cast
    await senderPage.getByText('Cast Screen / Tab').click();

    // Check if receiver gets the stream
    const receiverVideo = receiverPage.locator('video').first();
    await expect(receiverVideo).toBeVisible({ timeout: 10000 });

    await receiverPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && video.videoWidth > 0;
    }, { timeout: 10000 });

    const width = await receiverVideo.evaluate((v: HTMLVideoElement) => v.videoWidth);
    expect(width).toBeGreaterThan(0);
  });
});
