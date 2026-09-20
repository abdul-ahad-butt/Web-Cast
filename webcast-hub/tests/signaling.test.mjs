import WebSocket from 'ws';
import crypto from 'crypto';

// The dev server for the worker should be running, probably at localhost:8787
const WORKER_URL = process.env.WORKER_URL || 'ws://127.0.0.1:8787';

async function runTest() {
  // 1. Create a room
  const createRes = await fetch(`${WORKER_URL.replace('ws://', 'http://')}/api/rooms`, { method: 'POST' });
  if (!createRes.ok) throw new Error('Failed to create room: ' + createRes.status);
  const roomData = await createRes.json();
  const roomId = roomData.roomId;
  const senderToken = roomData.ownerToken;
  const senderId = crypto.randomUUID();
  console.log(`Created room ${roomId}`);

  // 2. Setup receiver
  const receiverId = crypto.randomUUID();

  const senderWs = new WebSocket(`${WORKER_URL}/api/rooms/${roomId}/ws?type=sender&token=${senderToken}&clientId=${senderId}`);
  
  let senderConnected = false;
  let receiverJoinedMsgReceived = false;

  senderWs.on('error', (err) => {
    console.error('[Sender] WS Error:', err.message);
  });

  senderWs.on('open', () => {
    console.log('[Sender] Connected');
    senderConnected = true;
  });

  senderWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log(`[Sender] Received:`, msg.type);
    if (msg.type === 'receiver-joined') {
      receiverJoinedMsgReceived = true;
    }
  });

  // Wait a bit before connecting receiver
  await new Promise(r => setTimeout(r, 500));

  if (!senderConnected) {
    console.error('Sender failed to connect');
    process.exit(1);
  }

  const receiverWs = new WebSocket(`${WORKER_URL}/api/rooms/${roomId}/ws?type=receiver&clientId=${receiverId}`);
  
  receiverWs.on('error', (err) => {
    console.error('[Receiver] WS Error:', err.message);
  });

  receiverWs.on('open', () => {
    console.log('[Receiver] Connected');
  });

  receiverWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log(`[Receiver] Received:`, msg.type);
    if (msg.type === 'room-state') {
       if (msg.senderPresent) {
         console.log('[Receiver] Sender is present! Requesting offer...');
         receiverWs.send(JSON.stringify({ type: 'request-offer', receiverId, to: senderId }));
       } else {
         console.error('[Receiver] Sender is not present in room-state!');
         process.exit(1);
       }
    }
  });

  // Wait a bit for messages to exchange
  await new Promise(r => setTimeout(r, 1000));

  if (receiverJoinedMsgReceived) {
    console.log('SUCCESS: Signaling works');
    process.exit(0);
  } else {
    console.error('FAILURE: receiver-joined not received by sender');
    process.exit(1);
  }
}

runTest().catch(e => {
  console.error(e);
  process.exit(1);
});
