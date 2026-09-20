export type ClientType = "sender" | "receiver";

export type SignalingMessage = 
  | { type: "media-url"; url: string; filename?: string; resolution?: string }
  | { type: "media-play" }
  | { type: "media-pause" }
  | { type: "media-seek"; time: number }
  | { type: "sender-joined" }
  | { type: "sender-disconnected" }
  | { type: "offer"; offer: any }
  | { type: "answer"; answer: any }
  | { type: "ice-candidate"; candidate: any }
  | { type: "ping" }
  | { type: "pong" };

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private clientType: ClientType;
  
  public roomId: string;
  
  public onMessage?: (data: SignalingMessage) => void;
  public onConnect?: () => void;
  public onDisconnect?: () => void;
  public onError?: (error: any) => void;
  private pingInterval?: ReturnType<typeof setInterval>;

  constructor(roomId: string, clientType: ClientType, token?: string) {
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
    this.url = `${baseUrl}/api/rooms/${roomId}/ws?type=${clientType}`;
    if (token) {
      this.url += `&token=${token}`;
    }
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log(`[Signaling] Connected as ${this.clientType}`);
      
      // Keep connection alive
      this.pingInterval = setInterval(() => {
        if (this.isOpen()) {
          this.send({ type: "ping" });
        }
      }, 30000);

      this.onConnect?.();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "pong" || data.type === "ping") return;
        console.log(`[Signaling] Received:`, data.type);
        this.onMessage?.(data);
      } catch (err) {
        console.error("[Signaling] Failed to parse message", err);
      }
    };

    this.ws.onclose = () => {
      console.log("[Signaling] Disconnected");
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.onDisconnect?.();
      this.ws = null;
    };

    this.ws.onerror = (error) => {
      console.error("[Signaling] WebSocket error", error);
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.onError?.(error);
    };
  }

  send(data: SignalingMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn("[Signaling] Cannot send message, WebSocket is not open");
    }
  }

  disconnect() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
