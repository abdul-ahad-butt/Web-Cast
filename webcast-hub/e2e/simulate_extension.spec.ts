import { test, expect } from '@playwright/test';

test.describe('Simulate Extension Sender', () => {
  async function setupLogging(page: any, name: string) {
    page.on('console', (msg: any) => {
      console.log(`[${name} Browser] ${msg.type()}: ${msg.text()}`);
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          text.includes("Failed to load resource: the server responded with a status of 404") ||
          text.includes("favicon.ico") ||
          text.includes("ResizeObserver loop") ||
          text.includes("Non-Error promise rejection")
        ) {
          return; // Ignore known benign errors
        }
        throw new Error(`Unexpected console.error in ${name}: ${text}`);
      }
    });

    page.on('pageerror', (err: any) => {
      if (err.message.includes('ResizeObserver')) return;
      console.error(`[${name} Browser] Page Error: ${err.message}`);
      throw new Error(`Page error in ${name}: ${err.message}`);
    });
  }

  test('Receiver connects after Extension Sender', async ({ page, context }) => {
    // We will inject the exact logic of offscreen.js into a normal page to simulate the Extension.
    const senderPage = await context.newPage();
    await setupLogging(senderPage, 'Sender');
    await senderPage.goto('/');

    // We generate a room
    await senderPage.getByText('Generate New').click();
    // Wait for room code input to be populated (now uses id="room-code-input")
    await senderPage.waitForFunction(() => {
      const el = document.getElementById('room-code-input') as HTMLInputElement;
      return el && el.value.length > 0;
    }, { timeout: 5000 });
    const roomCode = await senderPage.locator('#room-code-input').inputValue();
    expect(roomCode).toBeTruthy();

    // Now we simulate offscreen.js in the sender page
    await senderPage.evaluate(async (roomId) => {
      // Simulate offscreen.js EXACTLY
      const token = sessionStorage.getItem("ownerToken");
      let ws = new WebSocket(`ws://localhost:8787/api/rooms/${roomId}/ws?type=sender&clientId=ext-1234&token=${token}`);
      let pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      
      ws.onopen = async () => {
        console.log(`[ExtSim] Connected as sender`);
        // Extension creates offer immediately on connect!
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "offer", offer: pc.localDescription }));
        console.log(`[ExtSim] Sent offer!`);
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        console.log(`[ExtSim] Received:`, msg.type);
        if (msg.type === "answer") {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        } else if (msg.type === "ice-candidate") {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
        // NOTE: DOES NOT HANDLE request-offer!
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          ws.send(JSON.stringify({ type: "ice-candidate", candidate: event.candidate }));
        }
      };

      // Mock a track
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      setInterval(() => {
        if(ctx) {
            ctx.fillStyle = 'red';
            ctx.fillRect(0,0,10,10);
        }
      }, 100);
      const stream = canvas.captureStream(30);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

    }, roomCode);

    // Wait 2 seconds for extension to send its offer
    await senderPage.waitForTimeout(2000);

    // Now Receiver connects
    const receiverPage = await context.newPage();
    await setupLogging(receiverPage, 'Receiver');
    await receiverPage.goto(`/receiver/${roomCode}`);

    // Receiver should show SENDER PRESENT
    await expect(receiverPage.getByText('Sender present', { exact: false })).toBeVisible({ timeout: 5000 });

    // Will the video play?
    const video = receiverPage.locator('video');
    
    // We expect it to FAIL (timeout) because request-offer is ignored by Extension!
    let videoPlayed = true;
    try {
      await expect(video).toHaveJSProperty('readyState', 4, { timeout: 10000 });
    } catch (e) {
      videoPlayed = false;
    }
    
    expect(videoPlayed).toBe(false);
  });
});
