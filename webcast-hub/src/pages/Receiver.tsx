import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Settings, Loader2, SkipBack, SkipForward } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { getGlobalSignaling } from "../webrtc/SignalingClient";
import { WebRTCPeerConnection, startReceiverStatsLoop } from "../webrtc/WebRTCPeerConnection";
import { getIceServers, makePcConfig } from "../webrtc/iceServers";
import { JITTER_TARGET_MS } from "../webrtc/qualityConfig";

// ─── Buffer monitor helper ────────────────────────────────────────────────────
function getBufferedAhead(video: HTMLVideoElement): number {
  if (!video.buffered || video.buffered.length === 0) return 0;
  const ct = video.currentTime;
  for (let i = video.buffered.length - 1; i >= 0; i--) {
    if (video.buffered.start(i) <= ct + 0.1) {
      return Math.max(0, video.buffered.end(i) - ct);
    }
  }
  return 0;
}

// ─── Decode capability check ──────────────────────────────────────────────────
function checkCanPlay(contentType: string): "probably" | "maybe" | "" {
  try {
    const v = document.createElement("video");
    return v.canPlayType(contentType) as "probably" | "maybe" | "";
  } catch {
    return "";
  }
}

export default function Receiver() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [inputCode, setInputCode] = useState("");

  const [status, setStatus] = useState<string>("Initializing...");
  const [hasMedia, setHasMedia] = useState<boolean>(false);
  const [senderConnected, setSenderConnected] = useState<boolean>(false);
  const [needsUserInteraction, setNeedsUserInteraction] = useState<boolean>(false);
  const [showRetry, setShowRetry] = useState<boolean>(false);

  // Pipeline type: "webrtc" = tab/screen cast, "r2" = local media direct stream
  const [pipelineType, setPipelineType] = useState<"webrtc" | "r2" | null>(null);

  // Custom Player States
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [mediaInfo, setMediaInfo] = useState<{filename?: string; resolution?: string; canPlayType?: string} | null>(null);
  const [webrtcState, setWebrtcState] = useState<string>("");
  const [bufferedAhead, setBufferedAhead] = useState(0);

  // r3: for WebRTC tab cast, isPlayback stays false (live stream — no seeking)
  // for R2 local media, isPlayback = true (seekable)
  const [isPlayback, setIsPlayback] = useState(false);

  // r3: command dedup set
  const processedCommandsRef = useRef<Set<string>>(new Set());
  const dcRef = useRef<RTCDataChannel | null>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playPromiseRef = useRef<Promise<void> | null>(null);
  // r3: signaling ref for sending playback-state back
  const signalingRef = useRef<ReturnType<typeof getGlobalSignaling> | null>(null);
  // r3: current media session id
  const mediaSessionIdRef = useRef<string | null>(null);
  // r3: buffering diagnostics
  const waitingCountRef = useRef(0);
  const stallCountRef = useRef(0);
  const startupTimeRef = useRef<number | null>(null);
  // r3-fix: pipelineType ref mirrors pipelineType state so closures (signaling useEffect) always read the current value
  const pipelineTypeRef = useRef<"webrtc" | "r2" | null>(null);
  // Keep ref in sync so closures can read current value without stale state (defined after ref so TDZ is not an issue)
  const _setPipelineType = (v: "webrtc" | "r2" | null) => { pipelineTypeRef.current = v; setPipelineType(v); };

  // ─── Safe play ───────────────────────────────────────────────────────────────
  const safePlay = useCallback(async () => {
    if (!videoRef.current) return;
    try {
      if (playPromiseRef.current) await playPromiseRef.current.catch(() => {});
      playPromiseRef.current = videoRef.current.play();
      await playPromiseRef.current;
      setNeedsUserInteraction(false);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.debug("[Receiver] play() interrupted (AbortError).");
      } else if (err.name === 'NotAllowedError') {
        console.warn("[Receiver] Autoplay prevented. Retrying muted.");
        if (videoRef.current) {
          videoRef.current.muted = true;
          setIsMuted(true);
          setNeedsUserInteraction(true);
          playPromiseRef.current = videoRef.current.play();
          playPromiseRef.current.catch(() => {});
        }
      } else {
        console.error("[Receiver] Play error:", err);
      }
    }
  }, []);

  const formatTime = (time: number) => {
    if (isNaN(time) || !isFinite(time)) return "--:--";
    const h = Math.floor(time / 3600);
    const m = Math.floor((time % 3600) / 60);
    const s = Math.floor(time % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
  };

  // ─── r3: Send playback-state back to sender ───────────────────────────────────
  const sendPlaybackState = useCallback((commandId?: string) => {
    const video = videoRef.current;
    const signaling = signalingRef.current;
    if (!video || !signaling || !mediaSessionIdRef.current) return;
    const ahead = getBufferedAhead(video);
    signaling.send({
      type: "playback-state",
      commandId,
      paused: video.paused,
      currentTime: video.currentTime,
      duration: isFinite(video.duration) ? video.duration : 0,
      volume: video.volume,
      muted: video.muted,
      bufferedAhead: ahead,
      readyState: video.readyState,
      appliedAt: Date.now(),
    } as any);
  }, []);

  // ─── r3: Apply sender playback-control command ───────────────────────────────
  const applyPlaybackControl = useCallback(async (ctrl: any) => {
    // Dedup
    if (processedCommandsRef.current.has(ctrl.commandId)) return;
    processedCommandsRef.current.add(ctrl.commandId);
    // Trim set size
    if (processedCommandsRef.current.size > 200) {
      const arr = Array.from(processedCommandsRef.current);
      processedCommandsRef.current = new Set(arr.slice(arr.length - 100));
    }

    const video = videoRef.current;
    if (!video) return;

    const latency = Date.now() - (ctrl.sentAt || Date.now());
    console.log(`[CONTROL] action=${ctrl.action} commandId=${ctrl.commandId?.slice(0, 8)} latency=${latency}ms source=${ctrl.source}`);

    switch (ctrl.action) {
      case "play":
        if (typeof ctrl.currentTime === "number" && Math.abs(video.currentTime - ctrl.currentTime) > 1) {
          video.currentTime = ctrl.currentTime;
        }
        await safePlay();
        break;
      case "pause":
        video.pause();
        break;
      case "seek":
        if (typeof ctrl.currentTime === "number") {
          video.currentTime = ctrl.currentTime;
        }
        break;
      case "restart":
        video.currentTime = 0;
        await safePlay();
        break;
      case "volume":
        if (typeof ctrl.volume === "number") {
          video.volume = ctrl.volume;
          setVolume(ctrl.volume);
        }
        break;
      case "mute":
        if (typeof ctrl.muted === "boolean") {
          video.muted = ctrl.muted;
          setIsMuted(ctrl.muted);
        }
        break;
      case "stop":
        video.pause();
        video.currentTime = 0;
        setHasMedia(false);
        break;
    }

    // Send ACK back to sender
    setTimeout(() => sendPlaybackState(ctrl.commandId), 100);
  }, [safePlay, sendPlaybackState]);

  // ─── r3: Receiver-side controls (act on local video immediately, then signal sender) ─
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (pipelineType === "r2") {
      // r3: act on local video immediately
      const commandId = crypto.randomUUID();
      processedCommandsRef.current.add(commandId); // mark so we don't apply our own command
      if (video.paused) {
        safePlay();
        // Signal sender
        signalingRef.current?.send({
          type: "playback-control",
          action: "play",
          commandId,
          source: "receiver",
          currentTime: video.currentTime,
          sentAt: Date.now(),
        } as any);
      } else {
        video.pause();
        signalingRef.current?.send({
          type: "playback-control",
          action: "pause",
          commandId,
          source: "receiver",
          sentAt: Date.now(),
        } as any);
      }
    } else if (pipelineType === "webrtc") {
      // For WebRTC tab cast — live stream, just toggle local muted state since it's live
      if (video.paused) safePlay();
      else video.pause();
    } else if (video.paused) {
      safePlay();
    } else {
      video.pause();
    }
  }, [pipelineType, safePlay]);

  const toggleMute = useCallback(() => {
    if (!videoRef.current) return;
    const newMuted = !videoRef.current.muted;
    videoRef.current.muted = newMuted;
    setIsMuted(newMuted);
    localStorage.setItem("webcast-muted", newMuted.toString());
  }, []);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    localStorage.setItem("webcast-volume", val.toString());
    if (videoRef.current) {
      videoRef.current.volume = val;
      if (val > 0) {
        setIsMuted(false);
        videoRef.current.muted = false;
        localStorage.setItem("webcast-muted", "false");
      }
    }
  }, []);

  // r3: seek acts on local video immediately, then signals sender
  const handleProgressChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const newTime = (val / 100) * duration;
    if (!videoRef.current) return;

    if (pipelineType === "r2") {
      // Seek local video immediately (HTTP range request handles it natively)
      videoRef.current.currentTime = newTime;
      const commandId = crypto.randomUUID();
      processedCommandsRef.current.add(commandId);
      signalingRef.current?.send({
        type: "playback-control",
        action: "seek",
        commandId,
        source: "receiver",
        currentTime: newTime,
        sentAt: Date.now(),
      } as any);
    }
    // For WebRTC — no seek (live stream)
  }, [duration, pipelineType]);

  const handleSkipBack = useCallback(() => {
    if (!videoRef.current || pipelineType !== "r2") return;
    const newTime = Math.max(0, videoRef.current.currentTime - 10);
    videoRef.current.currentTime = newTime;
    const commandId = crypto.randomUUID();
    processedCommandsRef.current.add(commandId);
    signalingRef.current?.send({ type: "playback-control", action: "seek", commandId, source: "receiver", currentTime: newTime, sentAt: Date.now() } as any);
  }, [pipelineType]);

  const handleSkipForward = useCallback(() => {
    if (!videoRef.current || pipelineType !== "r2") return;
    const newTime = Math.min(videoRef.current.duration || Infinity, videoRef.current.currentTime + 10);
    videoRef.current.currentTime = newTime;
    const commandId = crypto.randomUUID();
    processedCommandsRef.current.add(commandId);
    signalingRef.current?.send({ type: "playback-control", action: "seek", commandId, source: "receiver", currentTime: newTime, sentAt: Date.now() } as any);
  }, [pipelineType]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen();
    }
  };

  // ─── Restore preferences ─────────────────────────────────────────────────────
  useEffect(() => {
    const savedVol = localStorage.getItem("webcast-volume");
    const savedMuted = localStorage.getItem("webcast-muted");
    if (savedVol !== null) setVolume(parseFloat(savedVol));
    if (savedMuted !== null) setIsMuted(savedMuted === "true");
  }, []);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
    }
  }, [volume, isMuted]);

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT") return;
      switch (e.key.toLowerCase()) {
        case " ": case "k": e.preventDefault(); togglePlay(); break;
        case "j": case "arrowleft": e.preventDefault(); handleSkipBack(); break;
        case "l": case "arrowright": e.preventDefault(); handleSkipForward(); break;
        case "arrowup": e.preventDefault(); handleVolumeChange({ target: { value: Math.min(1, volume + 0.1).toString() } } as any); break;
        case "arrowdown": e.preventDefault(); handleVolumeChange({ target: { value: Math.max(0, volume - 0.1).toString() } } as any); break;
        case "m": toggleMute(); break;
        case "f": toggleFullscreen(); break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, handleSkipBack, handleSkipForward, volume, toggleMute, handleVolumeChange]);

  // ─── r3: Buffered-ahead monitor (throttled, ref-based to avoid re-renders) ────
  useEffect(() => {
    if (!hasMedia) return;
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const ahead = getBufferedAhead(video);
      setBufferedAhead(ahead);
      if (!video.paused && ahead < 2 && video.readyState >= 3) {
        console.warn(`[RECEIVER] bufferedAhead=${ahead.toFixed(1)}s readyState=${video.readyState} — BUFFERING_RISK`);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [hasMedia]);

  // ─── Main signaling + WebRTC setup ───────────────────────────────────────────
  useEffect(() => {
    console.log("[App] role=receiver build=2026-09-24-quality-r3");
    if (!roomId) return;

    setStatus("Connecting to signaling server...");
    const signaling = getGlobalSignaling(roomId, "receiver");
    signalingRef.current = signaling;

    let peer: WebRTCPeerConnection | null = null;
    let statsInterval: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const mediaStream = new MediaStream();
    let isSenderPresent = false;
    let retryCount = 0;
    let offerTimeout: ReturnType<typeof setTimeout> | null = null;

    const stopOfferLoop = () => {
      if (offerTimeout) clearTimeout(offerTimeout);
      setShowRetry(false);
    };

    const requestOfferLoop = () => {
      if (offerTimeout) clearTimeout(offerTimeout);
      if (!isSenderPresent) return;
      signaling.send({ type: "request-offer", receiverId: signaling.clientId, sessionId: signaling.sessionId } as any);
      retryCount++;
      if (retryCount >= 5) {
        setShowRetry(true);
        setStatus("Sender present but not responding...");
      }
      const nextDelay = retryCount <= 10 ? 3000 : 10000;
      offerTimeout = setTimeout(requestOfferLoop, nextDelay);
    };

    const startOfferLoop = () => {
      retryCount = 0;
      setShowRetry(false);
      requestOfferLoop();
    };

    signaling.onConnect = () => setStatus("Waiting for sender...");

    const unsub = signaling.on(async (msg) => {
      if (msg.type === "room-state") {
        isSenderPresent = msg.senderPresent || false;
        setSenderConnected(isSenderPresent);
        if (isSenderPresent) {
          setStatus("Sender present. Requesting stream...");
          startOfferLoop();
        } else {
          setStatus("Waiting for sender...");
          stopOfferLoop();
        }
      } else if (msg.type === "sender-joined") {
        isSenderPresent = true;
        setSenderConnected(true);
        setStatus("Sender joined. Requesting stream...");
        mediaStream.getTracks().forEach(t => mediaStream.removeTrack(t));
        startOfferLoop();
      } else if (msg.type === "peer-left" && msg.role === "sender") {
        isSenderPresent = false;
        setSenderConnected(false);
        stopOfferLoop();
      } else if (msg.type === "cast-stopped") {
        // Sender stopped — pause and clear video
        if (videoRef.current) {
          videoRef.current.pause();
          // For R2, keep showing the last frame (sender may resume)
        }
        setStatus("Cast ended by sender");
      } else if (msg.type === "offer") {
        // WebRTC offer (tab/screen cast pipeline)
        stopOfferLoop();
        setStatus("Negotiating connection...");

        // r3: WebRTC pipeline — initialize PC if needed
        if (!peer) {
          const iceServers = await getIceServers();
          const pcConfig = makePcConfig(iceServers);
          peer = new WebRTCPeerConnection(signaling, undefined, undefined, pcConfig);
          initPeer(peer);
        }
      } else if ((msg as any).type === "media-session") {
        // r3: R2 direct streaming pipeline
        const session = msg as any;
        console.log(`[MEDIA] Received media-session: filename=${session.filename} size=${(session.size/1024/1024).toFixed(1)}MB url=${session.mediaUrl}`);

        // Check decode capability
        const cap = session.contentType ? checkCanPlay(session.contentType) : "";
        if (cap === "" && session.contentType) {
          console.warn(`[RECEIVER] decode-capability: UNSUPPORTED contentType=${session.contentType}`);
          setMediaInfo(prev => ({ ...prev, resolution: prev?.resolution || "Unknown", canPlayType: "unsupported" }));
        } else {
          console.log(`[RECEIVER] decode-capability: ${cap || "maybe"} contentType=${session.contentType}`);
        }

        // Report capability back to sender
        signaling.send({ type: "decode-capability", canPlayType: cap, contentType: session.contentType } as any);

        stopOfferLoop();
        mediaSessionIdRef.current = session.mediaSessionId;

        const video = videoRef.current;
        if (!video) return;

        // Clear any WebRTC srcObject
        if (video.srcObject) {
          video.srcObject = null;
          if (peer) { peer.close(); peer = null; }
        }

        // Set src to the R2 media URL (Worker serves it with Range support)
        video.src = session.mediaUrl;
        video.preload = "auto";
        video.load();

        _setPipelineType("r2");
        setIsPlayback(true);
        setHasMedia(true);
        startupTimeRef.current = Date.now();

        let resLabel = "";
        if (session.sourceHeight) {
          if (session.sourceHeight >= 2160) resLabel = "4K";
          else if (session.sourceHeight >= 1080) resLabel = "1080p";
          else if (session.sourceHeight >= 720) resLabel = "720p";
          else resLabel = `${session.sourceWidth}x${session.sourceHeight}`;
        }

        setMediaInfo({ filename: session.filename, resolution: resLabel || "Video", canPlayType: cap });
        setStatus("");
        console.log(`[RECEIVER] readyState=${video.readyState} src=${session.mediaUrl.slice(-40)}`);
      } else if ((msg as any).type === "playback-control") {
        // r3: sender or another receiver sent a control
        const ctrl = msg as any;
        // Use pipelineTypeRef (not state) to avoid stale closure — pipelineType in this closure is always null
        const currentPipelineType = pipelineTypeRef.current;
        if (ctrl.source !== "receiver" || ctrl.commandId) {
          // Apply if from sender, or if it's our own dedup (commandId already in set — skip)
          if (currentPipelineType === "r2" || ctrl.source === "sender") {
            await applyPlaybackControl(ctrl);
          }
        }
      }
      // Legacy signaling handlers (r1/r2 compat)
      else if (msg.type === "media-url") {
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.src = msg.url;
          setHasMedia(true);
          setMediaInfo({ filename: msg.filename, resolution: msg.resolution });
          setStatus("");
        }
      } else if (msg.type === "media-play") {
        safePlay();
      } else if (msg.type === "media-pause") {
        videoRef.current?.pause();
      } else if (msg.type === "media-seek") {
        if (videoRef.current) videoRef.current.currentTime = msg.time;
      }
    });

    function initPeer(p: WebRTCPeerConnection) {
      p.onTrack = (track) => {
        console.log("[Receiver] Received track:", track.kind);

        // Set jitter buffer hint for live stream
        p.pc.getReceivers().forEach(receiver => {
          try {
            const targetMs = JITTER_TARGET_MS["screen"];
            if ('jitterBufferTarget' in receiver) {
              (receiver as any).jitterBufferTarget = targetMs;
            } else if ('playoutDelayHint' in receiver) {
              (receiver as any).playoutDelayHint = targetMs / 1000;
            }
          } catch {}
        });

        if (!mediaStream.getTracks().includes(track)) mediaStream.addTrack(track);

        const video = videoRef.current;
        if (video) {
          // Clear R2 src if we switch to WebRTC
          if (video.src) video.src = "";
          if (video.srcObject !== mediaStream) video.srcObject = mediaStream;

          _setPipelineType("webrtc");
          setIsPlayback(false); // WebRTC tab cast is live — no seeking
          setHasMedia(true);
          setMediaInfo(prev => ({ ...prev, resolution: prev?.resolution || "Live Stream" }));
          setStatus("");
          startupTimeRef.current = Date.now();
          safePlay();

          if (!statsInterval) {
            statsInterval = startReceiverStatsLoop(p.pc, () => stopped);
          }
        }
      };

      p.pc.ondatachannel = (e) => {
        if (e.channel.label === "control") {
          dcRef.current = e.channel;
          e.channel.onmessage = (evt) => {
            try {
              const msg = JSON.parse(evt.data);
              if (msg.type === "heartbeat") {
                // Legacy heartbeat from sender
                setIsPlayback(msg.state === "playback");
                if (msg.state === "playback") {
                  setCurrentTime(msg.time);
                  setDuration(msg.duration);
                  setIsPlaying(!msg.paused);
                  if (msg.duration > 0) setProgress((msg.time / msg.duration) * 100);
                }
              }
            } catch {}
          };
        }
      };

      p.onConnectionStateChange = (state) => {
        console.log("[Receiver] WebRTC state:", state);
        setWebrtcState(state);
        if (state === "disconnected" || state === "failed") {
          setStatus("Stream disconnected / Reconnecting...");
          if (isSenderPresent) startOfferLoop();
        } else if (state === "connecting") {
          setStatus("Connecting...");
        } else if (state === "connected") {
          setStatus("");
          stopOfferLoop();
        }
      };
    }

    (window as any).__wcStats = () => peer ? {
      state: peer.pc.connectionState,
      ice: peer.pc.iceConnectionState,
      signaling: peer.pc.signalingState,
      pipeline: pipelineType,
    } : {};

    (window as any)._manualRetryOffer = () => { if (isSenderPresent) startOfferLoop(); };

    signaling.connect();

    return () => {
      stopped = true;
      unsub();
      if (statsInterval) clearInterval(statsInterval);
      if (peer) peer.close();
      stopOfferLoop();
      delete (window as any)._manualRetryOffer;
    };
  }, [roomId]);

  // ─── Video event handlers (ref-based to avoid react re-render spam) ───────────
  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const ct = video.currentTime;
    const dur = isFinite(video.duration) ? video.duration : 0;
    setCurrentTime(ct);
    if (dur > 0) setProgress((ct / dur) * 100);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const dur = isFinite(video.duration) ? video.duration : 0;
    setDuration(dur);
    console.log(`[RECEIVER] loadedmetadata duration=${dur.toFixed(1)}s readyState=${video.readyState}`);
  }, []);

  const onCanPlay = useCallback(() => {
    setIsBuffering(false);
    const video = videoRef.current;
    if (!video || !hasMedia) return;
    // Auto-start for R2 media
    if (pipelineType === "r2" && video.paused && video.currentTime === 0) {
      safePlay();
    }
    if (startupTimeRef.current) {
      console.log(`[RECEIVER] canplay startupTime=${Date.now() - startupTimeRef.current}ms`);
      startupTimeRef.current = null;
    }
  }, [hasMedia, pipelineType, safePlay]);

  const onWaiting = useCallback(() => {
    setIsBuffering(true);
    waitingCountRef.current++;
    console.warn(`[RECEIVER] waiting event — BUFFERING (count=${waitingCountRef.current}) bufferedAhead=${getBufferedAhead(videoRef.current!).toFixed(1)}s`);
  }, []);

  const onStalled = useCallback(() => {
    stallCountRef.current++;
    console.warn(`[RECEIVER] stalled event (count=${stallCountRef.current})`);
  }, []);

  const onPlaying = useCallback(() => {
    setIsBuffering(false);
    setIsPlaying(true);
    console.log(`[RECEIVER] playing event readyState=${videoRef.current?.readyState}`);
  }, []);

  const onError = useCallback(() => {
    const video = videoRef.current;
    if (!video?.error) return;
    console.error(`[RECEIVER] video error code=${video.error.code} message=${video.error.message}`);
    if (video.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      setStatus("This format is not supported by your browser.");
      setMediaInfo(prev => ({ ...prev, canPlayType: "unsupported" }));
    }
  }, []);

  // ─── UI ───────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen text-foreground flex flex-col items-center justify-center relative overflow-hidden">
      {/* Background blobs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-[100px] animate-pulse-slow pointer-events-none -z-10"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-600/20 rounded-full blur-[100px] animate-pulse-slow pointer-events-none -z-10" style={{ animationDelay: '2s' }}></div>

      {roomId ? (
        <>
          <div
            className={`absolute inset-0 z-20 ${hasMedia ? 'opacity-100' : 'opacity-0'} transition-opacity duration-700 bg-black flex items-center justify-center`}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setShowControls(false)}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="w-full h-full object-contain"
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMetadata}
              onWaiting={onWaiting}
              onStalled={onStalled}
              onPlaying={onPlaying}
              onCanPlay={onCanPlay}
              onError={onError}
            />

            {/* Loading / Buffering */}
            {isBuffering && !needsUserInteraction && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-30 pointer-events-none">
                <div className="flex flex-col items-center gap-4">
                  <Loader2 className="w-16 h-16 text-blue-500 animate-spin" />
                  {pipelineType === "r2" && bufferedAhead < 2 && (
                    <p className="text-white/70 text-sm">Buffering... {bufferedAhead.toFixed(1)}s ahead</p>
                  )}
                </div>
              </div>
            )}

            {/* Tap to Start */}
            {needsUserInteraction && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-40 cursor-pointer backdrop-blur-sm"
                onClick={() => {
                  if (videoRef.current) {
                    videoRef.current.muted = false;
                    setIsMuted(false);
                    safePlay();
                  }
                }}
              >
                <div className="w-24 h-24 bg-blue-600 rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(37,99,235,0.6)] mb-6 animate-pulse">
                  <Play className="w-12 h-12 text-white ml-2" />
                </div>
                <p className="text-2xl font-bold tracking-wider uppercase bg-clip-text text-transparent bg-linear-to-r from-blue-400 to-indigo-400">Tap to Start Video</p>
                <p className="text-muted-foreground mt-2">Browser autoplay policy requires interaction</p>
              </div>
            )}

            {/* Reconnecting UI */}
            {(webrtcState === "disconnected" || webrtcState === "failed") && pipelineType === "webrtc" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-30 pointer-events-none backdrop-blur-sm">
                <div className="glass-card p-8 rounded-2xl flex flex-col items-center gap-4">
                  <Loader2 className="w-12 h-12 text-red-500 animate-spin" />
                  <p className="text-xl font-semibold tracking-wide">Connection lost. Reconnecting...</p>
                </div>
              </div>
            )}

            {/* r3: Unsupported format warning */}
            {mediaInfo?.canPlayType === "unsupported" && (
              <div className="absolute top-4 left-4 right-4 z-50 bg-red-900/80 border border-red-500/50 rounded-xl p-4 backdrop-blur-sm">
                <p className="text-red-300 font-medium">⚠️ This format may not be supported by your browser.</p>
                <p className="text-red-400/70 text-sm mt-1">The video may not play correctly on this device.</p>
              </div>
            )}

            {/* Controls Overlay */}
            <div className={`absolute bottom-0 left-0 right-0 p-6 bg-linear-to-t from-black/80 via-black/40 to-transparent transition-opacity duration-300 z-40 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
              {mediaInfo?.filename && (
                <div className="mb-4 flex items-center gap-3">
                  <span className="text-white/90 font-medium tracking-wide drop-shadow-md">{mediaInfo.filename}</span>
                  {mediaInfo?.resolution && (
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-white/10 text-white/70 border border-white/10 uppercase tracking-wider">
                      {mediaInfo.resolution}
                    </span>
                  )}
                  {pipelineType === "r2" && (
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase tracking-wider">Direct</span>
                  )}
                  {pipelineType === "webrtc" && (
                    <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30 uppercase tracking-wider">Live</span>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-3">
                {/* Progress Bar — only for R2 seekable media */}
                {isPlayback && pipelineType === "r2" && (
                  <div className="flex items-center gap-3 w-full">
                    <span className="text-xs font-mono">{formatTime(currentTime)}</span>
                    <input
                      type="range"
                      min="0" max="100"
                      value={isNaN(progress) ? 0 : progress}
                      onChange={handleProgressChange}
                      className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-blue-500 hover:h-2 transition-all"
                    />
                    <span className="text-xs font-mono">{formatTime(duration)}</span>
                  </div>
                )}

                {/* Main Controls */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-6">
                    {pipelineType === "r2" && (
                      <button onClick={handleSkipBack} className="hover:text-blue-400 transition-colors">
                        <SkipBack className="w-5 h-5 fill-current" />
                      </button>
                    )}
                    <button onClick={togglePlay} className="hover:text-blue-400 transition-colors">
                      {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current" />}
                    </button>
                    {pipelineType === "r2" && (
                      <button onClick={handleSkipForward} className="hover:text-blue-400 transition-colors">
                        <SkipForward className="w-5 h-5 fill-current" />
                      </button>
                    )}

                    <div className="flex items-center gap-2 group">
                      <button onClick={toggleMute} className="hover:text-blue-400 transition-colors">
                        {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                      </button>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        value={isMuted ? 0 : volume}
                        onChange={handleVolumeChange}
                        className="w-24 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-blue-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    {/* Stats / Settings */}
                    <div className="relative">
                      <button onClick={() => setShowSettings(!showSettings)} className="hover:text-blue-400 transition-colors">
                        <Settings className="w-5 h-5" />
                      </button>
                      {showSettings && (
                        <div className="absolute bottom-full right-0 mb-4 bg-black/90 border border-white/10 rounded-lg p-2 min-w-64 shadow-2xl backdrop-blur-md">
                          <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold px-3 py-2 border-b border-white/10 mb-1">Stats</p>
                          <div className="px-3 py-2 text-xs font-mono text-white/80 whitespace-pre">
                            {JSON.stringify((window as any).__wcStats?.(), null, 2)}
                          </div>
                          <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold px-3 py-2 border-b border-white/10 mb-1 mt-2">Diagnostics</p>
                          <div className="px-3 py-2 text-xs font-mono text-white/60 space-y-1">
                            <div>pipeline: {pipelineType || "none"}</div>
                            <div>bufferedAhead: {bufferedAhead.toFixed(1)}s</div>
                            <div>readyState: {videoRef.current?.readyState ?? "?"}</div>
                            <div>waitingCount: {waitingCountRef.current}</div>
                            <div>stallCount: {stallCountRef.current}</div>
                          </div>
                          <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold px-3 py-2 border-b border-white/10 mb-1 mt-2">Quality</p>
                          <div className="px-3 py-2 text-xs font-mono text-white/60 space-y-1">
                            <div>source: {mediaInfo?.resolution || "unknown"}</div>
                            <div>rendered: {videoRef.current?.videoWidth && videoRef.current?.videoHeight
                              ? `${videoRef.current.videoWidth}x${videoRef.current.videoHeight}`
                              : "—"}</div>
                            {pipelineType === "webrtc" && (
                              <div className="text-blue-400 font-medium">Live Stream</div>
                            )}
                            {pipelineType === "r2" && (
                              <div className="text-emerald-400 font-medium">Direct Stream (original codec)</div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <button onClick={toggleFullscreen} className="hover:text-blue-400 transition-colors">
                      <Maximize className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {!hasMedia && (
            <div className="z-30 text-center animate-float glass-card p-12 rounded-3xl border border-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)]">
              <div className="relative w-24 h-24 mx-auto mb-8">
                <div className="absolute inset-0 border-4 border-t-blue-500 border-r-indigo-500 border-b-transparent border-l-transparent rounded-full animate-spin"></div>
                <div className="absolute inset-2 border-4 border-t-transparent border-r-transparent border-b-purple-500 border-l-pink-500 rounded-full animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }}></div>
              </div>
              <h1 className="text-3xl font-bold tracking-[0.2em] uppercase bg-clip-text text-transparent bg-linear-to-r from-blue-400 to-indigo-400">{status}</h1>
              <p className="text-muted-foreground/80 mt-4 text-lg font-light">Room Code: <strong className="text-white tracking-widest">{roomId}</strong></p>
              <div className="mt-6 inline-flex items-center gap-3 bg-black/40 px-6 py-3 rounded-full border border-white/5">
                <div className={`w-3 h-3 rounded-full ${senderConnected ? 'bg-emerald-400 animate-pulse shadow-[0_0_10px_rgba(52,211,153,0.8)]' : 'bg-red-500'}`}></div>
                <span className="text-sm font-medium tracking-wide">{senderConnected ? "Sender Connected" : "Awaiting Sender"}</span>
              </div>

              {showRetry && !hasMedia && senderConnected && (
                <div className="mt-8 flex justify-center animate-fade-in">
                  <button
                    onClick={() => (window as any)._manualRetryOffer?.()}
                    className="bg-blue-600/80 hover:bg-blue-500 text-white px-8 py-2.5 rounded-full font-medium transition-all shadow-[0_0_15px_rgba(37,99,235,0.4)] flex items-center gap-2"
                  >
                    Retry Connection
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="text-center z-10 animate-float">
          <h1 className="text-5xl md:text-6xl font-bold tracking-tight mb-4 bg-clip-text text-transparent bg-linear-to-r from-blue-400 via-indigo-500 to-purple-500 pb-2">
            WEBCAST HUB
          </h1>
          <p className="text-2xl text-muted-foreground/80 font-light mb-12 tracking-wide">Ready to receive</p>

          <div className="glass-card rounded-3xl p-10 max-w-md w-full relative overflow-hidden group hover:shadow-[0_0_40px_rgba(99,102,241,0.2)] transition-shadow duration-500 border border-white/10 z-20">
            <div className="absolute -inset-1 bg-linear-to-r from-blue-500/0 via-indigo-500/10 to-purple-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-1000 pointer-events-none"></div>

            <p className="text-sm text-muted-foreground/60 uppercase tracking-[0.3em] font-semibold mb-6 relative z-10">Enter Room Code</p>

            <div className="relative inline-block mb-8 z-10 w-full">
              <div className="absolute inset-0 bg-blue-500/20 blur-2xl rounded-full pointer-events-none"></div>
              <input
                type="text"
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                placeholder="e.g. ABCD"
                maxLength={4}
                className="relative z-10 w-full bg-black/40 border border-white/20 text-white text-4xl md:text-5xl text-center font-mono tracking-[0.2em] rounded-2xl py-4 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all uppercase placeholder:opacity-30"
              />
            </div>

            <button
              onClick={() => {
                const code = inputCode.trim().toUpperCase();
                if (code.length === 4) navigate(`/receiver/${code}`);
              }}
              disabled={inputCode.length !== 4}
              className="relative z-10 w-full bg-linear-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold tracking-wider uppercase py-4 rounded-xl shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Connect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
