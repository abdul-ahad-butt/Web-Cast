import { useEffect, useRef, useState } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Settings, Loader2 } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { getGlobalSignaling } from "../webrtc/SignalingClient";
import { WebRTCPeerConnection } from "../webrtc/WebRTCPeerConnection";

export default function Receiver() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  
  const [inputCode, setInputCode] = useState("");
  
  const [status, setStatus] = useState<string>("Initializing...");
  const [hasMedia, setHasMedia] = useState<boolean>(false);
  const [senderConnected, setSenderConnected] = useState<boolean>(false);
  const [needsUserInteraction, setNeedsUserInteraction] = useState<boolean>(false);
  
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
  const [mediaInfo, setMediaInfo] = useState<{filename?: string, resolution?: string} | null>(null);
  const [webrtcState, setWebrtcState] = useState<string>("");
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const formatTime = (time: number) => {
    if (isNaN(time)) return "00:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) videoRef.current.play();
      else videoRef.current.pause();
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(videoRef.current.muted);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      if (val > 0) setIsMuted(false);
    }
  };

  const handleProgressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (videoRef.current) {
      const newTime = (val / 100) * duration;
      videoRef.current.currentTime = newTime;
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    if (!roomId) return;

    setStatus("Connecting to signaling server...");
    const signaling = getGlobalSignaling(roomId, "receiver");
    const peer = new WebRTCPeerConnection(signaling);

    signaling.onConnect = () => {
      setStatus("Waiting for sender...");
    };

    const originalOnMessage = signaling.onMessage;
    signaling.onMessage = (msg) => {
      originalOnMessage?.(msg);
      
      if (msg.type === "room-state") {
        if (msg.senderPresent) {
          setSenderConnected(true);
          setStatus("Sender present. Requesting stream...");
          signaling.send({ type: "request-offer", receiverId: signaling.clientId } as any);
        } else {
          setSenderConnected(false);
          setStatus("Waiting for sender...");
        }
      } else if (msg.type === "sender-joined") {
        setSenderConnected(true);
        setStatus("Sender joined. Requesting stream...");
        signaling.send({ type: "request-offer", receiverId: signaling.clientId } as any);
      } else if (msg.type === "peer-left" && msg.role === "sender") {
        setSenderConnected(false);
        setHasMedia(false);
        setStatus("Sender disconnected. Waiting...");
      } else if (msg.type === "media-url") {
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.src = msg.url;
          setHasMedia(true);
          setMediaInfo({ filename: msg.filename, resolution: msg.resolution });
          setStatus("");
        }
      } else if (msg.type === "media-play") {
        videoRef.current?.play().catch(console.error);
      } else if (msg.type === "media-pause") {
        videoRef.current?.pause();
      } else if (msg.type === "media-seek") {
        if (videoRef.current) videoRef.current.currentTime = msg.time;
      }
    };

    peer.onTrack = (track, streams) => {
      console.log("Received track", track.kind);
      if (streams && streams[0] && videoRef.current) {
        if (videoRef.current.srcObject !== streams[0]) {
          videoRef.current.srcObject = streams[0];
          setHasMedia(true);
          setMediaInfo(prev => ({ ...prev, resolution: prev?.resolution || "Live Stream" }));
          setStatus("");
          
          videoRef.current.play().catch(err => {
            console.error("Autoplay prevented:", err);
            setNeedsUserInteraction(true);
          });
        }
      }
    };

    peer.onConnectionStateChange = (state) => {
      console.log("WebRTC state:", state);
      setWebrtcState(state);
      if (state === "disconnected" || state === "failed") {
        // Do not immediately hide media, just show reconnecting
        setStatus("Stream disconnected / Reconnecting...");
      } else if (state === "connected") {
        setStatus("");
      }
    };

    signaling.connect();

    return () => {
      // Don't disconnect global signaling, just close peer
      peer.close();
    };
  }, [roomId]);

  return (
    <div className="min-h-screen text-foreground flex flex-col items-center justify-center relative overflow-hidden">
      {/* Background Animated Blobs */}
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
              className="w-full h-full object-contain"
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onTimeUpdate={() => {
                if (videoRef.current) {
                  setCurrentTime(videoRef.current.currentTime);
                  setProgress((videoRef.current.currentTime / duration) * 100);
                }
              }}
              onLoadedMetadata={() => {
                if (videoRef.current) setDuration(videoRef.current.duration);
              }}
              onWaiting={() => setIsBuffering(true)}
              onPlaying={() => setIsBuffering(false)}
              onCanPlay={() => setIsBuffering(false)}
            />

            {/* Loading/Buffering State */}
            {isBuffering && !needsUserInteraction && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-30 pointer-events-none">
                <Loader2 className="w-16 h-16 text-blue-500 animate-spin" />
              </div>
            )}
            
            {/* Tap to Start Overlay */}
            {needsUserInteraction && (
              <div 
                className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-40 cursor-pointer backdrop-blur-sm"
                onClick={() => {
                  videoRef.current?.play().then(() => setNeedsUserInteraction(false));
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
            {(webrtcState === "disconnected" || webrtcState === "failed") && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-30 pointer-events-none backdrop-blur-sm">
                <div className="glass-card p-8 rounded-2xl flex flex-col items-center gap-4">
                  <Loader2 className="w-12 h-12 text-red-500 animate-spin" />
                  <p className="text-xl font-semibold tracking-wide">Connection lost. Reconnecting...</p>
                </div>
              </div>
            )}

            {/* Custom Controls Overlay */}
            <div className={`absolute bottom-0 left-0 right-0 p-6 bg-linear-to-t from-black/80 via-black/40 to-transparent transition-opacity duration-300 z-40 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
              {mediaInfo?.filename && (
                <div className="mb-4 text-white/90 font-medium tracking-wide drop-shadow-md">
                  {mediaInfo.filename}
                </div>
              )}
              
              <div className="flex flex-col gap-3">
                {/* Progress Bar */}
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

                {/* Main Controls */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-6">
                    <button onClick={togglePlay} className="hover:text-blue-400 transition-colors">
                      {isPlaying ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current" />}
                    </button>
                    
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
                    {/* Quality Selector */}
                    <div className="relative">
                      <button onClick={() => setShowSettings(!showSettings)} className="hover:text-blue-400 transition-colors">
                        <Settings className="w-5 h-5" />
                      </button>
                      {showSettings && (
                        <div className="absolute bottom-full right-0 mb-4 bg-black/90 border border-white/10 rounded-lg p-2 min-w-37.5 shadow-2xl backdrop-blur-md">
                          <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold px-3 py-2 border-b border-white/10 mb-1">Quality</p>
                          <button className="w-full text-left px-3 py-2 hover:bg-white/10 rounded-md text-sm flex items-center justify-between text-blue-400 font-medium">
                            <div className="flex items-center gap-2">
                              {mediaInfo?.resolution || "Auto"}
                              {(mediaInfo?.resolution === "4K" || mediaInfo?.resolution === "2160p") && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase tracking-wider">4K UHD</span>
                              )}
                            </div>
                            <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                          </button>
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
                if (code.length === 4) {
                  navigate(`/receiver/${code}`);
                }
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
