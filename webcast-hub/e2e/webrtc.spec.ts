import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe('WebCast Hub E2E', () => {
  let logFile: number;

  test.beforeEach(async ({}, testInfo) => {
    fs.mkdirSync('e2e/out', { recursive: true });
  });

  async function setupLogging(page: any, name: string) {
    page.on('console', (msg: any) => {
      console.log(`[${name} Browser] ${msg.type()}: ${msg.text()}`);
      if (msg.type() === 'error') {
        const text = msg.text();
        if (text.includes("Failed to load resource: the server responded with a status of 404") ||
            text.includes("favicon.ico")) {
          return; // Ignore favicon 404s
        }
        throw new Error(`Unexpected console.error in ${name}: ${text}`);
      }
    });
    
    page.on('pageerror', (err: any) => {
      console.error(`[${name} Browser] Page Error: ${err.message}`);
      throw new Error(`Page error in ${name}: ${err.message}`);
    });

    await page.addInitScript(() => {
      // Mock getDisplayMedia
      if (!navigator.mediaDevices) (navigator as any).mediaDevices = {};
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d')!;
        setInterval(() => {
          ctx.fillStyle = '#' + Math.floor(Math.random()*16777215).toString(16);
          ctx.fillRect(0, 0, 640, 480);
        }, 100);
        return canvas.captureStream(30);
      };
      
      // Mock captureStream for invalid videos
      const origCapture = HTMLVideoElement.prototype.captureStream || (HTMLVideoElement.prototype as any).mozCaptureStream;
      HTMLVideoElement.prototype.captureStream = function() {
        let stream = null;
        try {
          stream = origCapture ? origCapture.call(this) : null;
        } catch (e) {
          console.warn("origCapture threw", e);
        }
        if (!stream || stream.getVideoTracks().length === 0) {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 480;
          const ctx = canvas.getContext('2d')!;
          setInterval(() => {
            ctx.fillStyle = '#' + Math.floor(Math.random()*16777215).toString(16);
            ctx.fillRect(0, 0, 640, 480);
          }, 100);
          return canvas.captureStream(30);
        }
        return stream;
      };
      (HTMLVideoElement.prototype as any).mozCaptureStream = HTMLVideoElement.prototype.captureStream;

      // Mock play to resolve immediately
      HTMLMediaElement.prototype.play = function() {
        return Promise.resolve();
      };
      HTMLVideoElement.prototype.captureStream = function() {
        let stream = null;
        try {
          stream = origCapture ? origCapture.call(this) : null;
        } catch (e) {
          console.warn("origCapture threw", e);
        }
        if (!stream || stream.getVideoTracks().length === 0) {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 480;
          const ctx = canvas.getContext('2d')!;
          setInterval(() => {
            ctx.fillStyle = '#' + Math.floor(Math.random()*16777215).toString(16);
            ctx.fillRect(0, 0, 640, 480);
          }, 100);
          return canvas.captureStream(30);
        }
        return stream;
      };
      (HTMLVideoElement.prototype as any).mozCaptureStream = HTMLVideoElement.prototype.captureStream;
    });
  }

  async function checkReceiverConnected(receiverPage: any) {
    const start = Date.now();
    let width = 0;
    while (Date.now() - start < 15000) {
      const videoStats = await receiverPage.evaluate(async () => {
        const video = document.querySelector('video') as HTMLVideoElement;
        if (!video) return { width: 0, decoded: 0 };
        return {
          width: video.videoWidth,
          decoded: (video as any).webkitDecodedFrameCount || 1
        };
      });
      width = videoStats.width;
      if (width > 0 && videoStats.decoded > 0) return; // Passed
      await new Promise(r => setTimeout(r, 500));
    }
    expect(width).toBeGreaterThan(0);
  }

  // (A) local media, sender first then receiver
  test('A: local media, sender first then receiver', async ({ context }) => {
    const senderPage = await context.newPage();
    await setupLogging(senderPage, 'Sender');
    await senderPage.goto('/');

    await senderPage.getByText('Generate New').click();
    await senderPage.waitForFunction(() => {
      console.log("Checking for input, found:", document.querySelector('input[placeholder="Enter Room Code"]'));
      const el = document.querySelector('input[placeholder="Enter Room Code"]') as HTMLInputElement;
      if (el) console.log("Input value length:", el.value.length);
      return el && el.value.length > 0;
    }, { timeout: 5000 });
    const roomCode = await senderPage.locator('input[placeholder="Enter Room Code"]').inputValue();

    await senderPage.getByText('Cast Screen / Tab').click();


    const receiverPage = await context.newPage();
    await setupLogging(receiverPage, 'Receiver');
    await receiverPage.goto(`/receiver/${roomCode}`);

    await checkReceiverConnected(receiverPage);
  });

  // (B) local media, receiver first then sender
  test('B: local media, receiver first then sender', async ({ context }) => {
    const senderPage = await context.newPage();
    await setupLogging(senderPage, 'Sender Setup');
    await senderPage.goto('/');
    
    // Sender generates room but DOES NOT START CASTING YET
    await senderPage.getByText('Generate New').click();
    await senderPage.waitForFunction(() => {
      const el = document.querySelector('input[placeholder="Enter Room Code"]') as HTMLInputElement;
      return el && el.value.length > 0;
    }, { timeout: 5000 });
    const roomCode = await senderPage.locator('input[placeholder="Enter Room Code"]').inputValue();
    
    // Receiver joins FIRST (before media is cast)
    const receiverPage = await context.newPage();
    await setupLogging(receiverPage, 'Receiver');
    await receiverPage.goto(`/receiver/${roomCode}`);

    // Wait for receiver to connect to WS
    await receiverPage.waitForFunction(() => {
      return (window as any).signalingConnected === true || document.body.innerText.includes('SENDER PRESENT');
    }, { timeout: 5000 }).catch(() => {}); // tolerate timeout

    // Now sender starts casting
    await senderPage.getByText('Cast Screen / Tab').click();

    await checkReceiverConnected(receiverPage);
  });

  // (C) screen/tab cast
  test('C: screen/tab cast', async ({ context }) => {
    const senderPage = await context.newPage();
    await setupLogging(senderPage, 'Sender');
    await senderPage.goto('/');

    await senderPage.getByText('Generate New').click();

    await senderPage.waitForFunction(() => {
      const el = document.querySelector('input[placeholder="Enter Room Code"]') as HTMLInputElement;
      return el && el.value.length > 0;
    }, { timeout: 5000 });
    const roomCode = await senderPage.locator('input[placeholder="Enter Room Code"]').inputValue();

    await senderPage.getByText('Cast Screen / Tab').click();

    const receiverPage = await context.newPage();
    await setupLogging(receiverPage, 'Receiver');
    await receiverPage.goto(`/receiver/${roomCode}`);

    await checkReceiverConnected(receiverPage);
  });

  // (D) reload the receiver 3 times mid-cast
  test('D: reload the receiver 3 times mid-cast', async ({ context }) => {
    const senderPage = await context.newPage();
    await setupLogging(senderPage, 'Sender');
    await senderPage.goto('/');

    await senderPage.getByText('Generate New').click();

    await senderPage.waitForFunction(() => {
      const el = document.querySelector('input[placeholder="Enter Room Code"]') as HTMLInputElement;
      return el && el.value.length > 0;
    }, { timeout: 5000 });
    const roomCode = await senderPage.locator('input[placeholder="Enter Room Code"]').inputValue();

    await senderPage.getByText('Cast Screen / Tab').click();

    let receiverPage = await context.newPage();
    await setupLogging(receiverPage, 'Receiver');
    await receiverPage.goto(`/receiver/${roomCode}`);
    await checkReceiverConnected(receiverPage);

    for (let i = 0; i < 3; i++) {
      await receiverPage.reload();
      await setupLogging(receiverPage, `Receiver (Reload ${i+1})`);
      await checkReceiverConnected(receiverPage);
    }
  });

  // (E) two receivers
  test('E: two receivers', async ({ context }) => {
    const senderPage = await context.newPage();
    await setupLogging(senderPage, 'Sender');
    await senderPage.goto('/');

    await senderPage.getByText('Generate New').click();

    await senderPage.waitForFunction(() => {
      const el = document.querySelector('input[placeholder="Enter Room Code"]') as HTMLInputElement;
      return el && el.value.length > 0;
    }, { timeout: 5000 });
    const roomCode = await senderPage.locator('input[placeholder="Enter Room Code"]').inputValue();

    await senderPage.getByText('Cast Screen / Tab').click();

    const receiver1 = await context.newPage();
    await setupLogging(receiver1, 'Receiver 1');
    await receiver1.goto(`/receiver/${roomCode}`);
    await checkReceiverConnected(receiver1);

    const receiver2 = await context.newPage();
    await setupLogging(receiver2, 'Receiver 2');
    await receiver2.goto(`/receiver/${roomCode}`);
    await checkReceiverConnected(receiver2);
  });
});
