// <define:import.meta.env>
var define_import_meta_env_default = {};

// ../src/webrtc/SignalingClient.ts
var SignalingClient = class {
  ws = null;
  url;
  clientType;
  onMessage;
  onConnect;
  onDisconnect;
  onError;
  constructor(roomId, clientType, token) {
    this.clientType = clientType;
    let baseUrl = "wss://webcast-hub.abdulahadbutt420.workers.dev";
    try {
      if (typeof import.meta !== "undefined" && define_import_meta_env_default) {
        if (void 0) {
          baseUrl = void 0;
        } else if (define_import_meta_env_default.VITE_API_URL) {
          baseUrl = define_import_meta_env_default.VITE_API_URL.replace("https://", "wss://").replace("http://", "ws://");
        }
      }
      if (typeof window !== "undefined" && window.location.hostname === "localhost" && true && !define_import_meta_env_default?.VITE_API_URL) {
        baseUrl = "ws://localhost:8787";
      }
    } catch (e) {
    }
    baseUrl = baseUrl.replace(/\/$/, "");
    this.url = `${baseUrl}/api/rooms/${roomId}/ws?type=${clientType}`;
    if (token) {
      this.url += `&token=${token}`;
    }
  }
  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      console.log(`[Signaling] Connected as ${this.clientType}`);
      this.onConnect?.();
    };
    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log(`[Signaling] Received:`, data.type);
        this.onMessage?.(data);
      } catch (err) {
        console.error("[Signaling] Failed to parse message", err);
      }
    };
    this.ws.onclose = () => {
      console.log("[Signaling] Disconnected");
      this.onDisconnect?.();
      this.ws = null;
    };
    this.ws.onerror = (error) => {
      console.error("[Signaling] WebSocket error", error);
      this.onError?.(error);
    };
  }
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn("[Signaling] Cannot send message, WebSocket is not open");
    }
  }
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
};

// ../src/webrtc/WebRTCPeerConnection.ts
var WebRTCPeerConnection = class {
  pc;
  signaling;
  onTrack;
  onDataChannel;
  onConnectionStateChange;
  pendingCandidates = [];
  constructor(signaling2) {
    this.signaling = signaling2;
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" }
      ]
    });
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({ type: "ice-candidate", candidate: event.candidate });
      }
    };
    this.pc.ontrack = (event) => {
      this.onTrack?.(event.track, event.streams);
    };
    this.pc.ondatachannel = (event) => {
      this.onDataChannel?.(event.channel);
    };
    this.pc.onconnectionstatechange = () => {
      this.onConnectionStateChange?.(this.pc.connectionState);
    };
    const existingOnMessage = this.signaling.onMessage;
    this.signaling.onMessage = async (msg) => {
      existingOnMessage?.(msg);
      try {
        switch (msg.type) {
          case "offer":
            await this.handleOffer(msg.offer);
            break;
          case "answer":
            await this.handleAnswer(msg.answer);
            break;
          case "ice-candidate":
            await this.handleIceCandidate(msg.candidate);
            break;
        }
      } catch (err) {
        console.error("[WebRTC] Error handling signaling message", err);
      }
    };
  }
  addTrack(track, stream) {
    this.pc.addTrack(track, stream);
  }
  createDataChannel(label, options) {
    return this.pc.createDataChannel(label, options);
  }
  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send({ type: "offer", offer: this.pc.localDescription });
  }
  async handleOffer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate) await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.send({ type: "answer", answer: this.pc.localDescription });
  }
  async handleAnswer(answer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
  async handleIceCandidate(candidate) {
    if (this.pc.remoteDescription) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      this.pendingCandidates.push(candidate);
    }
  }
  close() {
    this.pc.close();
  }
};

// offscreen.ts
var signaling = null;
var peerConnection = null;
var currentStream = null;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return false;
  if (message.type === "START_CAST") {
    startCast(message.roomId, message.ownerToken, message.streamId).then(() => {
      sendResponse({ success: true });
    }).catch((err) => {
      console.error(err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
  if (message.type === "STOP_CAST") {
    stopCast();
    sendResponse({ success: true });
  }
});
async function startCast(roomId, ownerToken, streamId) {
  if (signaling) stopCast();
  currentStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId
      }
    }
  });
  signaling = new SignalingClient(roomId, "sender", ownerToken);
  peerConnection = new WebRTCPeerConnection(signaling);
  currentStream.getTracks().forEach((track) => {
    peerConnection?.addTrack(track, currentStream);
  });
  signaling.onConnect = async () => {
    await peerConnection?.createOffer();
  };
  signaling.connect();
}
function stopCast() {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
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
