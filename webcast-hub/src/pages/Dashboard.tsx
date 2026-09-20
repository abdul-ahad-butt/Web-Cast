import { Tv, MonitorSmartphone, Settings } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { SignalingClient, getGlobalSignaling } from "../webrtc/SignalingClient";
import { WebRTCPeerConnection } from "../webrtc/WebRTCPeerConnection";

export default function Dashboard() {
  const [roomId, setRoomId] = useState<string>("");
  const [ownerToken, setOwnerToken] = useState<string>("");
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("Not Connected");
  const [mediaInfo, setMediaInfo] = useState<{filename: string, resolution: string} | null>(null);
  const [receiverCount, setReceiverCount] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const pcMapRef = useRef<Map<string, WebRTCPeerConnection>>(new Map());
  const activeStreamRef = useRef<MediaStream | null>(null);
  const lastNegotiation = useRef<Map<string, number>>(new Map());
  const unsubsRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    return () => {
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
    };
  }, []);

  const startNegotiation = useCallback(async (receiverId: string) => {
    const now = Date.now();
    const last = lastNegotiation.current.get(receiverId) || 0;
    if (now - last < 3000) {
      console.log(`[Sender] Debouncing negotiation for ${receiverId}`);
      return;
    }
    lastNegotiation.current.set(receiverId, now);

    if (!activeStreamRef.current || !signalingRef.current) return;
    
    let pc = pcMapRef.current.get(receiverId);
    if (!pc) {
      pc = new WebRTCPeerConnection(signalingRef.current, receiverId);
      pcMapRef.current.set(receiverId, pc);
    }
    
    // Safety clear tracks if changing source
    const senders = pc.pc.getSenders();
    activeStreamRef.current.getTracks().forEach(track => {
      if (!senders.find(s => s.track === track)) {
        pc!.addTrack(track, activeStreamRef.current!);
      }
    });
    
    await pc.createOffer();
  }, []);

  const generateRoom = async () => {
    try {
      let baseUrl = import.meta.env.VITE_API_URL || "https://webcast-hub.abdulahadbutt420.workers.dev";
      if (!import.meta.env.VITE_API_URL && window.location.hostname === "localhost") baseUrl = "http://localhost:8787";
      baseUrl = baseUrl.replace(/\/$/, "");
      
      const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST" });
      const data = await res.json();
      setRoomId(data.roomId);
      setOwnerToken(data.ownerToken);
      
      // Disconnect old socket if it exists
      if (signalingRef.current) {
        unsubsRef.current.forEach(unsub => unsub());
        unsubsRef.current = [];
        signalingRef.current.disconnect();
      }

      // Connect to signaling immediately so the receiver sees the sender is ready
      const signaling = getGlobalSignaling(data.roomId, "sender", data.ownerToken);
      signalingRef.current = signaling;
      
      unsubsRef.current.push(signaling.on((msg) => {
        if (msg.type === "room-state") {
          setReceiverCount(msg.receiverCount);
        } else if (msg.type === "receiver-joined") {
          setReceiverCount(prev => prev + 1);
          startNegotiation(msg.receiverId!);
        } else if (msg.type === "peer-left" && msg.role === "receiver") {
          setReceiverCount(prev => Math.max(0, prev - 1));
          if (msg.clientId && pcMapRef.current.has(msg.clientId)) {
            pcMapRef.current.get(msg.clientId)?.close();
            pcMapRef.current.delete(msg.clientId);
            lastNegotiation.current.delete(msg.clientId);
          }
        } else if (msg.type === "request-offer") {
          startNegotiation(msg.receiverId!);
        }
      }));

      signaling.onConnect = () => {
        setStatus("Waiting for receiver...");
        setIsConnected(true);
      };
      signaling.onDisconnect = () => {
        setIsConnected(false);
        setStatus("Not Connected");
      };
      signaling.connect();
    } catch (e) {
      console.error(e);
      setRoomId(Math.random().toString(36).substring(2, 6).toUpperCase());
    }
  };




  const handleCastChromeTab = async () => {
    if (!roomId) {
      alert("Please generate or enter a room ID first");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 3840, max: 3840 }, height: { ideal: 2160, max: 2160 }, frameRate: { ideal: 60, max: 60 } },
        audio: true
      });
      
      // Stop old tracks if they exist
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(t => t.stop());
      }
      // Recreate PCs for fresh session
      pcMapRef.current.forEach(pc => pc.close());
      pcMapRef.current.clear();
      lastNegotiation.current.clear();
      
      activeStreamRef.current = stream;
      setStatus("Casting screen...");
      setMediaInfo({ filename: "Screen Capture", resolution: "4K" }); 
      setIsConnected(true);
      
      if (signalingRef.current) {
        unsubsRef.current.forEach(unsub => unsub());
        unsubsRef.current = [];
        signalingRef.current.disconnect();
      }
      signalingRef.current = getGlobalSignaling(roomId, "sender", ownerToken);
      signalingRef.current.connect();
      
      // Negotiate with existing receivers
      signalingRef.current.send({ type: "ping" } as any); // To get room-state or wake up receivers? Actually let them request-offer
      
      stream.getVideoTracks()[0].onended = () => {
        stopCasting();
      };
      
    } catch (err) {
      console.error("Screen capture failed", err);
      if (!activeStreamRef.current) {
        setStatus("Screen capture cancelled or failed.");
      }
    }
  };

  const handleCastLocalMedia = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!roomId) {
      alert("Please generate or enter a room ID first");
      return;
    }

    if (file.type.startsWith("video/") || file.type.startsWith("image/")) {
      setStatus(`Loading ${file.name}...`);
      
      if (!videoRef.current) return;
      const url = URL.createObjectURL(file);
      videoRef.current.src = url;
      
      await new Promise(resolve => {
        if (!videoRef.current) return resolve(null);
        videoRef.current.onloadedmetadata = resolve;
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

      // Feature detect captureStream
      const captureStream = (videoRef.current as any).captureStream || (videoRef.current as any).mozCaptureStream;
      if (!captureStream) {
        alert("Your browser does not support capturing video streams (captureStream API).");
        URL.revokeObjectURL(url);
        return;
      }

      const stream: MediaStream = captureStream.call(videoRef.current);
      if (stream.getVideoTracks().length === 0) {
        await new Promise(resolve => {
          stream.onaddtrack = () => resolve(null);
        });
      }

      // Stop old tracks if they exist
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(t => t.stop());
      }
      // Recreate PCs for fresh session
      pcMapRef.current.forEach(pc => pc.close());
      pcMapRef.current.clear();
      lastNegotiation.current.clear();

      activeStreamRef.current = stream;
      setStatus(`Casting Local Media`);
      setIsConnected(true);

      if (signalingRef.current) {
        unsubsRef.current.forEach(unsub => unsub());
        unsubsRef.current = [];
        signalingRef.current.disconnect();
      }
      signalingRef.current = getGlobalSignaling(roomId, "sender", ownerToken);
      signalingRef.current.connect();
      
    } else {
      alert("Only video/image casting is implemented for now");
    }
  };

  const stopCasting = () => {
    signalingRef.current?.send({ type: "cast-stopped" } as any);
    
    pcMapRef.current.forEach(pc => pc.close());
    pcMapRef.current.clear();
    lastNegotiation.current.clear();
    
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach(track => track.stop());
      activeStreamRef.current = null;
    }
    
    if (videoRef.current) {
      videoRef.current.pause();
      if (videoRef.current.src) URL.revokeObjectURL(videoRef.current.src);
      videoRef.current.src = "";
    }
    
    setIsConnected(false);
    setStatus("Not Connected");
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
      {/* Must be played inline to capture stream properly */}
      <video ref={videoRef} className="hidden" controls muted playsInline />

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
                  <p className="font-semibold text-lg">{isConnected && receiverCount === 0 ? "Waiting for receiver..." : status}</p>
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

          {isConnected && (
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
