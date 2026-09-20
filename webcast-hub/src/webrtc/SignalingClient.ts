export type ClientType = "sender" | "receiver";

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private clientType: ClientType;
  
  public onMessage?: (data: any) => void;
  public onConnect?: () => void;
  public onDisconnect?: () => void;
  public onError?: (error: any) => void;

  constructor(roomId: string, clientType: ClientType) {
    this.clientType = clientType;
    let baseUrl = "wss://webcast-hub-api.abdulahadbutt420.workers.dev";
    
    try {
      if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_WS_URL) {
        baseUrl = import.meta.env.VITE_WS_URL;
      } else if (typeof window !== 'undefined' && window.location.hostname === "localhost") {
        baseUrl = "ws://localhost:8787";
      }
    } catch (e) {
      // Ignore
    }
    
    // Remove trailing slash if present
    baseUrl = baseUrl.replace(/\/$/, "");
    this.url = `${baseUrl}/api/rooms/${roomId}/ws?type=${clientType}`;
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

  send(data: any) {
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
}
