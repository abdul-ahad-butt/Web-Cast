export class CastRoomDurableObject {
    ctx;
    env;
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
    }
    async fetch(request) {
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
                const data = ws.deserializeAttachment();
                if (data.type === "sender")
                    senders++;
                if (data.type === "receiver")
                    receivers++;
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
        const clientType = url.searchParams.get("type");
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
        const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ type: clientType, clientId });
        const websockets = this.ctx.getWebSockets();
        const senderPresent = websockets.some(ws => ws.deserializeAttachment().type === "sender");
        const receiverCount = websockets.filter(ws => ws.deserializeAttachment().type === "receiver").length;
        // Send room-state to the newly connected client
        server.send(JSON.stringify({
            type: "room-state",
            senderPresent,
            receiverCount,
            yourClientId: clientId,
        }));
        // Notify others
        this.broadcast(JSON.stringify({
            type: clientType === "sender" ? "sender-joined" : "receiver-joined",
            receiverId: clientType === "receiver" ? clientId : undefined
        }), server);
        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }
    async webSocketMessage(ws, message) {
        try {
            const msg = JSON.parse(message);
            if (!msg.type)
                return;
            if (msg.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
            }
            const session = ws.deserializeAttachment();
            if (!session)
                return;
            // Inject sender's clientId for targeted responses
            msg.clientId = session.clientId;
            // Targeted routing based on targetId (if specified)
            if (msg.targetId) {
                const websockets = this.ctx.getWebSockets();
                for (const targetWs of websockets) {
                    const targetSession = targetWs.deserializeAttachment();
                    if (targetSession && targetSession.clientId === msg.targetId) {
                        targetWs.send(JSON.stringify(msg));
                        return; // message delivered
                    }
                }
            }
            // Explicit routing based on sender/receiver roles
            if (msg.type === "offer") {
                if (session.type === "sender")
                    this.broadcastToRole("receiver", JSON.stringify(msg));
            }
            else if (msg.type === "answer") {
                if (session.type === "receiver")
                    this.broadcastToRole("sender", JSON.stringify(msg));
            }
            else if (msg.type === "ice-candidate") {
                const targetRole = session.type === "sender" ? "receiver" : "sender";
                this.broadcastToRole(targetRole, JSON.stringify(msg));
            }
            else {
                // General messages
                this.broadcast(JSON.stringify(msg), ws);
            }
        }
        catch (e) {
            console.error("Invalid message format", e);
        }
    }
    async webSocketClose(ws, code, reason, wasClean) {
        this.handleDisconnect(ws);
    }
    async webSocketError(ws, error) {
        this.handleDisconnect(ws);
    }
    handleDisconnect(ws) {
        const session = ws.deserializeAttachment();
        if (session) {
            this.broadcast(JSON.stringify({
                type: "peer-left",
                role: session.type,
                clientId: session.clientId
            }));
        }
    }
    broadcast(message, skipWs) {
        const websockets = this.ctx.getWebSockets();
        for (const ws of websockets) {
            if (ws !== skipWs) {
                try {
                    ws.send(message);
                }
                catch (err) {
                    // Ignore
                }
            }
        }
    }
    broadcastToRole(role, message) {
        const websockets = this.ctx.getWebSockets();
        for (const ws of websockets) {
            const session = ws.deserializeAttachment();
            if (session && session.type === role) {
                try {
                    ws.send(message);
                }
                catch (err) {
                    // Ignore
                }
            }
        }
    }
}
