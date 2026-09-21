import { test, expect } from '@playwright/test';

test.describe('Simulate Extension Sender', () => {
  test('Receiver connects after Extension Sender', async ({ page, context }) => {
    // We will inject the exact logic of offscreen.js into a normal page to simulate the Extension.
    const senderPage = await context.newPage();
    await senderPage.goto('/');

    // We generate a room
    await senderPage.getByText('Generate New').click();
    await senderPage.waitForFunction(() => {
      const el = document.querySelector('input[placeholder="Enter Room Code"]') as HTMLInputElement;
      return el && el.value.length > 0;
    }, { timeout: 5000 });
    const roomCode = await senderPage.locator('input[placeholder="Enter Room Code"]').inputValue();
    expect(roomCode).toBeTruthy();

    // Now we simulate offscreen.js in the sender page
    await senderPage.evaluate(async (roomId) => {
      // Simulate offscreen.js EXACTLY
      let ws = new WebSocket(`ws://localhost:8787/api/rooms/${roomId}/ws?type=sender&clientId=ext-1234`);
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
