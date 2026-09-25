import { Tv, MonitorSmartphone, Settings } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { SignalingClient, getGlobalSignaling } from "../webrtc/SignalingClient";
import { WebRTCPeerConnection, applyEncodingParams } from "../webrtc/WebRTCPeerConnection";
import { getIceServers, makePcConfig } from "../webrtc/iceServers";

export default function Dashboard() {
  const [roomId, setRoomId] = useState<string>("");
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("Not Connected");
  const [mediaInfo, setMediaInfo] = useState<{filename: string, resolution: string} | null>(null);
  const [receiverCount, setReceiverCount] = useState<number>(0);
  const [connectedCount, setConnectedCount] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const pcMapRef = useRef<Map<string, WebRTCPeerConnection>>(new Map());
  const activeStreamRef = useRef<MediaStream | null>(null);
  const isStartingCastRef = useRef<boolean>(false);
  const receiverSessionMapRef = useRef<Map<string, string>>(new Map());
  const lastNegotiation = useRef<Map<string, number>>(new Map());
  const knownReceiversRef = useRef<Set<string>>(new Set());
  const unsubsRef = useRef<(() => void)[]>([]);

  // CHANGE 4 – wakeLock ref
  const wakeLockRef = useRef<any>(null);
  // CHANGE 2 – cached RTCConfiguration
  const pcConfigRef = useRef<RTCConfiguration | null>(null);

  // Acquire/re-acquire wakeLock
  const acquireWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        console.log('[Sender] wakeLock acquired');
      } else {
        console.log('[Sender] wakeLock API not supported, skipping');
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
        console.log('[Sender] wakeLock released');
      }
    } catch {}
  }, []);

  useEffect(() => {
    console.log("[App] role=sender build=2026-09-24-quality-r2");

    // CHANGE 4 – re-acquire wakeLock on visibility change
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && activeStreamRef.current) {
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      // Cleanup on unmount
      unsubsRef.current.forEach(unsub => unsub());
      pcMapRef.current.forEach(pc => pc.close());
      pcMapRef.current.clear();
      if (signalingRef.current) {
        signalingRef.current.disconnect();
      }
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(t => t.stop());
      }
      releaseWakeLock();
    };
  }, [acquireWakeLock, releaseWakeLock]);

  // CHANGE 2 – determine cast mode from current stream
  const currentModeRef = useRef<"local-media" | "screen">("screen");

  // Re-apply bitrate to all PCs when receiver count changes
  const reapplyBitrate = useCallback(async () => {
    const count = pcMapRef.current.size;
    for (const pc of pcMapRef.current.values()) {
      pc.receiverCount = count;
      await applyEncodingParams(pc.pc, pc.mode, count);
    }
  }, []);

  const startNegotiation = useCallback(async (receiverId: string, reqSessionId?: string) => {
    const now = Date.now();
    const last = lastNegotiation.current.get(receiverId) || 0;
    
    let pc = pcMapRef.current.get(receiverId);

    const oldSessionId = receiverSessionMapRef.current.get(receiverId);
    let sessionChanged = false;
    if (reqSessionId && oldSessionId && reqSessionId !== oldSessionId) {
      sessionChanged = true;
    }
    if (reqSessionId) {
      receiverSessionMapRef.current.set(receiverId, reqSessionId);
    }

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
      // CHANGE 2 – fetch TURN servers once, then pass config to PC
      if (!pcConfigRef.current) {
        const iceServers = await getIceServers();
        pcConfigRef.current = makePcConfig(iceServers);
      }

      pc = new WebRTCPeerConnection(signalingRef.current, receiverId, undefined, pcConfigRef.current);
      // CHANGE 3/5 – set mode on PC
      pc.mode = currentModeRef.current;
      pc.receiverCount = pcMapRef.current.size + 1;

      // CHANGE 6 – wire ICE restart: only touches THIS receiver's PC
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
      const dc = pc.createDataChannel('control', { ordered: true });
      dc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          // Only process play/pause/seek if we are casting a local video (src is set)
          if (videoRef.current && videoRef.current.src) {
            if (msg.action === "play") {
              videoRef.current.play().catch(() => {});
            } else if (msg.action === "pause") {
              videoRef.current.pause();
            } else if (msg.action === "seek" && typeof msg.time === "number") {
              videoRef.current.currentTime = msg.time;
            }
          }
        } catch (err) {}
      };
      pcMapRef.current.set(receiverId, pc);

      // CHANGE 7 – start stats loop for this sender
      pc.startSenderStats();

      // Re-apply bitrate scaling now that receiver count may have changed
      const totalCount = pcMapRef.current.size;
      for (const p of pcMapRef.current.values()) {
        p.receiverCount = totalCount;
      }
    }

    lastNegotiation.current.set(receiverId, Date.now());
    
    // CHANGE 4 – use the SAME tracks for every PC; addTrack is deduplicated in WebRTCPeerConnection
    const senders = pc.pc.getSenders();
    activeStreamRef.current.getTracks().forEach(track => {
      if (!senders.find(s => s.track === track)) {
        pc!.addTrack(track, activeStreamRef.current!);
      }
    });
    
    await pc.createOffer();
  }, [reapplyBitrate]);

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
            }
          });
        }
      } else if (msg.type === "receiver-joined") {
        setReceiverCount(prev => prev + 1);
        knownReceiversRef.current.add(msg.receiverId!);
        startNegotiation(msg.receiverId!);
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
          }, 15000); // 15s grace period
        }
      } else if (msg.type === "request-offer") {
        knownReceiversRef.current.add(msg.receiverId!);
        startNegotiation(msg.receiverId!, msg.sessionId);
      } else if (msg.type as any === "delivery-failed") {
        const failedMsg = msg as any;
        if (failedMsg.to) lastNegotiation.current.delete(failedMsg.to);
      }
    }));

    (window as any).__wcStats = () => {
      let stats: any = {};
      pcMapRef.current.forEach((pc, id) => {
        stats[id] = {
          state: pc.pc.connectionState,
          ice: pc.pc.iceConnectionState,
          signaling: pc.pc.signalingState
        };
      });
      return stats;
    };

    signaling.onConnect = () => {
      setStatus("Waiting for receiver...");
      setIsConnected(true);
      // Sender doesn't need to blindly startNegotiation on connect anymore,
      // it will wait for receiver-joined or room-state.
    };
    signaling.onDisconnect = () => {
      setIsConnected(false);
      setStatus("Not Connected");
      setConnectedCount(0);
    };
    signaling.connect();
  };

  const generateRoom = async () => {
    try {
      let baseUrl = import.meta.env.VITE_API_URL || "https://webcast-hub.abdulahadbutt420.workers.dev";
      if (!import.meta.env.VITE_API_URL && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) baseUrl = "http://127.0.0.1:8787";
      baseUrl = baseUrl.replace(/\/$/, "");
      
      const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST" });
      const data = await res.json();
      setRoomId(data.roomId);
      sessionStorage.setItem("ownerToken", data.ownerToken);
      
      setupSignaling(data.roomId, data.ownerToken);
    } catch (e) {
      console.error(e);
      setRoomId(Math.random().toString(36).substring(2, 6).toUpperCase());
    }
  };





  useEffect(() => {
    if (!isConnected) return;
    const interval = setInterval(() => {
      const isLocal = videoRef.current && !!videoRef.current.src;
      const msg = isLocal ? {
        type: "heartbeat",
        state: "playback",
        time: videoRef.current?.currentTime || 0,
        duration: videoRef.current?.duration || 0,
        paused: !!videoRef.current?.paused
      } : {
        type: "heartbeat",
        state: "screen"
      };
      const msgStr = JSON.stringify(msg);
      pcMapRef.current.forEach(p => {
        if (p.controlChannel && p.controlChannel.readyState === 'open') {
          p.controlChannel.send(msgStr);
        }
      });

      // Background tab fps workaround for chromium
      if (document.hidden && activeStreamRef.current && !isLocal) {
        const track = activeStreamRef.current.getVideoTracks()[0];
        if (track && track.enabled) {
          track.enabled = false;
          track.enabled = true;
        }
      }
    }, 500);
    return () => clearInterval(interval);
  }, [isConnected]);

  const handleCastChromeTab = async () => {
    if (!roomId) {
      alert("Please generate or enter a room ID first");
      return;
    }
    if (isStartingCastRef.current) return;
    isStartingCastRef.current = true;
    
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } },
        audio: true
      });
      // Check if actual stream returned is larger than 1080p, and apply constraints if needed
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        // CHANGE 3 – use SCREEN_CONTENT_HINT for screen capture
        if ('contentHint' in videoTrack) (videoTrack as any).contentHint = 'motion';
        const settings = videoTrack.getSettings();
        if ((settings.height && settings.height > 1080) || (settings.width && settings.width > 1920)) {
          console.log(`[Sender] Downscaling screen capture from ${settings.width}x${settings.height} to 1080p limit`);
          try {
            await videoTrack.applyConstraints({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } });
          } catch (e) {
            console.warn("[Sender] applyConstraints failed, proceeding anyway", e);
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
        console.info("[Sender] Screen capture cancelled by user.");
      } else {
        console.error("Screen capture failed", err);
      }
      if (!activeStreamRef.current) {
        setStatus("Screen capture cancelled or failed.");
      }
      isStartingCastRef.current = false;
      return;
    }

    try {
      // Stop old tracks if they exist
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(t => t.stop());
      }
      // Recreate PCs for fresh session
      pcMapRef.current.forEach(pc => pc.close());
      pcMapRef.current.clear();
      lastNegotiation.current.clear();
      receiverSessionMapRef.current.clear();
      // CHANGE 2 – invalidate PC config cache so next session re-fetches
      pcConfigRef.current = null;

      // CHANGE 5 – set mode for this cast session
      currentModeRef.current = "screen";
      
      activeStreamRef.current = stream;
      setStatus("Casting screen...");
      setMediaInfo({ filename: "Screen Capture", resolution: "1080p" }); 
      setIsConnected(true);

      // CHANGE 4 – acquire wakeLock for screen cast
      await acquireWakeLock();
      
      console.log("[Sender] Triggering negotiation for known receivers");
      knownReceiversRef.current.forEach(recId => {
        startNegotiation(recId);
      });
      
      stream.getVideoTracks()[0].onended = () => {
        stopCasting();
      };
    } catch (err) {
      console.error("Error setting up cast session", err);
      setStatus("Error setting up cast session.");
    } finally {
      isStartingCastRef.current = false;
    }
  };

  const handleCastLocalMedia = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    console.log("[Sender] handleFileChange called, file present:", !!file);
    if (!file) return;

    if (!roomId) {
      alert("Please generate or enter a room ID first");
      return;
    }

    if (file.type.startsWith("video/") || file.type.startsWith("image/")) {
      setStatus(`Loading ${file.name}...`);
      
      if (!videoRef.current) return;
      // CHANGE 4 – use createObjectURL (not FileReader), set preload=auto
      videoRef.current.preload = "auto";
      const url = URL.createObjectURL(file);
      videoRef.current.src = url;
      
      await new Promise((resolve, reject) => {
        if (!videoRef.current) return resolve(null);
        videoRef.current.onloadedmetadata = resolve;
        videoRef.current.onerror = reject;
      }).catch(err => {
        console.error("[Sender] Error loading video metadata:", err);
      });

      let resolution = `${videoRef.current.videoWidth}x${videoRef.current.videoHeight}`;
      if (videoRef.current.videoHeight >= 2160) resolution = "4K";
      else if (videoRef.current.videoHeight >= 1080) resolution = "1080p";

      setMediaInfo({ filename: file.name, resolution });

      try {
        await videoRef.current.play();
      } catch (err) {
        console.error("Autoplay failed", err);
        alert("Autoplay blocked. Please try again.");
        URL.revokeObjectURL(url);
        return;
      }

      console.log("[Sender] Autoplay attempted. Checking captureStream API...");
      // Feature detect captureStream
      const captureStream = (videoRef.current as any).captureStream || (videoRef.current as any).mozCaptureStream;
      if (!captureStream) {
        console.error("[Sender] captureStream API is missing!");
        alert("Your browser does not support capturing video streams (captureStream API).");
        URL.revokeObjectURL(url);
        return;
      }

      console.log("[Sender] Getting captureStream");
      // CHANGE 4 – ONE captureStream per source; reuse it for all receivers
      const stream: MediaStream = captureStream.call(videoRef.current);
      console.log("[Sender] Stream tracks:", stream.getTracks().length);
      if (stream.getVideoTracks().length === 0) {
        console.log("[Sender] Waiting for video track...");
        await new Promise(resolve => {
          stream.onaddtrack = () => resolve(null);
          // Also set a timeout just in case
          setTimeout(() => resolve(null), 2000);
        });
        console.log("[Sender] Video track wait finished. Tracks:", stream.getTracks().length);
      }

      // Stop old tracks if they exist
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(t => t.stop());
      }
      // Recreate PCs for fresh session
      pcMapRef.current.forEach(pc => pc.close());
      pcMapRef.current.clear();
      lastNegotiation.current.clear();
      // CHANGE 2 – invalidate PC config cache
      pcConfigRef.current = null;

      // CHANGE 5 – set mode for this cast session
      currentModeRef.current = "local-media";

      // CHANGE 3 – content hint for local media
      stream.getVideoTracks().forEach(track => {
        if ('contentHint' in track) (track as any).contentHint = 'motion';
      });

      activeStreamRef.current = stream;
      setStatus(`Casting Local Media`);
      setIsConnected(true);

      // CHANGE 4 – acquire wakeLock for local media cast
      await acquireWakeLock();

      console.log("[Sender] Triggering negotiation for known receivers");
      knownReceiversRef.current.forEach(recId => {
        startNegotiation(recId);
      });
      
    } else {
      alert("Only video/image casting is implemented for now");
    }
  };

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

    // CHANGE 4 – release wakeLock on stop
    releaseWakeLock();
    
    setIsConnected(false);
    setStatus("Not Connected");
    setConnectedCount(0);
    setMediaInfo(null);
  };

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
      {/* Must be played inline to capture stream properly. Cannot be display:none, so we visually hide it instead. */}
      {/* CHANGE 4: off-screen but in DOM; position:fixed keeps it rendered. preload added in JS */}
      <video ref={videoRef} className="fixed top-[-9999px] left-[-9999px] opacity-0 pointer-events-none" controls muted playsInline loop preload="auto" />

      <main className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
        <div onClick={handleCastChromeTab} className="glass-card p-8 rounded-2xl flex flex-col items-start hover:border-blue-500/50 hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:-translate-y-1 transition-all cursor-pointer group">
          <div className="w-14 h-14 bg-linear-to-br from-blue-500/20 to-indigo-500/20 border border-white/5 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all relative">
            <Tv className="w-7 h-7 text-blue-400 group-hover:text-blue-300 relative z-10" />
          </div>
          <h2 className="text-2xl font-semibold mb-3 tracking-wide">Cast Screen / Tab</h2>
          <p className="text-muted-foreground/80 leading-relaxed font-light">Instantly cast your browser tab or entire screen directly from the web.</p>
        </div>

        <div onClick={handleCastLocalMedia} className="glass-card p-8 rounded-2xl flex flex-col items-start hover:border-indigo-500/50 hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:-translate-y-1 transition-all cursor-pointer group">
          <div className="w-14 h-14 bg-linear-to-br from-indigo-500/20 to-pink-500/20 border border-white/5 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:shadow-[0_0_20px_rgba(99,102,241,0.3)] transition-all">
            <Tv className="w-7 h-7 text-indigo-400 group-hover:text-indigo-300" />
          </div>
          <h2 className="text-2xl font-semibold mb-3 tracking-wide">Cast Local Media</h2>
          <p className="text-muted-foreground/80 leading-relaxed font-light">Play downloaded videos and high-res images on the big screen.</p>
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
                     connectedCount > 0 ? `Casting to ${receiverCount} receiver(s)` : 
                     `Connecting to ${receiverCount} receiver(s)...`}
                  </p>
                  {(mediaInfo?.resolution === "4K" || mediaInfo?.resolution === "2160p") && (
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase tracking-wider">4K UHD</span>
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

          {isConnected && mediaInfo?.filename !== "Screen Capture" && (
            <div className="flex gap-4 border-t border-white/5 pt-6 mt-2 relative z-10">
              <button onClick={() => videoRef.current?.play()} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2.5 rounded-lg shadow-[0_0_15px_rgba(37,99,235,0.3)] hover:-translate-y-0.5 transition-all font-medium">Play</button>
              <button onClick={() => videoRef.current?.pause()} className="bg-secondary/80 hover:bg-secondary border border-white/5 px-6 py-2.5 rounded-lg hover:-translate-y-0.5 transition-all font-medium">Pause</button>
              <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = 0; }} className="bg-secondary/80 hover:bg-secondary border border-white/5 px-6 py-2.5 rounded-lg hover:-translate-y-0.5 transition-all font-medium">Restart</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
