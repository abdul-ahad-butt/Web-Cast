import { SignalingClient } from "../src/webrtc/SignalingClient";
import { WebRTCPeerConnection } from "../src/webrtc/WebRTCPeerConnection";

let signaling: SignalingClient | null = null;
let peerConnection: WebRTCPeerConnection | null = null;
let currentStream: MediaStream | null = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  if (message.type === "START_CAST") {
    startCast(message.roomId, message.streamId).then(() => {
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

async function startCast(roomId: string, streamId: string) {
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

  signaling = new SignalingClient(roomId, "sender");
  peerConnection = new WebRTCPeerConnection(signaling);

  currentStream.getTracks().forEach(track => {
    peerConnection?.addTrack(track, currentStream!);
  });

  signaling.onConnect = async () => {
    await peerConnection?.createOffer();
  };

  signaling.connect();
}

function stopCast() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (signaling) {
    signaling.disconnect();
    signaling = null;
  }
}
