export type ClientType = "sender" | "receiver";

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
);

const instances = new Map<string, SignalingClient>();

export function getGlobalSignaling(roomId: string, clientType: ClientType, token?: string): SignalingClient {
  const key = `${roomId}-${clientType}`;
  if (!instances.has(key)) {
    instances.set(key, new SignalingClient(roomId, clientType, token));
  }
  return instances.get(key)!;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private clientType: ClientType;
  
  public roomId: string;
  
  private messageListeners = new Set<(data: SignalingMessage) => void>();
  
  public on(handler: (data: SignalingMessage) => void): () => void {
    this.messageListeners.add(handler);
    return () => {
      this.messageListeners.delete(handler);
    };
  }
  public onConnect?: () => void;
  public onDisconnect?: () => void;
  public onError?: (error: any) => void;
  
  private pingInterval?: ReturnType<typeof setInterval>;
  private reconnectTimeout?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private isSuspended = false;
  private intendedState: "connected" | "disconnected" = "disconnected";
  public clientId: string;

  constructor(roomId: string, clientType: ClientType, token?: string) {
    this.clientId = crypto.randomUUID();
    this.roomId = roomId;
    this.clientType = clientType;
    let baseUrl = "wss://webcast-hub.abdulahadbutt420.workers.dev";
    
    try {
      if (typeof import.meta !== 'undefined' && import.meta.env) {
        if (import.meta.env.VITE_WS_URL) {
          baseUrl = import.meta.env.VITE_WS_URL;
        } else if (import.meta.env.VITE_API_URL) {
          baseUrl = import.meta.env.VITE_API_URL.replace("https://", "wss://").replace("http://", "ws://");
        }
      }
      
      if (typeof window !== 'undefined' && window.location.hostname === "localhost" && !import.meta.env?.VITE_WS_URL && !import.meta.env?.VITE_API_URL) {
        baseUrl = "ws://localhost:8787";
      }
    } catch (e) {
      // Ignore
    }
    
    // Remove trailing slash if present
    baseUrl = baseUrl.replace(/\/$/, "");
    this.url = `${baseUrl}/api/rooms/${roomId}/ws?type=${clientType}&clientId=${this.clientId}`;
    if (token) {
      this.url += `&token=${token}`;
    }

    this.setupLifecycle();
  }

  private setupLifecycle() {
    if (typeof window === 'undefined') return;

    window.addEventListener('pagehide', () => {
      this.isSuspended = true;
      if (this.ws) {
        // Code 1000 for normal closure
        this.ws.close(1000, "pagehide");
        this.ws = null;
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
    if (this.isOpen()) return;
    this.intendedState = "connected";
    this.isSuspended = false;
    
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log(`[Signaling] Connected as ${this.clientType} (${this.clientId})`);
      this.reconnectAttempts = 0;
      
      // Keep connection alive (app-level ping every 20s)
      this.pingInterval = setInterval(() => {
        if (this.isOpen()) {
          this.send({ type: "ping" });
        }
      }, 20000);

      this.onConnect?.();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "pong" || data.type === "ping") return;
        console.log(`[Signaling] Received:`, data.type);
        this.messageListeners.forEach(listener => listener(data));
      } catch (err) {
        console.error("[Signaling] Failed to parse message", err);
      }
    };

    this.ws.onclose = (event) => {
      console.log(`[Signaling] Disconnected: code ${event.code}`);
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.ws = null;
      this.onDisconnect?.();

      if (!this.isSuspended && this.intendedState === "connected") {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      console.error("[Signaling] WebSocket error", error);
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.onError?.(error);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    
    // Exponential backoff with jitter
    const baseDelay = Math.min(10000, 500 * Math.pow(1.5, this.reconnectAttempts));
    const jitter = Math.random() * 500;
    const delay = baseDelay + jitter;
    
    console.log(`[Signaling] Reconnecting in ${Math.round(delay)}ms... (Attempt ${this.reconnectAttempts + 1})`);
    
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  send(data: SignalingMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn("[Signaling] Cannot send message, WebSocket is not open");
    }
  }

  disconnect() {
    this.intendedState = "disconnected";
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.close(1000, "Intentional disconnect");
      this.ws = null;
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
