import { MonitorUp, Tv, MonitorSmartphone, Settings } from "lucide-react";
import { useState, useRef } from "react";
import { SignalingClient } from "../webrtc/SignalingClient";
import { WebRTCPeerConnection } from "../webrtc/WebRTCPeerConnection";

export default function Dashboard() {
  const [roomId, setRoomId] = useState<string>("");
  const [ownerToken, setOwnerToken] = useState<string>("");
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("Not Connected");
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [mediaInfo, setMediaInfo] = useState<{filename: string, resolution: string} | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const pcRef = useRef<WebRTCPeerConnection | null>(null);

  const generateRoom = async () => {
    try {
      let baseUrl = import.meta.env.VITE_API_URL || "https://webcast-hub.abdulahadbutt420.workers.dev";
      if (!import.meta.env.VITE_API_URL && window.location.hostname === "localhost") baseUrl = "http://localhost:8787";
      baseUrl = baseUrl.replace(/\/$/, "");
      
      const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST" });
      const data = await res.json();
      setRoomId(data.roomId);
      setOwnerToken(data.ownerToken);
      
      // Connect to signaling immediately so the receiver sees the sender is ready
      if (signalingRef.current) {
        signalingRef.current.disconnect();
      }
      const signaling = new SignalingClient(data.roomId, "sender", data.ownerToken);
      signalingRef.current = signaling;
      signaling.onConnect = () => {
        setStatus("Room Ready");
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
        video: true,
        audio: true
      });
      
      setStatus("Starting screen cast...");
      
      if (!signalingRef.current || signalingRef.current.roomId !== roomId) {
        signalingRef.current?.disconnect();
        signalingRef.current = new SignalingClient(roomId, "sender", ownerToken);
      }
      if (!pcRef.current) {
        pcRef.current = new WebRTCPeerConnection(signalingRef.current);
      }
      
      stream.getTracks().forEach((track) => {
        pcRef.current?.addTrack(track, stream);
      });
      
      signalingRef.current.onConnect = async () => {
        setStatus("Casting screen...");
        setIsConnected(true);
        await pcRef.current?.createOffer();
      };
      
      signalingRef.current.connect();
      
      // Handle the user clicking "Stop sharing" in the browser UI
      stream.getVideoTracks()[0].onended = () => {
        stopCasting();
      };
      
    } catch (err) {
      console.error("Screen capture failed", err);
      setStatus("Screen capture cancelled or failed.");
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
      setStatus(`Processing ${file.name}...`);
      
      let resolution = "Original";
      if (file.type.startsWith("video/")) {
        try {
          const url = URL.createObjectURL(file);
          const tempVideo = document.createElement("video");
          tempVideo.src = url;
          await new Promise((resolve) => {
            tempVideo.onloadedmetadata = () => {
              const height = tempVideo.videoHeight;
              if (height >= 2160) resolution = "4K";
              else if (height >= 1440) resolution = "2K";
              else if (height >= 1080) resolution = "1080p";
              else if (height >= 720) resolution = "720p";
              else resolution = `${tempVideo.videoWidth}x${height}`;
              URL.revokeObjectURL(url);
              resolve(null);
            };
            tempVideo.onerror = () => {
              URL.revokeObjectURL(url);
              resolve(null);
            };
          });
        } catch (e) {
          console.error("Failed to detect resolution", e);
        }
      }

      setStatus(`Uploading ${file.name}...`);
      setUploadProgress(1); // Trigger progress UI
      try {
        let baseUrl = import.meta.env.VITE_API_URL || "https://webcast-hub.abdulahadbutt420.workers.dev";
        if (!import.meta.env.VITE_API_URL && window.location.hostname === "localhost") baseUrl = "http://localhost:8787";
        baseUrl = baseUrl.replace(/\/$/, "");
        
        // 1. Start multipart upload
        const startRes = await fetch(`${baseUrl}/api/rooms/${roomId}/upload/start`, {
          method: "POST",
          headers: {
            "Content-Type": file.type,
            "Authorization": `Bearer ${ownerToken}`
          }
        });
        
        if (!startRes.ok) throw new Error("Upload start failed");
        const { uploadId, mediaId } = await startRes.json();

        // 2. Upload chunks
        const chunkSize = 50 * 1024 * 1024; // 50MB
        const numChunks = Math.ceil(file.size / chunkSize);
        const parts: { partNumber: number, etag: string }[] = [];

        for (let i = 0; i < numChunks; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, file.size);
          const chunk = file.slice(start, end);
          const partNumber = i + 1;

          const partRes = await fetch(`${baseUrl}/api/rooms/${roomId}/upload/${uploadId}/${partNumber}?mediaId=${mediaId}`, {
            method: "PUT",
            body: chunk,
            headers: {
              "Authorization": `Bearer ${ownerToken}`
            }
          });
          
          if (!partRes.ok) throw new Error(`Upload part ${partNumber} failed`);
          const partData = await partRes.json();
          parts.push({ partNumber: partData.partNumber, etag: partData.etag });
          
          setUploadProgress(((i + 1) / numChunks) * 100);
        }

        // 3. Complete multipart upload
        const completeRes = await fetch(`${baseUrl}/api/rooms/${roomId}/upload/${uploadId}/complete?mediaId=${mediaId}`, {
          method: "POST",
          body: JSON.stringify({ parts }),
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${ownerToken}`
          }
        });
        
        if (!completeRes.ok) throw new Error("Upload complete failed");
        const { mediaUrl } = await completeRes.json();
        
        setUploadProgress(0); // Hide progress UI
        
        if (!signalingRef.current || signalingRef.current.roomId !== roomId) {
          signalingRef.current?.disconnect();
          const signaling = new SignalingClient(roomId, "sender", ownerToken);
          signalingRef.current = signaling;
          signaling.onConnect = () => {
            setMediaInfo({ filename: file.name, resolution });
            setStatus(`Casting Local Media`);
            setIsConnected(true);
            signaling.send({ type: "media-url", url: mediaUrl, filename: file.name, resolution });
          };
          signaling.connect();
        } else {
          signalingRef.current.send({ type: "media-url", url: mediaUrl, filename: file.name, resolution });
          setMediaInfo({ filename: file.name, resolution });
          setStatus(`Casting Local Media`);
        }
      } catch (err) {
        console.error("Upload failed", err);
        setStatus("Upload failed.");
        setUploadProgress(0);
      }
    } else {
      alert("Only video/image casting is implemented for now");
    }
  };

  const stopCasting = () => {
    signalingRef.current?.disconnect();
    pcRef.current?.close();
    if (videoRef.current) {
      videoRef.current.pause();
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
      <video ref={videoRef} className="hidden" controls muted />

      <main className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
        <div onClick={handleCastChromeTab} className="glass-card p-8 rounded-2xl flex flex-col items-start hover:border-blue-500/50 hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:-translate-y-1 transition-all cursor-pointer group">
          <div className="w-14 h-14 bg-linear-to-br from-blue-500/20 to-purple-500/20 border border-white/5 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all">
            <MonitorUp className="w-7 h-7 text-blue-400 group-hover:text-blue-300" />
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

        <div onClick={() => window.open('/receiver', '_blank')} className="glass-card p-8 rounded-2xl flex flex-col items-start hover:border-emerald-500/50 hover:shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:-translate-y-1 transition-all cursor-pointer group">
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
        
        {uploadProgress > 0 && uploadProgress < 100 && (
          <div className="mb-6 glass-card p-6 rounded-2xl">
            <div className="flex justify-between text-sm mb-3 font-medium">
              <span className="text-blue-400">Uploading Media...</span>
              <span className="text-muted-foreground">{Math.round(uploadProgress)}%</span>
            </div>
            <div className="w-full bg-black/40 rounded-full h-3 border border-white/5 overflow-hidden">
              <div 
                className="bg-linear-to-r from-blue-500 to-indigo-500 h-full rounded-full transition-all duration-300 shadow-[0_0_10px_rgba(59,130,246,0.5)]" 
                style={{ width: `${uploadProgress}%` }}
              ></div>
            </div>
          </div>
        )}

        <div className="glass-card p-6 md:p-8 rounded-2xl flex flex-col gap-6 relative overflow-hidden">
          {isConnected && <div className="absolute -top-24 -right-24 w-48 h-48 bg-blue-500/20 rounded-full blur-[50px] pointer-events-none"></div>}
          
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 relative z-10">
            <div className="flex items-center gap-5">
              <div className="relative">
                <div className={`w-4 h-4 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-red-500'}`}></div>
                {isConnected && <div className="absolute inset-0 bg-emerald-400 rounded-full animate-ping opacity-75"></div>}
              </div>
              <div>
                <p className="font-semibold text-lg">{status}</p>
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
              <button onClick={() => signalingRef.current?.send({ type: "media-play" })} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2.5 rounded-lg shadow-[0_0_15px_rgba(37,99,235,0.3)] hover:-translate-y-0.5 transition-all font-medium">Play</button>
              <button onClick={() => signalingRef.current?.send({ type: "media-pause" })} className="bg-secondary/80 hover:bg-secondary border border-white/5 px-6 py-2.5 rounded-lg hover:-translate-y-0.5 transition-all font-medium">Pause</button>
              <button onClick={() => signalingRef.current?.send({ type: "media-seek", time: 0 })} className="bg-secondary/80 hover:bg-secondary border border-white/5 px-6 py-2.5 rounded-lg hover:-translate-y-0.5 transition-all font-medium">Restart</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
