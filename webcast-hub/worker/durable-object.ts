import { Env } from "./index";

export class CastRoomDurableObject {
  ctx: DurableObjectState;
  env: Env;
  sessions: Map<WebSocket, { type: "sender" | "receiver" }>;
  mediaState: {
    url: string | null;
    filename?: string;
    resolution?: string;
    playing: boolean;
    currentTime: number;
  };

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();
    this.mediaState = {
      url: null,
      playing: false,
      currentTime: 0,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      const ownerToken = crypto.randomUUID();
      await this.ctx.storage.put("ownerToken", ownerToken);
      return new Response(JSON.stringify({ ownerToken }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname.endsWith("/validate-owner") && request.method === "GET") {
      const token = url.searchParams.get("token");
      const storedToken = await this.ctx.storage.get("ownerToken");
      if (token && storedToken && token === storedToken) {
        return new Response("OK");
      }
      return new Response("Unauthorized", { status: 401 });
    }

    // Debug Route
    if (url.pathname.endsWith("/debug")) {
      return new Response(JSON.stringify({
        connections: this.sessions.size,
        senders: Array.from(this.sessions.values()).filter(s => s.type === "sender").length,
        receivers: Array.from(this.sessions.values()).filter(s => s.type === "receiver").length,
        mediaState: this.mediaState
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const clientType = url.searchParams.get("type") as "sender" | "receiver" | null;
    if (clientType !== "sender" && clientType !== "receiver") {
      return new Response("Invalid client type", { status: 400 });
    }

    if (clientType === "sender") {
      const token = url.searchParams.get("token");
      const storedToken = await this.ctx.storage.get("ownerToken");
      if (!token || !storedToken || token !== storedToken) {
        return new Response("Unauthorized sender", { status: 401 });
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();

    this.ctx.acceptWebSocket(server);
    this.sessions.set(server, { type: clientType });

    // Notify others that someone joined
    this.broadcast(JSON.stringify({
      type: clientType === "sender" ? "sender-joined" : "receiver-joined"
    }), server);

    // If a receiver joins, notify them if a sender is already present
    if (clientType === "receiver") {
      const hasSender = Array.from(this.sessions.values()).some(s => s.type === "sender");
      if (hasSender) {
        server.send(JSON.stringify({ type: "sender-joined" }));
      }
    }

    // If a receiver joins, send them the current media state if available
    if (clientType === "receiver" && this.mediaState.url) {
      server.send(JSON.stringify({ 
        type: "media-url", 
        url: this.mediaState.url,
        filename: this.mediaState.filename,
        resolution: this.mediaState.resolution
      }));
      if (this.mediaState.playing) {
        server.send(JSON.stringify({ type: "media-play" }));
      }
      server.send(JSON.stringify({ type: "media-seek", time: this.mediaState.currentTime }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const msg = JSON.parse(message as string);
      if (!msg.type) return;

      const session = this.sessions.get(ws);
      if (!session) return;

      // Handle media state synchronization
      if (msg.type === "media-url") {
        this.mediaState.url = msg.url;
        this.mediaState.filename = msg.filename;
        this.mediaState.resolution = msg.resolution;
        this.mediaState.playing = true;
        this.mediaState.currentTime = 0;
      } else if (msg.type === "media-play") {
        this.mediaState.playing = true;
      } else if (msg.type === "media-pause") {
        this.mediaState.playing = false;
      } else if (msg.type === "media-seek") {
        this.mediaState.currentTime = msg.time;
      }

      // Explicit routing based on sender/receiver roles
      if (msg.type === "offer") {
        // Offer is sent by sender, route only to receivers
        if (session.type === "sender") this.broadcastToRole("receiver", message as string);
      } else if (msg.type === "answer") {
        // Answer is sent by receiver, route only to sender
        if (session.type === "receiver") this.broadcastToRole("sender", message as string);
      } else if (msg.type === "ice-candidate") {
        // Route ICE candidates to opposite role
        const targetRole = session.type === "sender" ? "receiver" : "sender";
        this.broadcastToRole(targetRole, message as string);
      } else {
        // General messages (like media controls) are broadcasted to everyone else
        this.broadcast(message as string, ws);
      }
    } catch (e) {
      console.error("Invalid message format", e);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    this.handleDisconnect(ws);
  }

  handleDisconnect(ws: WebSocket) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);

    if (session) {
      this.broadcast(JSON.stringify({
        type: session.type === "sender" ? "sender-disconnected" : "receiver-disconnected"
      }));
      
      // If sender disconnects, clear media state
      if (session.type === "sender") {
        this.mediaState = { url: null, filename: undefined, resolution: undefined, playing: false, currentTime: 0 };
      }
    }
  }

  broadcast(message: string, skipWs?: WebSocket) {
    for (const [ws] of this.sessions) {
      if (ws !== skipWs) {
        try {
          ws.send(message);
        } catch (err) {
          // Ignore
        }
      }
    }
  }

  broadcastToRole(role: "sender" | "receiver", message: string) {
    for (const [ws, session] of this.sessions) {
      if (session.type === role) {
        try {
          ws.send(message);
        } catch (err) {
          // Ignore
        }
      }
    }
  }
}
