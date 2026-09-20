import { Env } from "./index";

interface ClientData {
  type: "sender" | "receiver";
  clientId: string;
}

export class CastRoomDurableObject {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
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
      const websockets = this.ctx.getWebSockets();
      let senders = 0;
      let receivers = 0;
      websockets.forEach(ws => {
        const data = ws.deserializeAttachment() as ClientData;
        if (data.type === "sender") senders++;
        if (data.type === "receiver") receivers++;
      });
      return new Response(JSON.stringify({
        connections: websockets.length,
        senders,
        receivers
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
        console.log(`[Worker] Auth failed. token=${token} storedToken=${storedToken}`);
        return new Response("Unauthorized sender", { status: 401 });
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();

    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();

    console.log(`[Worker] Connect request type=${clientType} clientId=${clientId}`);

    let isReplacement = false;
    const existingWebsockets = this.ctx.getWebSockets();
    for (const oldWs of existingWebsockets) {
      const data = oldWs.deserializeAttachment() as ClientData;
      if (data && data.clientId === clientId) {
        isReplacement = true;
        console.log(`[Worker] Replacing existing socket for ${clientId}`);
        try {
          oldWs.close(4001, "Replaced");
        } catch (e) {}
      }
    }

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ type: clientType, clientId } as ClientData);

    const websockets = this.ctx.getWebSockets();
    const senderPresent = websockets.some(ws => (ws.deserializeAttachment() as ClientData).type === "sender");
    const receiverCount = websockets.filter(ws => (ws.deserializeAttachment() as ClientData).type === "receiver").length;

    // Send room-state to the newly connected client
    server.send(JSON.stringify({
      type: "room-state",
      senderPresent,
      receiverCount,
      yourClientId: clientId,
    }));

    if (!isReplacement) {
      // Notify others role-scoped
      if (clientType === "sender") {
        this.broadcastToRole("receiver", JSON.stringify({ type: "sender-joined" }));
      } else {
        this.broadcastToRole("sender", JSON.stringify({ type: "receiver-joined", receiverId: clientId }));
      }
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

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      const session = ws.deserializeAttachment() as ClientData;
      if (!session) return;

      // Inject sender's clientId for targeted responses
      msg.clientId = session.clientId;
      console.log(`[Worker] Message type=${msg.type} from=${session.clientId} to=${msg.targetId || 'all'}`);

      // Targeted routing based on targetId (if specified)
      if (msg.targetId) {
        let delivered = false;
        const websockets = this.ctx.getWebSockets();
        for (const targetWs of websockets) {
          const targetSession = targetWs.deserializeAttachment() as ClientData;
          if (targetSession && targetSession.clientId === msg.targetId) {
            targetWs.send(JSON.stringify(msg));
            delivered = true;
            break;
          }
        }
        if (!delivered) {
          console.log(`[Worker] Delivery failed to ${msg.targetId}`);
          ws.send(JSON.stringify({ type: "error", reason: "peer-not-connected", to: msg.targetId }));
        }
        return; // we handled this targeted message
      }

      // Explicit routing based on sender/receiver roles
      if (msg.type === "offer") {
        if (session.type === "sender") this.broadcastToRole("receiver", JSON.stringify(msg));
      } else if (msg.type === "answer") {
        if (session.type === "receiver") this.broadcastToRole("sender", JSON.stringify(msg));
      } else if (msg.type === "ice-candidate") {
        const targetRole = session.type === "sender" ? "receiver" : "sender";
        this.broadcastToRole(targetRole, JSON.stringify(msg));
      } else {
        // General messages
        this.broadcast(JSON.stringify(msg), ws);
      }
    } catch (e) {
      console.error("[Worker] Invalid message format", e);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    try {
      console.log(`[Worker] Close code=${code} reason=${reason}`);
      if (code === 4001) return;
      this.handleDisconnect(ws);
    } catch (e) {
      console.error("[Worker] Error in webSocketClose", e);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    try {
      console.error(`[Worker] Error`, error);
      this.handleDisconnect(ws);
    } catch (e) {
      console.error("[Worker] Error in webSocketError", e);
    }
  }

  handleDisconnect(ws: WebSocket) {
    const session = ws.deserializeAttachment() as ClientData | null;
    if (session) {
      this.broadcast(JSON.stringify({
        type: "peer-left",
        role: session.type,
        clientId: session.clientId
      }));
    }
  }

  broadcast(message: string, skipWs?: WebSocket) {
    const websockets = this.ctx.getWebSockets();
    for (const ws of websockets) {
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
    const websockets = this.ctx.getWebSockets();
    for (const ws of websockets) {
      const session = ws.deserializeAttachment() as ClientData;
      if (session && session.type === role) {
        try {
          ws.send(message);
        } catch (err) {
          // Ignore
        }
      }
    }
  }
}
