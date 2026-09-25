// CHANGE 2 - ICE/TURN server fetcher with caching
// Fetches TURN credentials from /api/turn, caches for 60 min.
// Falls back to STUN-only on error or timeout.

const STUN_FALLBACK: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const CACHE_DURATION_MS = 60 * 60 * 1000; // 60 minutes
const FETCH_TIMEOUT_MS = 3_000;

let cachedServers: RTCIceServer[] | null = null;
let cacheExpiry = 0;

function getApiBase(): string {
  try {
    if (typeof import.meta !== "undefined" && import.meta.env) {
      if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL.replace(/\/$/, "");
    }
    if (typeof window !== "undefined" &&
        (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
      return "http://127.0.0.1:8787";
    }
  } catch {}
  return "https://webcast-hub.abdulahadbutt420.workers.dev";
}

export async function getIceServers(): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (cachedServers && now < cacheExpiry) {
    return cachedServers;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${getApiBase()}/api/turn`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const servers: RTCIceServer[] = await res.json();
    cachedServers = servers;
    cacheExpiry = now + CACHE_DURATION_MS;
    let stunUrls = 0, turnUrls = 0, hasCreds = false;
    servers.forEach(s => {
      if (s.username || s.credential) hasCreds = true;
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      urls.forEach(u => {
        if (u.startsWith("stun")) stunUrls++;
        if (u.startsWith("turn")) turnUrls++;
      });
    });
    console.log(`[WebRTC] ICE config: source=turn stunUrls=${stunUrls} turnUrls=${turnUrls} hasCreds=${hasCreds}`);
    return servers;
  } catch (err: any) {
    console.warn("[WebRTC] /api/turn fetch failed, using STUN-only fallback:", err?.message || err);
    let stunUrls = 0, turnUrls = 0, hasCreds = false;
    STUN_FALLBACK.forEach(s => {
      if (s.username || s.credential) hasCreds = true;
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      urls.forEach(u => {
        if (u.startsWith("stun")) stunUrls++;
        if (u.startsWith("turn")) turnUrls++;
      });
    });
    console.log(`[WebRTC] ICE config: source=fallback stunUrls=${stunUrls} turnUrls=${turnUrls} hasCreds=${hasCreds}`);
    return STUN_FALLBACK;
  }
}

export function makePcConfig(iceServers: RTCIceServer[]): RTCConfiguration {
  return {
    iceServers,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceCandidatePoolSize: 2,
  };
}
