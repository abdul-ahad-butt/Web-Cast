import { SignalingClient } from "../src/webrtc/SignalingClient";
import { WebRTCPeerConnection } from "../src/webrtc/WebRTCPeerConnection";

let signaling: SignalingClient | null = null;
let pcMap: Map<string, WebRTCPeerConnection> = new Map();
let currentStream: MediaStream | null = null;
let knownReceivers: Set<string> = new Set();
let unsubSignaling: (() => void) | null = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  if (message.type === "START_CAST") {
    startCast(message.roomId, message.ownerToken, message.streamId).then(() => {
      sendResponse({ success: true });
    }).catch((err) => {
      console.error(err);
      sendResponse({ success: false, error: err.message });
    });
    return true; // async
  }

  if (message.type === "STOP_CAST") {
    stopCast();
    sendResponse({ success: true });
  }
});

async function startCast(roomId: string, ownerToken: string, streamId: string) {
  if (signaling) stopCast();
  
  // In offscreen doc, we can use getUserMedia with the streamId
  currentStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId,
      }
    } as any,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId,
      }
    } as any
  });

  signaling = new SignalingClient(roomId, "sender", ownerToken);
  
  unsubSignaling = signaling.on((msg) => {
    if (msg.type === "receiver-joined") {
      knownReceivers.add(msg.receiverId!);
      startNegotiation(msg.receiverId!);
    } else if (msg.type === "peer-left" && msg.role === "receiver") {
      if (msg.clientId) {
        knownReceivers.delete(msg.clientId);
        if (pcMap.has(msg.clientId)) {
          pcMap.get(msg.clientId)?.close();
          pcMap.delete(msg.clientId);
        }
      }
    } else if (msg.type === "request-offer") {
      knownReceivers.add(msg.receiverId!);
      startNegotiation(msg.receiverId!, msg.sessionId);
    }
  });

  signaling.onConnect = async () => {
    console.log("[ExtSim] Connected as sender");
    knownReceivers.forEach(recId => {
      startNegotiation(recId);
    });
  };

  signaling.connect();
}

async function startNegotiation(receiverId: string, reqSessionId?: string) {
  if (!currentStream || !signaling) return;
  
  let pc = pcMap.get(receiverId);
  
  const sessionChanged = reqSessionId && pc?.sessionId && reqSessionId !== pc.sessionId;
  if (pc) {
    const state = pc.pc.connectionState;
    if (sessionChanged || state === "failed") {
      console.log(`[Sender] Rebuilding peer connection for ${receiverId}`);
      pc.close();
      pcMap.delete(receiverId);
      pc = undefined;
    } else if (state === "new" || state === "connecting") {
      console.log(`[Sender] Resending offer for ${receiverId}`);
      pc.resendOffer();
      return;
    } else if (state === "connected") {
      return;
    }
  }

  if (!pc) {
    pc = new WebRTCPeerConnection(signaling, receiverId, reqSessionId);
    pcMap.set(receiverId, pc);
  }

  try {
    currentStream.getTracks().forEach(track => {
      const senders = pc!.pc.getSenders();
      const alreadyAdded = senders.some(s => s.track === track);
      if (!alreadyAdded) {
        pc!.addTrack(track, currentStream!);
      }
    });

    await pc.createOffer();
  } catch (err) {
    console.error("Error creating offer", err);
  }
}

function stopCast() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  pcMap.forEach(pc => pc.close());
  pcMap.clear();
  knownReceivers.clear();
  if (unsubSignaling) {
    unsubSignaling();
    unsubSignaling = null;
  }
  if (signaling) {
    signaling.disconnect();
    signaling = null;
  }
}
