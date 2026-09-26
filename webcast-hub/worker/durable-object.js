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
            const data = oldWs.deserializeAttachment();
            if (data && data.clientId === clientId) {
                isReplacement = true;
                console.log(`[Worker] Replacing existing socket for ${clientId}`);
                try {
                    oldWs.close(4001, "Replaced");
                }
                catch (e) { }
            }
        }
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ type: clientType, clientId });
        const websockets = this.ctx.getWebSockets();
        const senderPresent = websockets.some(ws => ws.deserializeAttachment()?.type === "sender");
        const receivers = websockets
            .map(ws => ws.deserializeAttachment())
            .filter(data => data && data.type === "receiver")
            .map(data => data.clientId);
        const receiverCount = receivers.length;
        // Send room-state to the newly connected client
        try {
            server.send(JSON.stringify({
                type: "room-state",
                senderPresent,
                receiverCount,
                receivers,
                yourClientId: clientId,
            }));
        }
        catch (e) {
            console.warn(`[Worker] Error sending room-state to ${clientId}`);
            try {
                server.close(1011, "Internal Error");
            }
            catch (cerr) { }
            return new Response(null, { status: 101, webSocket: client });
        }
        if (!isReplacement) {
            // Notify others role-scoped
            if (clientType === "sender") {
                this.broadcastToRole("receiver", JSON.stringify({ type: "sender-joined" }));
            }
            else {
                this.broadcastToRole("sender", JSON.stringify({ type: "receiver-joined", receiverId: clientId }));
            }
        }
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
            console.log(`[Worker] Message type=${msg.type} from=${session.clientId} to=${msg.targetId || 'all'}`);
            // Targeted routing based on targetId (if specified)
            if (msg.targetId) {
                let delivered = false;
                const websockets = this.ctx.getWebSockets();
                for (const targetWs of websockets) {
                    const targetSession = targetWs.deserializeAttachment();
                    if (targetSession && targetSession.clientId === msg.targetId) {
                        try {
                            targetWs.send(JSON.stringify(msg));
                            delivered = true;
                        }
                        catch (err) {
                            console.warn(`[Worker] Failed to send to ${msg.targetId}, dropping socket`, err);
                            try {
                                targetWs.close(1011, "Send failed");
                            }
                            catch (e) { }
                            this.handleDisconnect(targetWs);
                        }
                    }
                }
                if (!delivered) {
                    console.log(`[Worker] Delivery failed to ${msg.targetId}`);
                    try {
                        ws.send(JSON.stringify({ type: "error", reason: "peer-not-connected", to: msg.targetId }));
                    }
                    catch (err) {
                        console.warn(`[Worker] Failed to send error back to ${session.clientId}`, err);
                        try {
                            ws.close(1011, "Send failed");
                        }
                        catch (e) { }
                        this.handleDisconnect(ws);
                    }
                }
                return; // we handled this targeted message
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
                // r3: R2 media session — sender broadcasts to all receivers
            }
            else if (msg.type === "media-session") {
                if (session.type === "sender")
                    this.broadcastToRole("receiver", JSON.stringify(msg));
                // r3: playback-control — sender → all receivers, or receiver → sender
            }
            else if (msg.type === "playback-control") {
                if (session.type === "sender") {
                    this.broadcastToRole("receiver", JSON.stringify(msg));
                }
                else {
                    this.broadcastToRole("sender", JSON.stringify(msg));
                }
                // r3: playback-state — receiver → sender
            }
            else if (msg.type === "playback-state") {
                if (session.type === "receiver")
                    this.broadcastToRole("sender", JSON.stringify(msg));
                // r3: decode-capability — receiver → sender
            }
            else if (msg.type === "decode-capability") {
                if (session.type === "receiver")
                    this.broadcastToRole("sender", JSON.stringify(msg));
            }
            else {
                // General messages
                this.broadcast(JSON.stringify(msg), ws);
            }
        }
        catch (e) {
            console.error("[Worker] Invalid message format", e);
        }
    }
    async webSocketClose(ws, code, reason, wasClean) {
        try {
            console.log(`[Worker] Close code=${code} reason=${reason}`);
            if (code === 4001)
                return;
            this.handleDisconnect(ws);
        }
        catch (e) {
            console.error("[Worker] Error in webSocketClose", e);
        }
    }
    async webSocketError(ws, error) {
        try {
            console.error(`[Worker] Error`, error);
            this.handleDisconnect(ws);
        }
        catch (e) {
            console.error("[Worker] Error in webSocketError", e);
        }
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
                    try {
                        ws.close(1011, "Send failed");
                    }
                    catch (e) { }
                    this.handleDisconnect(ws);
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
                    try {
                        ws.close(1011, "Send failed");
                    }
                    catch (e) { }
                    this.handleDisconnect(ws);
                }
            }
        }
    }
}
