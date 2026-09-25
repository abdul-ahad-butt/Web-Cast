export interface Env {
  CAST_ROOM: DurableObjectNamespace;
  LOCAL_MEDIA_BUCKET: R2Bucket;
  // CHANGE 2 – TURN secret bindings (set via: wrangler secret put TURN_KEY_ID etc.)
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export { CastRoomDurableObject } from "./durable-object";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
      "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length, Content-Type, ETag",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // CHANGE 2 – Route: GET /api/turn – return TURN credentials
      if (url.pathname === "/api/turn" && request.method === "GET") {
        const STUN_FALLBACK = JSON.stringify([{ urls: "stun:stun.cloudflare.com:3478" }]);

        if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
          console.warn("[Worker] TURN_KEY_ID or TURN_KEY_API_TOKEN not set, returning STUN fallback");
          return new Response(STUN_FALLBACK, {
            headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }

        try {
          const cfRes = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ ttl: 86400 }),
            }
          );

          if (!cfRes.ok) throw new Error(`Cloudflare TURN API returned ${cfRes.status}`);

          const data = await cfRes.json() as { iceServers?: any[] };
          // Filter out port-53 URLs (browsers block them)
          const filtered = (data.iceServers || []).map((server: any) => {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            return { ...server, urls: urls.filter((u: string) => !/:53(\D|$)/.test(u)) };
          }).filter((s: any) => s.urls.length > 0);

          return new Response(JSON.stringify(filtered), {
            headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        } catch (turnErr: any) {
          console.warn("[Worker] TURN credential fetch failed:", turnErr?.message);
          return new Response(STUN_FALLBACK, {
            headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }
      }

      // Route: /api/rooms - Create a new room
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        // Generate a simple short room ID (excluding 0, O, 1, I, L)
        const charset = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        const roomId = Array.from({length: 4}, () => charset[Math.floor(Math.random() * charset.length)]).join('');
        
        const id = env.CAST_ROOM.idFromName(roomId);
        const stub = env.CAST_ROOM.get(id);
        
        const initReq = new Request(`${url.origin}/init`, { method: "POST" });
        const initRes = await stub.fetch(initReq);
        const { ownerToken } = (await initRes.json()) as { ownerToken: string };

        return new Response(JSON.stringify({ roomId, ownerToken }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      // Route: /api/rooms/:roomId/upload/start - Start multipart upload
      const uploadStartMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/upload\/start$/);
      if (uploadStartMatch && request.method === "POST") {
        const roomId = uploadStartMatch[1];

        // Validate ownerToken
        const token = request.headers.get("Authorization")?.replace("Bearer ", "");
        if (!token) return new Response("Unauthorized: Missing token", { status: 401, headers: corsHeaders });
        
        const id = env.CAST_ROOM.idFromName(roomId);
        const stub = env.CAST_ROOM.get(id);
        const validateRes = await stub.fetch(new Request(`${url.origin}/validate-owner?token=${token}`));
        if (!validateRes.ok) return new Response("Unauthorized: Invalid token", { status: 401, headers: corsHeaders });

        const mediaId = `${roomId}-${crypto.randomUUID()}`;
        const contentType = request.headers.get("Content-Type") || "application/octet-stream";
        
        const multipartUpload = await env.LOCAL_MEDIA_BUCKET.createMultipartUpload(mediaId, {
          httpMetadata: { contentType }
        });
        
        return new Response(JSON.stringify({ uploadId: multipartUpload.uploadId, mediaId }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Route: /api/rooms/:roomId/upload/:uploadId/:partNumber - Upload a part
      const uploadPartMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/upload\/([^\/]+)\/(\d+)$/);
      if (uploadPartMatch && request.method === "PUT") {
        const roomId = uploadPartMatch[1];
        const uploadId = uploadPartMatch[2];
        const partNumber = parseInt(uploadPartMatch[3], 10);

        // Validate ownerToken
        const token = request.headers.get("Authorization")?.replace("Bearer ", "");
        if (!token) return new Response("Unauthorized: Missing token", { status: 401, headers: corsHeaders });
        
        const id = env.CAST_ROOM.idFromName(roomId);
        const stub = env.CAST_ROOM.get(id);
        const validateRes = await stub.fetch(new Request(`${url.origin}/validate-owner?token=${token}`));
        if (!validateRes.ok) return new Response("Unauthorized: Invalid token", { status: 401, headers: corsHeaders });

        const mediaId = new URL(request.url).searchParams.get("mediaId");
        if (!mediaId) return new Response("Missing mediaId query param", { status: 400, headers: corsHeaders });

        const multipartUpload = env.LOCAL_MEDIA_BUCKET.resumeMultipartUpload(mediaId, uploadId);
        
        if (!request.body) return new Response("Missing body", { status: 400, headers: corsHeaders });
        // request.body is a ReadableStream which is accepted by uploadPart in Cloudflare Workers
        const uploadedPart = await multipartUpload.uploadPart(partNumber, request.body);
        
        return new Response(JSON.stringify({ etag: uploadedPart.etag, partNumber: uploadedPart.partNumber }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Route: /api/rooms/:roomId/upload/:uploadId/complete - Complete multipart upload
      const uploadCompleteMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9-]+)\/upload\/([^\/]+)\/complete$/);
      if (uploadCompleteMatch && request.method === "POST") {
        const roomId = uploadCompleteMatch[1];
        const uploadId = uploadCompleteMatch[2];

        // Validate ownerToken
        const token = request.headers.get("Authorization")?.replace("Bearer ", "");
        if (!token) return new Response("Unauthorized: Missing token", { status: 401, headers: corsHeaders });
        
        const id = env.CAST_ROOM.idFromName(roomId);
        const stub = env.CAST_ROOM.get(id);
        const validateRes = await stub.fetch(new Request(`${url.origin}/validate-owner?token=${token}`));
        if (!validateRes.ok) return new Response("Unauthorized: Invalid token", { status: 401, headers: corsHeaders });

        const mediaId = new URL(request.url).searchParams.get("mediaId");
        if (!mediaId) return new Response("Missing mediaId query param", { status: 400, headers: corsHeaders });

        const { parts } = await request.json() as { parts: { partNumber: number, etag: string }[] };
        
        const multipartUpload = env.LOCAL_MEDIA_BUCKET.resumeMultipartUpload(mediaId, uploadId);
        await multipartUpload.complete(parts);
        
        const mediaUrl = `${url.origin}/api/media/${mediaId}`;
        return new Response(JSON.stringify({ mediaUrl }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Route: /api/media/:mediaId - Serve local media
      const mediaMatch = url.pathname.match(/^\/api\/media\/(.+)$/);
      if (mediaMatch && request.method === "GET") {
        const mediaId = mediaMatch[1];
        
        const rangeHeader = request.headers.get("Range");
        let start: number | undefined;
        let end: number | undefined;

        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (match) {
            start = parseInt(match[1], 10);
            if (match[2]) {
              end = parseInt(match[2], 10);
            }
          }
        }
        
        const options: any = {};
        if (start !== undefined) {
          options.range = { offset: start };
          if (end !== undefined) {
            options.range.length = end - start + 1;
          }
        }

        const object = await env.LOCAL_MEDIA_BUCKET.get(mediaId, options);
        
        if (object === null) {
          return new Response("Not Found", { status: 404, headers: corsHeaders });
        }
        
        const headers = new Headers(corsHeaders);
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Accept-Ranges", "bytes");
        // r3-fix: Cache-Control allows TV browsers to cache chunks efficiently.
        // Private ensures CDN doesn't cache across users (R2 objects are per-session).
        headers.set("Cache-Control", "private, max-age=3600");
        // Vary: Range ensures proper caching of partial vs full content
        headers.set("Vary", "Range");
        
        // R2 uses `object.range` if a partial request was made and fulfilled
        const obj = object as R2ObjectBody;
        if (obj.range && 'offset' in obj.range && obj.range.offset !== undefined) {
          const offset = obj.range.offset;
          const length = obj.range.length ?? (obj.size - offset);
          headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
          headers.set("Content-Length", `${length}`);
          return new Response(obj.body, { status: 206, headers });
        } else {
          headers.set("Content-Length", `${obj.size}`);
          return new Response(obj.body, { status: 200, headers });
        }
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

      if (url.pathname === "/api/version" && request.method === "GET") {
        return new Response(JSON.stringify({ version: "2026-09-24-quality-r3" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/" && request.method === "GET") {
        return new Response(JSON.stringify({ ok: true, service: "webcast-hub-backend" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (error: any) {
      console.error("Worker Error:", error);
      return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
