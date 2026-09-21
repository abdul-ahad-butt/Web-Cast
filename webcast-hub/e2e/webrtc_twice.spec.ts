import { test, expect } from '@playwright/test';

test.describe('WebCast Hub Double Connect', () => {
  test('Sender connects twice', async ({ context }) => {
    const senderPage = await context.newPage();
    
    // 1. Sender joins
    await senderPage.goto('/');

    await senderPage.getByText('Generate New').click();
    await senderPage.waitForFunction(() => {
      const el = document.querySelector('input[placeholder="Enter Room Code"]') as HTMLInputElement;
      return el && el.value.length > 0;
    }, { timeout: 5000 });
    const roomCode = await senderPage.locator('input[placeholder="Enter Room Code"]').inputValue();
    expect(roomCode).toBeTruthy();

    // TRICK: FORCE SENDER TO CONNECT TWICE
    await senderPage.evaluate(() => {
      window.dispatchEvent(new Event('pageshow', { persisted: true } as any));
    });
    // Wait a bit
    await senderPage.waitForTimeout(1000);

    // 2. Receiver joins
    const receiverPage = await context.newPage();
    await receiverPage.goto(`/receiver/${roomCode}`);

    // 3. Wait for receiver to show sender present
    await expect(receiverPage.getByText('Sender Connected', { exact: false }).or(receiverPage.getByText('Awaiting Sender', { exact: false }))).toBeVisible({ timeout: 10000 });

    // 4. Sender casts
    await senderPage.getByText('Cast Screen / Tab').click();
    await senderPage.waitForTimeout(500);

    // 5. Verify receiver gets it
    const video = receiverPage.locator('video');
    await expect(video).toHaveJSProperty('readyState', 4, { timeout: 15000 });
  });
});
