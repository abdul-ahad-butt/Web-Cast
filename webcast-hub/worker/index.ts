export interface Env {
  CAST_ROOM: DurableObjectNamespace;
  LOCAL_MEDIA_BUCKET: R2Bucket;
}

export { CastRoomDurableObject } from "./durable-object";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Basic CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Route: /api/rooms - Create a new room
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      // Generate a simple short room ID (A-Z0-9)
      const roomId = Array.from({length: 4}, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
      return new Response(JSON.stringify({ roomId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    
    // Route: /api/rooms/:roomId/upload - Upload local media
    const uploadMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/upload$/);
    if (uploadMatch && request.method === "POST") {
      const roomId = uploadMatch[1];
      const mediaId = `${roomId}-${crypto.randomUUID()}`;
      
      const contentType = request.headers.get("Content-Type") || "application/octet-stream";
      await env.LOCAL_MEDIA_BUCKET.put(mediaId, request.body, {
        httpMetadata: { contentType }
      });
      
      const mediaUrl = `${url.origin}/api/media/${mediaId}`;
      return new Response(JSON.stringify({ mediaUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Route: /api/media/:mediaId - Serve local media
    const mediaMatch = url.pathname.match(/^\/api\/media\/(.+)$/);
    if (mediaMatch && request.method === "GET") {
      const mediaId = mediaMatch[1];
      const object = await env.LOCAL_MEDIA_BUCKET.get(mediaId);
      
      if (object === null) {
        return new Response("Not Found", { status: 404, headers: corsHeaders });
      }
      
      const headers = new Headers(corsHeaders);
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      
      return new Response(object.body, { headers });
    }

    // Route: /api/rooms/:roomId/debug - Inspect DO state
    const debugMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/debug$/);
    if (debugMatch && request.method === "GET") {
      const roomId = debugMatch[1];
      const id = env.CAST_ROOM.idFromName(roomId);
      const stub = env.CAST_ROOM.get(id);
      
      // Forward the debug request to the Durable Object
      return stub.fetch(request);
    }

    // Route: /api/rooms/:roomId/ws - Connect to a room's Durable Object via WebSocket
    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/ws$/);
    if (roomMatch) {
      const roomId = roomMatch[1];
      const id = env.CAST_ROOM.idFromName(roomId);
      const stub = env.CAST_ROOM.get(id);

      // Forward the request to the Durable Object
      return stub.fetch(request);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, service: "webcast-hub-backend" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
