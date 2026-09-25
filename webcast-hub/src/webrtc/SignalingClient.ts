export type ClientType = "sender" | "receiver";

export type PlaybackControlAction = "play" | "pause" | "seek" | "restart" | "volume" | "mute" | "stop";
export type PlaybackControlSource = "sender" | "receiver" | "system";

export type SignalingMessage = { clientId?: string; targetId?: string; sessionId?: string } & (
  | { type: "media-url"; url: string; filename?: string; resolution?: string }
  | { type: "media-play" }
  | { type: "media-pause" }
  | { type: "media-seek"; time: number }
  | { type: "sender-joined" }
  | { type: "receiver-joined"; receiverId: string }
  | { type: "sender-disconnected" }
  | { type: "peer-left"; role: string; clientId?: string }
  | { type: "room-state"; senderPresent: boolean; receiverCount: number; yourClientId: string }
  | { type: "request-offer"; receiverId?: string; senderId?: string }
  | { type: "offer"; offer: any; senderId?: string }
  | { type: "answer"; answer: any; receiverId?: string }
  | { type: "ice-candidate"; candidate: any; senderId?: string; receiverId?: string }
  | { type: "error"; reason: string }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "cast-stopped" }
  // r3: R2 media session delivery (sender → receivers)
  | {
      type: "media-session";
      mediaUrl: string;           // /api/media/:mediaId — served by Worker with Range support
      filename: string;
      contentType: string;
      size: number;               // bytes
      duration?: number;          // seconds, if known at upload time
      sourceWidth?: number;
      sourceHeight?: number;
      mediaSessionId: string;     // unique per cast session
    }
  // r3: bidirectional playback control (sender ↔ receiver, via signaling)
  | {
      type: "playback-control";
      action: PlaybackControlAction;
      commandId: string;          // uuid for dedup/ack
      source: PlaybackControlSource;
      currentTime?: number;       // for seek/play
      volume?: number;            // for volume
      muted?: boolean;            // for mute
      sentAt: number;             // performance.now() or Date.now()
    }
  // r3: receiver reporting actual playback state back to sender
  | {
      type: "playback-state";
      commandId?: string;         // echoes the command this is ACKing
      paused: boolean;
      currentTime: number;
      duration: number;
      volume: number;
      muted: boolean;
      bufferedAhead: number;      // seconds ahead buffered
      readyState: number;         // HTMLMediaElement.readyState
      appliedAt: number;          // Date.now()
    }
  // r3: receiver reporting decode capability
  | {
      type: "decode-capability";
      canPlayType: string;        // "probably" | "maybe" | ""
      contentType: string;
    }
);

interface QueuedMessage {
  data: SignalingMessage;
  timestamp: number;
}

if (typeof window !== "undefined") {
  (window as any).__wc = { openSockets: 0, socketSeq: 0 };
}

let activeSignalingClient: SignalingClient | null = null;

export function getGlobalSignaling(roomId: string, clientType: ClientType, token?: string): SignalingClient {
  if (activeSignalingClient) {
    if (activeSignalingClient.roomId === roomId && activeSignalingClient.clientType === clientType) {
      return activeSignalingClient;
    }
    // Room or role changed, kill old singleton
    activeSignalingClient.disconnect();
  }
  
  activeSignalingClient = new SignalingClient(roomId, clientType, token);
  return activeSignalingClient;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private _url: string;
  public clientType: ClientType;
  public roomId: string;
  public clientId: string;
  public sessionId: string;
  
  private messageListeners = new Set<(data: SignalingMessage) => void>();
  
  public onConnect?: () => void;
  public onDisconnect?: () => void;
  public onError?: (error: any) => void;
  
  private pingInterval?: ReturnType<typeof setInterval>;
  private reconnectTimeout?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private isSuspended = false;
  private intendedState: "connected" | "disconnected" = "disconnected";
  
  private sendQueue: QueuedMessage[] = [];

  constructor(roomId: string, clientType: ClientType, token?: string) {
    this.roomId = roomId;
    this.clientType = clientType;
    
    // Retrieve or generate clientId/token from sessionStorage
    const storageKey = `wc_${roomId}_${clientType}`;
    let stored = sessionStorage.getItem(storageKey);
    let sessionData: { clientId: string; token?: string };
    
    if (stored) {
      sessionData = JSON.parse(stored);
      // Ensure we use the provided token if it's new (e.g. sender just created room)
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
      if (typeof import.meta !== 'undefined' && import.meta.env) {
        if (import.meta.env.VITE_WS_URL) baseUrl = import.meta.env.VITE_WS_URL;
        else if (import.meta.env.VITE_API_URL) baseUrl = import.meta.env.VITE_API_URL.replace("https://", "wss://").replace("http://", "ws://");
      }
      if (typeof window !== 'undefined' && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && !import.meta.env?.VITE_WS_URL && !import.meta.env?.VITE_API_URL) {
        baseUrl = "ws://127.0.0.1:8787";
      }
    } catch (e) {
      // Ignore
    }
    
    baseUrl = baseUrl.replace(/\/$/, "");
    this._url = `${baseUrl}/api/rooms/${roomId}/ws?type=${clientType}&clientId=${this.clientId}`;
    if (sessionData.token) {
      this._url += `&token=${sessionData.token}`;
    }

    this.setupLifecycle();
  }

  public on(handler: (data: SignalingMessage) => void): () => void {
    this.messageListeners.add(handler);
    return () => {
      this.messageListeners.delete(handler);
    };
  }

  private setupLifecycle() {
    if (typeof window === 'undefined') return;

    window.addEventListener('pagehide', () => {
      this.isSuspended = true;
      if (this.ws) {
        const oldWs = this.ws;
        this.ws = null;
        if ((window as any).__wc) (window as any).__wc.openSockets--;
        oldWs.close(1000, "pagehide");
      }
    });

    window.addEventListener('pageshow', (e) => {
      this.isSuspended = false;
      if (e.persisted && this.intendedState === "connected") {
        this.connect();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.intendedState === "connected" && !this.isOpen()) {
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
      this.reconnectTimeout = undefined;
    }
    
    if (this.ws) {
      // Detach handlers before closing
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if ((window as any).__wc) (window as any).__wc.openSockets--;
      this.ws.close(1000, "Replacing connection");
      this.ws = null;
    }

    if ((window as any).__wc) {
      (window as any).__wc.openSockets++;
      (window as any).__wc.socketSeq++;
    }
    const currentSeq = (window as any).__wc ? (window as any).__wc.socketSeq : 0;
    
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
          this.ws!.send(JSON.stringify({ type: "ping" }));
        }
      }, 20000);

      this.onConnect?.();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        const data = JSON.parse(event.data) as SignalingMessage;
        if (data.type === "pong" || data.type === "ping") return;
        this.messageListeners.forEach(listener => listener(data));
      } catch (err) {
        console.error("[Signaling] Failed to parse message", err);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) {
        if ((window as any).__wc) (window as any).__wc.openSockets--;
        return;
      }
      if ((window as any).__wc) (window as any).__wc.openSockets--;
      console.log(`[Signaling] socket#${currentSeq} close(${event.code})`);
      
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.ws = null;
      this.onDisconnect?.();

      if (event.code === 1000 || event.code === 4001) {
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

  private scheduleReconnect() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    
    const baseDelay = Math.min(10000, 500 * Math.pow(1.5, this.reconnectAttempts));
    const jitter = Math.random() * 500;
    const delay = baseDelay + jitter;
    
    console.log(`[Signaling] Reconnecting in ${Math.round(delay)}ms... (Attempt ${this.reconnectAttempts + 1})`);
    
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  private flushQueue() {
    const now = Date.now();
    // Filter out messages older than 10s
    this.sendQueue = this.sendQueue.filter(q => now - q.timestamp < 10000);
    
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

  send(data: SignalingMessage): boolean {
    if (this.isOpen()) {
      if (data.type !== "ping" && data.type !== "pong") {
        console.log(`[Signaling] send type=${data.type}`);
      }
      this.ws!.send(JSON.stringify(data));
      return true;
    } else {
      if (data.type !== "ping" && data.type !== "pong") {
        const now = Date.now();
        this.sendQueue = this.sendQueue.filter(q => now - q.timestamp < 10000);
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
      if ((window as any).__wc) (window as any).__wc.openSockets--;
      oldWs.close(1000, "Intentional disconnect");
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
