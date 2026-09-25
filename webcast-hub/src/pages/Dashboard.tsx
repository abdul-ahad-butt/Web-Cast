import { Tv, MonitorSmartphone, Settings } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { SignalingClient, getGlobalSignaling } from "../webrtc/SignalingClient";
import { WebRTCPeerConnection, applyEncodingParams } from "../webrtc/WebRTCPeerConnection";
import { getIceServers, makePcConfig } from "../webrtc/iceServers";

// ─── R2 Upload helpers ────────────────────────────────────────────────────────
// Accepted local media MIME types
const ACCEPTED_MIME = [
  "video/mp4", "video/webm", "video/quicktime", "video/x-matroska",
  "image/jpeg", "image/png", "image/webp", "image/gif",
];

function getApiBase(): string {
  const env = (import.meta as any).env;
  if (env?.VITE_API_URL) return env.VITE_API_URL.replace(/\/$/, "");
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:8787";
  }
  return "https://webcast-hub.abdulahadbutt420.workers.dev";
}

const PART_SIZE = 5 * 1024 * 1024; // 5 MB per multipart part (R2 minimum)

interface UploadProgress {
  loaded: number;
  total: number;
  phase: "uploading" | "finalizing" | "done";
}

async function uploadToR2(
  file: File,
  roomId: string,
  ownerToken: string,
  onProgress: (p: UploadProgress) => void
): Promise<string> {
  const base = getApiBase();
  const ct = file.type || "application/octet-stream";

  // 1. Start multipart upload
  const startRes = await fetch(`${base}/api/rooms/${roomId}/upload/start`, {
    method: "POST",
    headers: { "Content-Type": ct, "Authorization": `Bearer ${ownerToken}` },
  });
  if (!startRes.ok) throw new Error(`Upload start failed: ${startRes.status}`);
  const { uploadId, mediaId } = await startRes.json() as { uploadId: string; mediaId: string };

  // 2. Upload parts
  const parts: { partNumber: number; etag: string }[] = [];
  const totalParts = Math.ceil(file.size / PART_SIZE);
  let loaded = 0;

  for (let i = 0; i < totalParts; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, file.size);
    const chunk = file.slice(start, end);

    const partRes = await fetch(
      `${base}/api/rooms/${roomId}/upload/${uploadId}/${i + 1}?mediaId=${encodeURIComponent(mediaId)}`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${ownerToken}`, "Content-Type": "application/octet-stream" },
        body: chunk,
      }
    );
    if (!partRes.ok) throw new Error(`Part ${i + 1} upload failed: ${partRes.status}`);
    const { etag, partNumber } = await partRes.json() as { etag: string; partNumber: number };
    parts.push({ partNumber, etag });
    loaded += (end - start);
    onProgress({ loaded, total: file.size, phase: "uploading" });
  }

  // 3. Complete multipart upload
  onProgress({ loaded: file.size, total: file.size, phase: "finalizing" });
  const completeRes = await fetch(
    `${base}/api/rooms/${roomId}/upload/${uploadId}/complete?mediaId=${encodeURIComponent(mediaId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${ownerToken}` },
      body: JSON.stringify({ parts }),
    }
  );
  if (!completeRes.ok) throw new Error(`Upload complete failed: ${completeRes.status}`);
  const { mediaUrl } = await completeRes.json() as { mediaUrl: string };
  onProgress({ loaded: file.size, total: file.size, phase: "done" });
  return mediaUrl;
}

// ─── Dashboard Component ──────────────────────────────────────────────────────
export default function Dashboard() {
  const [roomId, setRoomId] = useState<string>("");
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("Not Connected");
  const [mediaInfo, setMediaInfo] = useState<{filename: string, resolution: string, transport: "r2" | "webrtc"} | null>(null);
  const [receiverCount, setReceiverCount] = useState<number>(0);
  const [connectedCount, setConnectedCount] = useState<number>(0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Hidden video element only used for tab-cast (captureStream) — NOT for local file R2 path
  const videoRef = useRef<HTMLVideoElement>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const pcMapRef = useRef<Map<string, WebRTCPeerConnection>>(new Map());
  const activeStreamRef = useRef<MediaStream | null>(null);
  const isStartingCastRef = useRef<boolean>(false);
  const receiverSessionMapRef = useRef<Map<string, string>>(new Map());
  const lastNegotiation = useRef<Map<string, number>>(new Map());
  const knownReceiversRef = useRef<Set<string>>(new Set());
  const unsubsRef = useRef<(() => void)[]>([]);
  const wakeLockRef = useRef<any>(null);
  const pcConfigRef = useRef<RTCConfiguration | null>(null);
  const currentModeRef = useRef<"local-media" | "screen">("screen");
  // r3: current media session id (for R2 local media)
  const mediaSessionIdRef = useRef<string | null>(null);
  // r3: last playback-state snapshot from receivers (keyed by receiverId)
  const receiverPlaybackStateRef = useRef<Map<string, any>>(new Map());

  // ─── Wake Lock ───────────────────────────────────────────────────────────────
  const acquireWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        console.log('[Sender] wakeLock acquired');
      }
    } catch (e: any) {
      console.warn('[Sender] wakeLock failed:', e?.message);
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    } catch {}
  }, []);

  useEffect(() => {
    console.log("[App] role=sender build=2026-09-24-quality-r3");
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && activeStreamRef.current) acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubsRef.current.forEach(unsub => unsub());
      pcMapRef.current.forEach(pc => pc.close());
      pcMapRef.current.clear();
      if (signalingRef.current) signalingRef.current.disconnect();
      if (activeStreamRef.current) activeStreamRef.current.getTracks().forEach(t => t.stop());
      releaseWakeLock();
    };
  }, [acquireWakeLock, releaseWakeLock]);

  // ─── Re-apply bitrate to all PCs ─────────────────────────────────────────────
  const reapplyBitrate = useCallback(async () => {
    const count = pcMapRef.current.size;
    for (const pc of pcMapRef.current.values()) {
      pc.receiverCount = count;
      await applyEncodingParams(pc.pc, pc.mode, count);
    }
  }, []);

  // ─── WebRTC negotiation (for tab/screen cast only) ────────────────────────────
  const startNegotiation = useCallback(async (receiverId: string, reqSessionId?: string) => {
    const now = Date.now();
    const last = lastNegotiation.current.get(receiverId) || 0;

    let pc = pcMapRef.current.get(receiverId);

    const oldSessionId = receiverSessionMapRef.current.get(receiverId);
    let sessionChanged = false;
    if (reqSessionId && oldSessionId && reqSessionId !== oldSessionId) sessionChanged = true;
    if (reqSessionId) receiverSessionMapRef.current.set(receiverId, reqSessionId);

    if (pc) {
      const state = pc.pc.connectionState;
      if (sessionChanged || state === "failed" || ((state === "new" || state === "connecting") && now - last >= 10000)) {
        console.log(`[Sender] Rebuilding peer connection for ${receiverId} (sessionChanged=${sessionChanged})`);
        pc.close();
        pcMapRef.current.delete(receiverId);
        pc = undefined;
      } else if (state === "connected" && !sessionChanged) {
        console.log(`[Sender] Connection is healthy for ${receiverId}, ignoring negotiation`);
        return;
      } else if ((state === "new" || state === "connecting") && (now - last < 4000)) {
        console.log(`[Sender] Debouncing negotiation for ${receiverId}`);
        return;
      } else if (state === "new" || state === "connecting") {
        console.log(`[Sender] Resending offer for ${receiverId}`);
        lastNegotiation.current.set(receiverId, Date.now());
        pc.resendOffer();
        return;
      }
    }

    if (!activeStreamRef.current || !signalingRef.current) return;

    if (!pc) {
      if (!pcConfigRef.current) {
        const iceServers = await getIceServers();
        pcConfigRef.current = makePcConfig(iceServers);
      }

      pc = new WebRTCPeerConnection(signalingRef.current, receiverId, undefined, pcConfigRef.current);
      pc.mode = currentModeRef.current;
      pc.receiverCount = pcMapRef.current.size + 1;

      pc.onIceRestart = async () => {
        const thisPc = pcMapRef.current.get(receiverId);
        if (!thisPc || thisPc.pc.signalingState === 'closed') return;
        await thisPc.createOffer({ iceRestart: true });
      };

      let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
      pc.onConnectionStateChange = (state) => {
        let count = 0;
        pcMapRef.current.forEach(p => { if (p.pc.connectionState === 'connected') count++; });
        setConnectedCount(count);

        if (state === 'connected') {
          if (disconnectTimer) clearTimeout(disconnectTimer);
          // r3: if we have an active R2 media session, send it to this newly connected receiver
          if (mediaSessionIdRef.current && signalingRef.current && mediaInfo?.transport === "r2") {
            _broadcastMediaSession();
          }
        } else if (state === 'disconnected') {
          disconnectTimer = setTimeout(() => {
            if (pcMapRef.current.get(receiverId)?.pc.connectionState !== 'connected') {
              pcMapRef.current.get(receiverId)?.close();
              pcMapRef.current.delete(receiverId);
              lastNegotiation.current.delete(receiverId);
            }
          }, 10000);
        } else if (state === 'failed' || state === 'closed') {
          if (disconnectTimer) clearTimeout(disconnectTimer);
          pcMapRef.current.get(receiverId)?.close();
          pcMapRef.current.delete(receiverId);
          lastNegotiation.current.delete(receiverId);
        }
      };

      // r3: data channel is only used for tab/screen WebRTC — not for R2 local media
      const dc = pc.createDataChannel('control', { ordered: true });
      dc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          // Receive playback-state from receiver (for WebRTC tab cast — screen cast doesn't have seekable playback)
          if (msg.type === "playback-state") {
            receiverPlaybackStateRef.current.set(receiverId, msg);
          }
        } catch {}
      };

      pcMapRef.current.set(receiverId, pc);
      pc.startSenderStats();

      const totalCount = pcMapRef.current.size;
      for (const p of pcMapRef.current.values()) p.receiverCount = totalCount;
    }

    lastNegotiation.current.set(receiverId, Date.now());

    const senders = pc.pc.getSenders();
    activeStreamRef.current.getTracks().forEach(track => {
      if (!senders.find(s => s.track === track)) {
        pc!.addTrack(track, activeStreamRef.current!);
      }
    });

    await pc.createOffer();
  }, [reapplyBitrate]);

  // r3: broadcast current R2 media session to all receivers
  const _broadcastMediaSession = useCallback(() => {
    if (!signalingRef.current || !mediaSessionIdRef.current) return;
    const session = (window as any).__wcMediaSession;
    if (!session) return;
    console.log("[MEDIA] Broadcasting media-session to all receivers");
    signalingRef.current.send({
      type: "media-session",
      mediaUrl: session.mediaUrl,
      filename: session.filename,
      contentType: session.contentType,
      size: session.size,
      duration: session.duration,
      sourceWidth: session.sourceWidth,
      sourceHeight: session.sourceHeight,
      mediaSessionId: mediaSessionIdRef.current,
    } as any);
  }, []);

  // ─── Signaling setup ─────────────────────────────────────────────────────────
  const setupSignaling = (rId: string, tok: string) => {
    if (signalingRef.current) {
      unsubsRef.current.forEach(unsub => unsub());
      unsubsRef.current = [];
      signalingRef.current.disconnect();
    }

    const signaling = getGlobalSignaling(rId, "sender", tok);
    signalingRef.current = signaling;

    unsubsRef.current.push(signaling.on((msg) => {
      if (msg.type === "room-state") {
        setReceiverCount(msg.receiverCount);
        if ((msg as any).receivers && Array.isArray((msg as any).receivers)) {
          const currentReceivers = new Set<string>((msg as any).receivers);
          currentReceivers.forEach(id => {
            if (!knownReceiversRef.current.has(id)) {
              knownReceiversRef.current.add(id);
              if (activeStreamRef.current) startNegotiation(id);
              // r3: if local media session active, send it
              if (mediaSessionIdRef.current) {
                setTimeout(() => _broadcastMediaSession(), 500);
              }
            }
          });
        }
      } else if (msg.type === "receiver-joined") {
        setReceiverCount(prev => prev + 1);
        knownReceiversRef.current.add(msg.receiverId!);
        if (activeStreamRef.current) {
          startNegotiation(msg.receiverId!);
        } else if (mediaSessionIdRef.current) {
          // r3: R2 local media — no WebRTC needed, just send the media-session message
          setTimeout(() => _broadcastMediaSession(), 300);
        }
      } else if (msg.type === "peer-left" && msg.role === "receiver") {
        setReceiverCount(prev => Math.max(0, prev - 1));
        const clientId = msg.clientId;
        if (clientId) {
          knownReceiversRef.current.delete(clientId);
          setTimeout(() => {
            if (!knownReceiversRef.current.has(clientId) && pcMapRef.current.has(clientId)) {
              pcMapRef.current.get(clientId)?.close();
              pcMapRef.current.delete(clientId);
              lastNegotiation.current.delete(clientId);
              let count = 0;
              pcMapRef.current.forEach(p => { if (p.pc.connectionState === 'connected') count++; });
              setConnectedCount(count);
            }
          }, 15000);
        }
      } else if (msg.type === "request-offer") {
        knownReceiversRef.current.add(msg.receiverId!);
        if (activeStreamRef.current) {
          startNegotiation(msg.receiverId!, msg.sessionId);
        } else if (mediaSessionIdRef.current) {
          // r3: receiver requesting an offer but we are in R2 mode — send media-session instead
          setTimeout(() => _broadcastMediaSession(), 200);
        }
      } else if (msg.type as any === "delivery-failed") {
        const failedMsg = msg as any;
        if (failedMsg.to) lastNegotiation.current.delete(failedMsg.to);
      } else if ((msg as any).type === "playback-state") {
        // r3: receiver reporting playback state back to us
        const ps = msg as any;
        receiverPlaybackStateRef.current.set(ps.clientId || "unknown", ps);
      } else if ((msg as any).type === "playback-control") {
        // r3: receiver sending a control to us (e.g. receiver pressed pause on its own UI)
        const ctrl = msg as any;
        if (ctrl.source === "receiver") {
          _handleReceiverControl(ctrl);
        }
      }
    }));

    (window as any).__wcStats = () => {
      let stats: any = {};
      pcMapRef.current.forEach((pc, id) => {
        stats[id] = { state: pc.pc.connectionState, ice: pc.pc.iceConnectionState, signaling: pc.pc.signalingState };
      });
      return stats;
    };

    signaling.onConnect = () => {
      setStatus("Waiting for receiver...");
      setIsConnected(true);
    };
    signaling.onDisconnect = () => {
      setIsConnected(false);
      setStatus("Not Connected");
      setConnectedCount(0);
    };
    signaling.connect();
  };

  // r3: handle control message from receiver (receiver pressed play/pause/seek on their own player)
  const _handleReceiverControl = (ctrl: any) => {
    // For R2 local media the sender doesn't need to do anything with controls —
    // the receiver controls its own <video> element directly.
    // For screen cast, sender is the source so no action needed either.
    console.log(`[Control] Received from receiver: action=${ctrl.action} commandId=${ctrl.commandId}`);
  };

  // ─── Generate room ───────────────────────────────────────────────────────────
  const generateRoom = async () => {
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/rooms`, { method: "POST" });
      const data = await res.json();
      setRoomId(data.roomId);
      sessionStorage.setItem("ownerToken", data.ownerToken);
      setupSignaling(data.roomId, data.ownerToken);
    } catch (e) {
      console.error(e);
      setRoomId(Math.random().toString(36).substring(2, 6).toUpperCase());
    }
  };

  // ─── Heartbeat (for screen cast only — R2 uses playback-control signaling) ───
  useEffect(() => {
    if (!isConnected || currentModeRef.current !== "screen") return;
    const interval = setInterval(() => {
      const msgStr = JSON.stringify({ type: "heartbeat", state: "screen" });
      pcMapRef.current.forEach(p => {
        if (p.controlChannel?.readyState === 'open') p.controlChannel.send(msgStr);
      });
      // Background tab fps workaround for chromium
      if (document.hidden && activeStreamRef.current) {
        const track = activeStreamRef.current.getVideoTracks()[0];
        if (track?.enabled) { track.enabled = false; track.enabled = true; }
      }
    }, 500);
    return () => clearInterval(interval);
  }, [isConnected]);

  // ─── r3: Sender controls for R2 local media (send playback-control to receivers) ─
  const sendPlaybackControl = useCallback((action: string, extra?: Record<string, any>) => {
    if (!signalingRef.current || !mediaSessionIdRef.current) return;
    const cmd = {
      type: "playback-control",
      action,
      commandId: crypto.randomUUID(),
      source: "sender",
      sentAt: Date.now(),
      mediaSessionId: mediaSessionIdRef.current,
      ...extra,
    };
    console.log(`[Control] Sender → receivers: action=${action}`);
    signalingRef.current.send(cmd as any);
  }, []);

  // ─── Cast Screen / Tab ───────────────────────────────────────────────────────
  const handleCastChromeTab = async () => {
    if (!roomId) { alert("Please generate or enter a room ID first"); return; }
    if (isStartingCastRef.current) return;
    isStartingCastRef.current = true;

    let stream: MediaStream;
    try {
      // r3: No artificial resolution ceiling — capture at highest available quality
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          // Don't specify max width/height — let the browser/user choose the best source
          frameRate: { ideal: 60, max: 60 },
        },
        audio: true,
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        if ('contentHint' in videoTrack) (videoTrack as any).contentHint = 'motion';
        const settings = videoTrack.getSettings();
        console.log(`[MEDIA] source=tab captured=${settings.width}x${settings.height} fps=${settings.frameRate} transport=webrtc`);
      }
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
        console.info("[Sender] Screen capture cancelled by user.");
      } else {
        console.error("Screen capture failed", err);
      }
      if (!activeStreamRef.current) setStatus("Screen capture cancelled or failed.");
      isStartingCastRef.current = false;
      return;
    }

    try {
      if (activeStreamRef.current) activeStreamRef.current.getTracks().forEach(t => t.stop());
      pcMapRef.current.forEach(pc => pc.close());
      pcMapRef.current.clear();
      lastNegotiation.current.clear();
      receiverSessionMapRef.current.clear();
      pcConfigRef.current = null;
      mediaSessionIdRef.current = null;

      currentModeRef.current = "screen";
      activeStreamRef.current = stream;

      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack?.getSettings() || {};
      const capturedRes = settings.width && settings.height
        ? `${settings.width}x${settings.height}`
        : "Screen Capture";

      setStatus("Casting tab/screen...");
      setMediaInfo({ filename: "Screen / Tab Capture", resolution: capturedRes, transport: "webrtc" });
      setIsConnected(true);
      await acquireWakeLock();

      console.log("[Sender] Triggering negotiation for known receivers");
      knownReceiversRef.current.forEach(recId => startNegotiation(recId));

      stream.getVideoTracks()[0].onended = () => stopCasting();
    } catch (err) {
      console.error("Error setting up cast session", err);
      setStatus("Error setting up cast session.");
    } finally {
      isStartingCastRef.current = false;
    }
  };

  // ─── r3: Cast Local Media via R2 ─────────────────────────────────────────────
  const handleCastLocalMedia = () => { fileInputRef.current?.click(); };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so selecting the same file again fires onChange
    e.target.value = "";

    if (!roomId) { alert("Please generate or enter a room ID first"); return; }

    const ownerToken = sessionStorage.getItem("ownerToken");
    if (!ownerToken) { alert("Room token missing. Please generate a room first."); return; }

    // Validate MIME type
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) {
      alert("Only video and image files are supported.");
      return;
    }

    // File size guard: warn for very large files (>4 GB) but don't block
    if (file.size > 4 * 1024 * 1024 * 1024) {
      const ok = confirm(`This file is ${(file.size / 1024 / 1024 / 1024).toFixed(1)} GB. Upload may take a while. Continue?`);
      if (!ok) return;
    }

    // ── Get source dimensions if video ──
    let sourceWidth: number | undefined;
    let sourceHeight: number | undefined;
    let duration: number | undefined;

    if (isVideo) {
      try {
        const blobUrl = URL.createObjectURL(file);
        await new Promise<void>((resolve) => {
          const v = document.createElement("video");
          v.preload = "metadata";
          v.src = blobUrl;
          v.onloadedmetadata = () => {
            sourceWidth = v.videoWidth;
            sourceHeight = v.videoHeight;
            duration = isFinite(v.duration) ? v.duration : undefined;
            URL.revokeObjectURL(blobUrl);
            resolve();
          };
          v.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(); };
          setTimeout(() => { URL.revokeObjectURL(blobUrl); resolve(); }, 5000);
        });
      } catch {}
    }

    let resolution = "";
    if (sourceHeight) {
      if (sourceHeight >= 2160) resolution = "4K";
      else if (sourceHeight >= 1080) resolution = "1080p";
      else if (sourceHeight >= 720) resolution = "720p";
      else resolution = `${sourceWidth}x${sourceHeight}`;
    }
    if (!resolution) resolution = isImage ? "Image" : "Video";

    // ── Check receiver decode capability (client-side heuristic) ──
    let canPlay = "";
    if (isVideo) {
      const testVid = document.createElement("video");
      canPlay = testVid.canPlayType(file.type);
      console.log(`[MEDIA] source=${file.name} size=${(file.size/1024/1024).toFixed(1)}MB mime=${file.type} canPlayType=${canPlay || "empty"} resolution=${resolution}`);
    }

    // ── Stop previous session ──
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach(t => t.stop());
      activeStreamRef.current = null;
    }
    pcMapRef.current.forEach(pc => pc.close());
    pcMapRef.current.clear();
    lastNegotiation.current.clear();
    pcConfigRef.current = null;
    mediaSessionIdRef.current = crypto.randomUUID();
    currentModeRef.current = "local-media";

    setIsUploading(true);
    setStatus(`Uploading ${file.name}...`);
    setUploadProgress({ loaded: 0, total: file.size, phase: "uploading" });
    setIsConnected(true);
    await acquireWakeLock();

    try {
      const mediaUrl = await uploadToR2(file, roomId, ownerToken, (p) => {
        setUploadProgress(p);
        const pct = Math.round((p.loaded / p.total) * 100);
        setStatus(p.phase === "finalizing"
          ? `Finalizing upload...`
          : `Uploading ${file.name}... ${pct}%`);
      });

      // ── Store session metadata for broadcast ──
      const session = {
        mediaUrl,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        size: file.size,
        duration,
        sourceWidth,
        sourceHeight,
      };
      (window as any).__wcMediaSession = session;

      setStatus("Broadcasting to receivers...");
      setMediaInfo({ filename: file.name, resolution, transport: "r2" });
      setUploadProgress(null);
      setIsUploading(false);

      console.log(`[MEDIA] source=${file.name} transport=r2 url=${mediaUrl} resolution=${resolution}`);

      // ── Broadcast media-session to all current receivers ──
      _broadcastMediaSession();

      // ── Also broadcast to any receiver that joins later (handled in receiver-joined handler) ──
    } catch (err: any) {
      console.error("[Sender] R2 upload failed:", err);
      setStatus(`Upload failed: ${err.message}`);
      setIsUploading(false);
      setUploadProgress(null);
      setIsConnected(false);
      mediaSessionIdRef.current = null;
    }
  };

  // ─── Stop casting ─────────────────────────────────────────────────────────────
  const stopCasting = () => {
    signalingRef.current?.send({ type: "cast-stopped" } as any);

    pcMapRef.current.forEach(pc => pc.close());
    pcMapRef.current.clear();
    lastNegotiation.current.clear();
    receiverSessionMapRef.current.clear();
    pcConfigRef.current = null;

    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach(track => track.stop());
      activeStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      if (videoRef.current.src) URL.revokeObjectURL(videoRef.current.src);
      videoRef.current.src = "";
    }

    mediaSessionIdRef.current = null;
    (window as any).__wcMediaSession = null;

    releaseWakeLock();
    setIsConnected(false);
    setStatus("Not Connected");
    setConnectedCount(0);
    setMediaInfo(null);
    setUploadProgress(null);
    setIsUploading(false);
  };

  // ─── Sender controls for local R2 media ──────────────────────────────────────
  const handleSenderPlay = () => {
    // Include last known receiver position so receiver resumes from where it currently is
    const knownState = Array.from(receiverPlaybackStateRef.current.values())[0];
    const ct = knownState?.currentTime;
    sendPlaybackControl("play", typeof ct === "number" ? { currentTime: ct } : undefined);
  };
  const handleSenderPause = () => sendPlaybackControl("pause");
  const handleSenderRestart = () => sendPlaybackControl("restart", { currentTime: 0 });

  // ─── UI ───────────────────────────────────────────────────────────────────────
  const uploadPct = uploadProgress ? Math.round((uploadProgress.loaded / uploadProgress.total) * 100) : 0;

  return (
    <div className="min-h-screen text-foreground flex flex-col p-8 md:p-12 max-w-7xl mx-auto">
      <header className="mb-12 flex justify-between items-center animate-float">
        <div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight bg-clip-text text-transparent bg-linear-to-r from-blue-400 to-indigo-500 pb-1">
            WEBCAST HUB
          </h1>
          <p className="text-muted-foreground mt-2 text-lg font-light">Cast anything to your screen, instantly.</p>
        </div>
        <button className="p-3 hover:bg-secondary/50 rounded-full transition-all hover:scale-110 hover:shadow-[0_0_15px_rgba(59,130,246,0.3)]">
          <Settings className="w-6 h-6 text-blue-400" />
        </button>
      </header>

      <div className="mb-10 flex flex-col sm:flex-row gap-4 items-start sm:items-center">
        <div className="relative group">
          <div className="absolute -inset-0.5 bg-linear-to-r from-blue-500 to-indigo-500 rounded-lg blur opacity-30 group-hover:opacity-60 transition duration-500 pointer-events-none"></div>
          <input
            type="text"
            placeholder="Enter Room Code"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value.toUpperCase())}
            className="relative bg-black/50 text-foreground border border-white/10 rounded-lg px-6 py-3 uppercase font-mono tracking-[0.3em] text-lg outline-none transition-colors w-full sm:w-auto text-center"
          />
        </div>
        <button
          onClick={generateRoom}
          className="relative px-6 py-3 rounded-lg font-medium bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_20px_rgba(37,99,235,0.4)] hover:shadow-[0_0_25px_rgba(37,99,235,0.6)] hover:-translate-y-0.5 transition-all w-full sm:w-auto"
        >
          Generate New
        </button>
      </div>

      <input type="file" ref={fileInputRef} className="hidden" accept="video/*,image/*" onChange={handleFileChange} />
      {/* Hidden video element — kept in DOM only as a fallback reference; not used for R2 path */}
      <video ref={videoRef} className="fixed top-[-9999px] left-[-9999px] opacity-0 pointer-events-none" muted playsInline preload="none" />

      <main className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
        <div onClick={handleCastChromeTab} className="glass-card p-8 rounded-2xl flex flex-col items-start hover:border-blue-500/50 hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:-translate-y-1 transition-all cursor-pointer group">
          <div className="w-14 h-14 bg-linear-to-br from-blue-500/20 to-indigo-500/20 border border-white/5 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all relative">
            <Tv className="w-7 h-7 text-blue-400 group-hover:text-blue-300 relative z-10" />
          </div>
          <h2 className="text-2xl font-semibold mb-3 tracking-wide">Cast Screen / Tab</h2>
          <p className="text-muted-foreground/80 leading-relaxed font-light">Instantly cast your browser tab or entire screen directly from the web.</p>
        </div>

        <div onClick={isUploading ? undefined : handleCastLocalMedia} className={`glass-card p-8 rounded-2xl flex flex-col items-start hover:border-indigo-500/50 hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:-translate-y-1 transition-all group ${isUploading ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}>
          <div className="w-14 h-14 bg-linear-to-br from-indigo-500/20 to-pink-500/20 border border-white/5 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:shadow-[0_0_20px_rgba(99,102,241,0.3)] transition-all">
            <Tv className="w-7 h-7 text-indigo-400 group-hover:text-indigo-300" />
          </div>
          <h2 className="text-2xl font-semibold mb-3 tracking-wide">Cast Local Media</h2>
          <p className="text-muted-foreground/80 leading-relaxed font-light">
            {isUploading
              ? `Uploading... ${uploadPct}%`
              : "Play downloaded videos and high-res images on the big screen."}
          </p>
          {isUploading && uploadProgress && (
            <div className="w-full mt-4">
              <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${uploadPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div onClick={() => window.open('/receiver', '_blank', 'noopener')} className="glass-card p-8 rounded-2xl flex flex-col items-start hover:border-emerald-500/50 hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:-translate-y-1 transition-all cursor-pointer group">
          <div className="w-14 h-14 bg-linear-to-br from-emerald-500/20 to-teal-500/20 border border-white/5 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all">
            <MonitorSmartphone className="w-7 h-7 text-emerald-400 group-hover:text-emerald-300" />
          </div>
          <h2 className="text-2xl font-semibold mb-3 tracking-wide">Connect Receiver</h2>
          <p className="text-muted-foreground/80 leading-relaxed font-light">Use this device as a display for incoming casts from anywhere.</p>
        </div>
      </main>

      <section className="mt-16 pt-8 relative">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-3xl h-px bg-linear-to-r from-transparent via-white/20 to-transparent"></div>
        <h3 className="text-xl font-semibold mb-6 tracking-wide">Active Session</h3>

        <div className="glass-card p-6 md:p-8 rounded-2xl flex flex-col gap-6 relative overflow-hidden">
          {isConnected && <div className="absolute -top-24 -right-24 w-48 h-48 bg-blue-500/20 rounded-full blur-[50px] pointer-events-none"></div>}

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 relative z-10">
            <div className="flex items-center gap-5">
              <div className="relative">
                <div className={`w-4 h-4 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-red-500'}`}></div>
                {isConnected && <div className="absolute inset-0 bg-emerald-400 rounded-full animate-ping opacity-75"></div>}
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <p className="font-semibold text-lg">
                    {!isConnected ? status :
                     receiverCount === 0 ? "Waiting for receiver..." :
                     `Casting to ${receiverCount} receiver(s)`}
                  </p>
                  {(mediaInfo?.resolution === "4K") && (
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase tracking-wider">4K UHD</span>
                  )}
                  {mediaInfo?.transport === "r2" && (
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase tracking-wider">Direct Stream</span>
                  )}
                </div>
                <p className="text-muted-foreground font-light">
                  {isConnected ? (
                    mediaInfo ? `Playing: ${mediaInfo.filename} (${mediaInfo.resolution})` : `Streaming to Room: ${roomId}`
                  ) : 'No active casting room'}
                </p>
              </div>
            </div>
            <button
              onClick={stopCasting}
              disabled={!isConnected}
              className={`px-6 py-3 rounded-lg font-medium transition-all shadow-lg ${isConnected ? 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:shadow-[0_0_20px_rgba(239,68,68,0.2)]' : 'bg-secondary/50 text-muted-foreground opacity-50 cursor-not-allowed border border-white/5'}`}
            >
              Stop Casting
            </button>
          </div>

          {/* Sender-side playback controls — only shown for R2 local media */}
          {isConnected && mediaInfo?.transport === "r2" && mediaInfo?.filename !== "Screen Capture" && (
            <div className="flex gap-4 border-t border-white/5 pt-6 mt-2 relative z-10">
              <button onClick={handleSenderPlay} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2.5 rounded-lg shadow-[0_0_15px_rgba(37,99,235,0.3)] hover:-translate-y-0.5 transition-all font-medium">Play</button>
              <button onClick={handleSenderPause} className="bg-secondary/80 hover:bg-secondary border border-white/5 px-6 py-2.5 rounded-lg hover:-translate-y-0.5 transition-all font-medium">Pause</button>
              <button onClick={handleSenderRestart} className="bg-secondary/80 hover:bg-secondary border border-white/5 px-6 py-2.5 rounded-lg hover:-translate-y-0.5 transition-all font-medium">Restart</button>
            </div>
          )}
          {/* Screen cast playback controls are not applicable — it's a live stream */}
        </div>
      </section>
    </div>
  );
}
