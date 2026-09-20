import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { SignalingClient } from "../webrtc/SignalingClient";
import { WebRTCPeerConnection } from "../webrtc/WebRTCPeerConnection";

export default function Receiver() {
  const { roomId } = useParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  
  const [status, setStatus] = useState<string>("Initializing...");
  const [hasMedia, setHasMedia] = useState<boolean>(false);
  const [senderConnected, setSenderConnected] = useState<boolean>(false);

  useEffect(() => {
    if (!roomId) return;

    setStatus("Connecting to signaling server...");
    const signaling = new SignalingClient(roomId, "receiver");
    const peer = new WebRTCPeerConnection(signaling);

    signaling.onConnect = () => {
      setStatus("Waiting for sender...");
    };

    const originalOnMessage = signaling.onMessage;
    signaling.onMessage = (msg) => {
      originalOnMessage?.(msg);
      if (msg.type === "sender-joined") {
        setSenderConnected(true);
        setStatus("Sender joined. Waiting for stream...");
      } else if (msg.type === "sender-disconnected") {
        setSenderConnected(false);
        setHasMedia(false);
        setStatus("Sender disconnected. Waiting...");
      } else if (msg.type === "media-url") {
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.src = msg.url;
          setHasMedia(true);
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
          setStatus("");
        }
      }
    };

    peer.onConnectionStateChange = (state) => {
      console.log("WebRTC state:", state);
      if (state === "disconnected" || state === "failed") {
        setHasMedia(false);
        setStatus("Stream disconnected");
      }
    };

    signaling.connect();

    return () => {
      signaling.disconnect();
      peer.close();
    };
  }, [roomId]);

  return (
    <div className="min-h-screen text-foreground flex flex-col items-center justify-center relative overflow-hidden">
      {/* Background Animated Blobs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-[100px] animate-pulse-slow"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-600/20 rounded-full blur-[100px] animate-pulse-slow" style={{ animationDelay: '2s' }}></div>

      {roomId ? (
        <>
          <video 
            ref={videoRef}
            autoPlay 
            className={`w-full h-full absolute inset-0 object-contain z-20 ${hasMedia ? 'opacity-100' : 'opacity-0'} transition-opacity duration-700`}
          />
          
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
          
          <div className="glass-card rounded-3xl p-10 max-w-md w-full relative overflow-hidden group hover:shadow-[0_0_40px_rgba(99,102,241,0.2)] transition-shadow duration-500 border border-white/10">
            <div className="absolute -inset-1 bg-linear-to-r from-blue-500/0 via-indigo-500/10 to-purple-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-1000"></div>
            
            <p className="text-sm text-muted-foreground/60 uppercase tracking-[0.3em] font-semibold mb-6 relative z-10">Your Room Code</p>
            
            <div className="relative inline-block mb-8 z-10">
              <div className="absolute inset-0 bg-blue-500/20 blur-2xl rounded-full"></div>
              <div className="text-6xl md:text-7xl font-mono tracking-[0.2em] text-white font-bold drop-shadow-[0_0_15px_rgba(255,255,255,0.3)]">
                {/* Normally we might display a generated code here, but currently receiver takes it from URL */}
                <span className="opacity-50">...</span>
              </div>
            </div>
            
            <p className="text-muted-foreground/80 font-light text-lg relative z-10">
              Enter a Room Code in the URL to join.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
