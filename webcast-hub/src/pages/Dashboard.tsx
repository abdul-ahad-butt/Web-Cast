import { MonitorUp, Tv, MonitorSmartphone, Settings } from "lucide-react";
import { useState, useRef } from "react";
import { SignalingClient } from "../webrtc/SignalingClient";
import { WebRTCPeerConnection } from "../webrtc/WebRTCPeerConnection";

export default function Dashboard() {
  const [roomId, setRoomId] = useState<string>("");
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("Not Connected");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const pcRef = useRef<WebRTCPeerConnection | null>(null);

  const generateRoom = async () => {
    try {
      let baseUrl = import.meta.env.VITE_WS_URL || "wss://webcast-hub-api.abdulahadbutt420.workers.dev";
      if (!import.meta.env.VITE_WS_URL && window.location.hostname === "localhost") baseUrl = "ws://localhost:8787";
      baseUrl = baseUrl.replace("wss://", "https://").replace("ws://", "http://").replace(/\/$/, "");
      
      const res = await fetch(`${baseUrl}/api/rooms`, { method: "POST" });
      const data = await res.json();
      setRoomId(data.roomId);
    } catch (e) {
      console.error(e);
      setRoomId(Math.random().toString(36).substring(2, 6).toUpperCase());
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
      setStatus(`Uploading ${file.name}...`);
      try {
        let baseUrl = import.meta.env.VITE_WS_URL || "wss://webcast-hub-api.abdulahadbutt420.workers.dev";
        if (!import.meta.env.VITE_WS_URL && window.location.hostname === "localhost") baseUrl = "ws://localhost:8787";
        baseUrl = baseUrl.replace("wss://", "https://").replace("ws://", "http://").replace(/\/$/, "");
        
        const res = await fetch(`${baseUrl}/api/rooms/${roomId}/upload`, {
          method: "POST",
          body: file,
          headers: {
            "Content-Type": file.type
          }
        });
        const data = await res.json();
        
        if (!signalingRef.current) {
          const signaling = new SignalingClient(roomId, "sender");
          signalingRef.current = signaling;
          signaling.onConnect = () => {
            setStatus(`Casting local media: ${file.name}`);
            setIsConnected(true);
            signaling.send({ type: "media-url", url: data.mediaUrl });
          };
          signaling.connect();
        } else {
          signalingRef.current.send({ type: "media-url", url: data.mediaUrl });
          setStatus(`Casting local media: ${file.name}`);
        }
      } catch (err) {
        console.error("Upload failed", err);
        setStatus("Upload failed.");
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
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col p-8">
      <header className="mb-8 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">WEBCAST HUB</h1>
          <p className="text-muted-foreground mt-1">Cast anything to your screen.</p>
        </div>
        <button className="p-2 hover:bg-secondary rounded-full transition-colors">
          <Settings className="w-6 h-6" />
        </button>
      </header>

      <div className="mb-6 flex gap-4 items-center">
        <input 
          type="text" 
          placeholder="Enter Room Code (e.g. ABCD)" 
          value={roomId}
          onChange={(e) => setRoomId(e.target.value.toUpperCase())}
          className="bg-input text-foreground border border-border rounded-lg px-4 py-2 uppercase font-mono tracking-widest"
        />
        <button 
          onClick={generateRoom}
          className="bg-secondary px-4 py-2 rounded-lg hover:bg-secondary/80 transition-colors"
        >
          Generate New
        </button>
      </div>

      <input type="file" ref={fileInputRef} className="hidden" accept="video/*,image/*" onChange={handleFileChange} />
      <video ref={videoRef} className="hidden" controls muted />

      <main className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="border border-border bg-card text-card-foreground p-6 rounded-xl flex flex-col items-start hover:border-primary transition-colors cursor-pointer group">
          <div className="w-12 h-12 bg-secondary rounded-lg flex items-center justify-center mb-4 group-hover:scale-105 transition-transform">
            <MonitorUp className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Cast Chrome Tab</h2>
          <p className="text-muted-foreground">Use the Chrome Extension to cast your tab.</p>
        </div>

        <div onClick={handleCastLocalMedia} className="border border-border bg-card text-card-foreground p-6 rounded-xl flex flex-col items-start hover:border-primary transition-colors cursor-pointer group">
          <div className="w-12 h-12 bg-secondary rounded-lg flex items-center justify-center mb-4 group-hover:scale-105 transition-transform">
            <Tv className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Cast Local Media</h2>
          <p className="text-muted-foreground">Play downloaded videos and images on the big screen.</p>
        </div>

        <div onClick={() => window.open('/receiver', '_blank')} className="border border-border bg-card text-card-foreground p-6 rounded-xl flex flex-col items-start hover:border-primary transition-colors cursor-pointer group">
          <div className="w-12 h-12 bg-secondary rounded-lg flex items-center justify-center mb-4 group-hover:scale-105 transition-transform">
            <MonitorSmartphone className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Connect Receiver</h2>
          <p className="text-muted-foreground">Use this device as a display for incoming casts.</p>
        </div>
      </main>

      <section className="mt-12 border-t border-border pt-8">
        <h3 className="text-lg font-medium mb-4">Active Session</h3>
        <div className="p-4 border border-border rounded-xl bg-secondary/50 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className={`w-3 h-3 rounded-full shadow-[0_0_8px_rgba(239,68,68,0.8)] ${isConnected ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)] animate-pulse' : 'bg-red-500'}`}></div>
              <div>
                <p className="font-medium">{status}</p>
                <p className="text-sm text-muted-foreground">{isConnected ? `Room: ${roomId}` : 'No active casting room'}</p>
              </div>
            </div>
            <button 
              onClick={stopCasting}
              disabled={!isConnected}
              className={`px-4 py-2 rounded-lg font-medium transition-opacity ${isConnected ? 'bg-destructive text-destructive-foreground hover:opacity-90' : 'bg-primary text-primary-foreground opacity-50 cursor-not-allowed'}`}
            >
              Stop Casting
            </button>
          </div>

          {isConnected && (
            <div className="flex gap-4 border-t border-border pt-4 mt-2">
              <button onClick={() => signalingRef.current?.send({ type: "media-play" })} className="bg-primary text-primary-foreground px-4 py-2 rounded-lg">Play</button>
              <button onClick={() => signalingRef.current?.send({ type: "media-pause" })} className="bg-secondary px-4 py-2 rounded-lg hover:bg-secondary/80">Pause</button>
              <button onClick={() => signalingRef.current?.send({ type: "media-seek", time: 0 })} className="bg-secondary px-4 py-2 rounded-lg hover:bg-secondary/80">Restart</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
