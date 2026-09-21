// ../src/webrtc/SignalingClient.ts
if (typeof window !== "undefined") {
  window.__wc = { openSockets: 0, socketSeq: 0 };
}
var SignalingClient = class {
  ws = null;
  _url;
  clientType;
  roomId;
  clientId;
  sessionId;
  messageListeners = /* @__PURE__ */ new Set();
  onConnect;
  onDisconnect;
  onError;
  pingInterval;
  reconnectTimeout;
  reconnectAttempts = 0;
  isSuspended = false;
  intendedState = "disconnected";
  sendQueue = [];
  constructor(roomId, clientType, token) {
    this.roomId = roomId;
    this.clientType = clientType;
    const storageKey = `wc_${roomId}_${clientType}`;
    let stored = sessionStorage.getItem(storageKey);
    let sessionData;
    if (stored) {
      sessionData = JSON.parse(stored);
      if (token && sessionData.token !== token) {
        sessionData.token = token;
        sessionStorage.setItem(storageKey, JSON.stringify(sessionData));
      }
    } else {
      sessionData = { clientId: crypto.randomUUID(), token };
      sessionStorage.setItem(storageKey, JSON.stringify(sessionData));
    }
    this.clientId = sessionData.clientId;
    this.sessionId = crypto.randomUUID();
    let baseUrl = "wss://webcast-hub.abdulahadbutt420.workers.dev";
    try {
      if (typeof import.meta !== "undefined" && import.meta.env) {
        if (import.meta.env.VITE_WS_URL) baseUrl = import.meta.env.VITE_WS_URL;
        else if (import.meta.env.VITE_API_URL) baseUrl = import.meta.env.VITE_API_URL.replace("https://", "wss://").replace("http://", "ws://");
      }
      if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && !import.meta.env?.VITE_WS_URL && !import.meta.env?.VITE_API_URL) {
        baseUrl = "ws://127.0.0.1:8787";
      }
    } catch (e) {
    }
    baseUrl = baseUrl.replace(/\/$/, "");
    this._url = `${baseUrl}/api/rooms/${roomId}/ws?type=${clientType}&clientId=${this.clientId}`;
    if (sessionData.token) {
      this._url += `&token=${sessionData.token}`;
    }
    this.setupLifecycle();
  }
  on(handler) {
    this.messageListeners.add(handler);
    return () => {
      this.messageListeners.delete(handler);
    };
  }
  setupLifecycle() {
    if (typeof window === "undefined") return;
    window.addEventListener("pagehide", () => {
      this.isSuspended = true;
      if (this.ws) {
        const oldWs = this.ws;
        this.ws = null;
        if (window.__wc) window.__wc.openSockets--;
        oldWs.close(1e3, "pagehide");
      }
    });
    window.addEventListener("pageshow", (e) => {
      this.isSuspended = false;
      if (e.persisted && this.intendedState === "connected") {
        this.connect();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.intendedState === "connected" && !this.isOpen()) {
        this.isSuspended = false;
        this.connect();
      }
    });
  }
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.intendedState = "connected";
    this.isSuspended = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = void 0;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (window.__wc) window.__wc.openSockets--;
      this.ws.close(1e3, "Replacing connection");
      this.ws = null;
    }
    if (window.__wc) {
      window.__wc.openSockets++;
      window.__wc.socketSeq++;
    }
    const currentSeq = window.__wc ? window.__wc.socketSeq : 0;
    const ws = new WebSocket(this._url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      console.log(`[Signaling] socket#${currentSeq} open`);
      this.reconnectAttempts = 0;
      this.flushQueue();
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.isOpen()) {
          this.ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 2e4);
      this.onConnect?.();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === "pong" || data.type === "ping") return;
        this.messageListeners.forEach((listener) => listener(data));
      } catch (err) {
        console.error("[Signaling] Failed to parse message", err);
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) {
        if (window.__wc) window.__wc.openSockets--;
        return;
      }
      if (window.__wc) window.__wc.openSockets--;
      console.log(`[Signaling] socket#${currentSeq} close(${event.code})`);
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.ws = null;
      this.onDisconnect?.();
      if (event.code === 1e3 || event.code === 4001) {
        if (event.code === 4001) {
          console.warn("[Signaling] Connection replaced (4001). Disabling auto-reconnect.");
        }
        this.intendedState = "disconnected";
        return;
      }
      if (!this.isSuspended && this.intendedState === "connected") {
        this.scheduleReconnect();
      }
    };
    ws.onerror = (error) => {
      if (this.ws !== ws) return;
      console.error(`[Signaling] socket#${currentSeq} error`, error);
      this.onError?.(error);
    };
  }
  scheduleReconnect() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    const baseDelay = Math.min(1e4, 500 * Math.pow(1.5, this.reconnectAttempts));
    const jitter = Math.random() * 500;
    const delay = baseDelay + jitter;
    console.log(`[Signaling] Reconnecting in ${Math.round(delay)}ms... (Attempt ${this.reconnectAttempts + 1})`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }
  flushQueue() {
    const now = Date.now();
    this.sendQueue = this.sendQueue.filter((q) => now - q.timestamp < 1e4);
    if (this.sendQueue.length > 0) {
      console.log(`[Signaling] flush n=${this.sendQueue.length}`);
      while (this.sendQueue.length > 0) {
        const msg = this.sendQueue.shift();
        if (msg && this.ws) {
          this.ws.send(JSON.stringify(msg.data));
        }
      }
    }
  }
  send(data) {
    if (this.isOpen()) {
      if (data.type !== "ping" && data.type !== "pong") {
        console.log(`[Signaling] send type=${data.type}`);
      }
      this.ws.send(JSON.stringify(data));
      return true;
    } else {
      if (data.type !== "ping" && data.type !== "pong") {
        const now = Date.now();
        this.sendQueue = this.sendQueue.filter((q) => now - q.timestamp < 1e4);
        if (this.sendQueue.length < 50) {
          console.log(`[Signaling] queued type=${data.type}`);
          this.sendQueue.push({ data, timestamp: now });
          return true;
        } else {
          console.warn("[Signaling] sendQueue full, dropping message");
          return false;
        }
      }
      return false;
    }
  }
  disconnect() {
    this.intendedState = "disconnected";
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      if (window.__wc) window.__wc.openSockets--;
      oldWs.close(1e3, "Intentional disconnect");
    }
  }
  isOpen() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
};

// ../src/webrtc/WebRTCPeerConnection.ts
var WebRTCPeerConnection = class {
  pc;
  signaling;
  targetId;
  sessionId;
  unsubscribe;
  onTrack;
  onDataChannel;
  onConnectionStateChange;
  pendingCandidates = [];
  constructor(signaling2, targetId, sessionId) {
    this.signaling = signaling2;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" }
      ]
    });
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.sessionId) {
        this.signaling.send({
          type: "ice-candidate",
          candidate: event.candidate,
          targetId: this.targetId,
          sessionId: this.sessionId
        });
      }
    };
    this.pc.ontrack = (event) => {
      this.onTrack?.(event.track, event.streams);
    };
    this.pc.ondatachannel = (event) => {
      this.onDataChannel?.(event.channel);
    };
    this.pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] connection state = ${this.pc.connectionState} for ${this.targetId?.slice(0, 8) || "unknown"}`);
      this.onConnectionStateChange?.(this.pc.connectionState);
    };
    this.pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ice state = ${this.pc.iceConnectionState} for ${this.targetId?.slice(0, 8) || "unknown"}`);
      if (this.pc.iceConnectionState === "disconnected" || this.pc.iceConnectionState === "failed") {
        this.onConnectionStateChange?.("disconnected");
      }
    };
    this.unsubscribe = this.signaling.on(async (msg) => {
      try {
        if (msg.targetId && msg.targetId !== this.signaling.clientId) {
          return;
        }
        if (this.targetId && msg.clientId && msg.clientId !== this.targetId) {
          return;
        }
        switch (msg.type) {
          case "offer":
            if (!this.targetId && msg.clientId) this.targetId = msg.clientId;
            if (msg.sessionId) this.sessionId = msg.sessionId;
            await this.handleOffer(msg.offer);
            break;
          case "answer":
            if (!this.targetId && msg.clientId) this.targetId = msg.clientId;
            if (msg.sessionId !== this.sessionId) {
              console.debug(`[WebRTC] Dropping answer with mismatched sessionId (expected ${this.sessionId}, got ${msg.sessionId})`);
              return;
            }
            if (this.pc.signalingState !== "have-local-offer") {
              console.debug(`[WebRTC] Dropping answer because signalingState is ${this.pc.signalingState}`);
              return;
            }
            await this.handleAnswer(msg.answer);
            break;
          case "ice-candidate":
            if (!this.targetId && msg.clientId) this.targetId = msg.clientId;
            if (msg.sessionId !== this.sessionId) {
              console.debug(`[WebRTC] Dropping ice-candidate with mismatched sessionId`);
              return;
            }
            await this.handleIceCandidate(msg.candidate);
            break;
        }
      } catch (err) {
        console.error(`[WebRTC] Error handling signaling message for ${this.targetId?.slice(0, 8)}`, err);
      }
    });
  }
  addTrack(track, stream) {
    if (this.pc.getSenders().some((s) => s.track === track)) {
      console.debug("[WebRTC] Track already added to peer connection, skipping");
      return;
    }
    const sender = this.pc.addTrack(track, stream);
    if (track.kind === "video") {
      const isScreen = track.label.toLowerCase().includes("screen") || track.label.toLowerCase().includes("monitor") || track.label.toLowerCase().includes("window");
      try {
        if ("contentHint" in track) {
          track.contentHint = isScreen ? "detail" : "motion";
        }
      } catch (e) {
      }
      const parameters = sender.getParameters();
      if (!parameters.encodings) {
        parameters.encodings = [{}];
      }
      const maxBitrate = isScreen ? 4e6 : 3e6;
      parameters.encodings[0].maxBitrate = maxBitrate;
      const settings = track.getSettings();
      const capturedHeight = settings.height || 1080;
      parameters.encodings[0].scaleResolutionDownBy = Math.max(1, capturedHeight / 1080);
      parameters.encodings[0].maxFramerate = 30;
      sender.setParameters(parameters).catch((e) => {
        console.warn("[WebRTC] Failed to set max bitrate/framerate", e);
      });
    }
  }
  createDataChannel(label, options) {
    return this.pc.createDataChannel(label, options);
  }
  async createOffer() {
    try {
      this.sessionId = crypto.randomUUID();
      console.log(`[WebRTC] negotiation start receiver=${this.targetId?.slice(0, 8) || "unknown"} session=${this.sessionId?.slice(0, 8)}`);
      const offer = await this.pc.createOffer();
      console.log(`[WebRTC] offer created`);
      await this.pc.setLocalDescription(offer);
      this.signaling.send({
        type: "offer",
        offer,
        targetId: this.targetId,
        sessionId: this.sessionId
      });
      console.log(`[WebRTC] offer sent|queued`);
    } catch (e) {
      console.error(`[WebRTC] negotiation failed reason=`, e);
    }
  }
  async resendOffer() {
    if (this.pc.localDescription && this.sessionId) {
      this.signaling.send({
        type: "offer",
        offer: this.pc.localDescription,
        targetId: this.targetId,
        sessionId: this.sessionId
      });
      console.log(`[WebRTC] offer resent to ${this.targetId?.slice(0, 8)}`);
    } else {
      await this.createOffer();
    }
  }
  async handleOffer(offer) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.send({
      type: "answer",
      answer,
      targetId: this.targetId,
      sessionId: this.sessionId
    });
  }
  async handleAnswer(answer) {
    console.log(`[WebRTC] answer received from ${this.targetId?.slice(0, 8) || "unknown"}`);
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    await this.flushCandidates();
  }
  async handleIceCandidate(candidate) {
    if (this.pc.remoteDescription) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      this.pendingCandidates.push(candidate);
    }
  }
  async flushCandidates() {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error("[WebRTC] Error adding queued ICE candidate", e);
        }
      }
    }
  }
  close() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = void 0;
    }
    this.pc.close();
  }
};

// offscreen.ts
var signaling = null;
var pcMap = /* @__PURE__ */ new Map();
var currentStream = null;
var knownReceivers = /* @__PURE__ */ new Set();
var unsubSignaling = null;
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
  unsubSignaling = signaling.on((msg) => {
    if (msg.type === "receiver-joined") {
      knownReceivers.add(msg.receiverId);
      startNegotiation(msg.receiverId);
    } else if (msg.type === "peer-left" && msg.role === "receiver") {
      if (msg.clientId) {
        knownReceivers.delete(msg.clientId);
        if (pcMap.has(msg.clientId)) {
          pcMap.get(msg.clientId)?.close();
          pcMap.delete(msg.clientId);
        }
      }
    } else if (msg.type === "request-offer") {
      knownReceivers.add(msg.receiverId);
      startNegotiation(msg.receiverId, msg.sessionId);
    }
  });
  signaling.onConnect = async () => {
    console.log("[ExtSim] Connected as sender");
    knownReceivers.forEach((recId) => {
      startNegotiation(recId);
    });
  };
  signaling.connect();
}
async function startNegotiation(receiverId, reqSessionId) {
  if (!currentStream || !signaling) return;
  let pc = pcMap.get(receiverId);
  const sessionChanged = reqSessionId && pc?.sessionId && reqSessionId !== pc.sessionId;
  if (pc) {
    const state = pc.pc.connectionState;
    if (sessionChanged || state === "failed") {
      console.log(`[Sender] Rebuilding peer connection for ${receiverId}`);
      pc.close();
      pcMap.delete(receiverId);
      pc = void 0;
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
    currentStream.getTracks().forEach((track) => {
      const senders = pc.pc.getSenders();
      const alreadyAdded = senders.some((s) => s.track === track);
      if (!alreadyAdded) {
        pc.addTrack(track, currentStream);
      }
    });
    await pc.createOffer();
  } catch (err) {
    console.error("Error creating offer", err);
  }
}
function stopCast() {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
  pcMap.forEach((pc) => pc.close());
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
