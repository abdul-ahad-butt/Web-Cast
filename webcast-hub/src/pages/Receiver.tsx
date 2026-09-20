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
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center relative overflow-hidden">
      {roomId ? (
        <>
          <video 
            ref={videoRef}
            autoPlay 
            className={`w-full h-full absolute inset-0 object-contain ${hasMedia ? 'opacity-100' : 'opacity-0'} transition-opacity duration-500`}
          />
          
          {!hasMedia && (
            <div className="z-10 text-center animate-pulse">
              <div className="w-16 h-16 border-4 border-t-blue-500 border-r-transparent border-b-transparent border-l-transparent rounded-full animate-spin mx-auto mb-6"></div>
              <h1 className="text-2xl font-bold tracking-widest uppercase text-gray-400">{status}</h1>
              <p className="text-gray-600 mt-2">Room: {roomId}</p>
              <p className="text-gray-600 text-sm mt-1">Sender: {senderConnected ? "Connected" : "Not connected"}</p>
            </div>
          )}
        </>
      ) : (
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-2">WEBCAST HUB</h1>
          <p className="text-xl text-gray-400 mb-8">Ready to receive</p>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 max-w-md w-full">
            <p className="text-sm text-gray-500 uppercase tracking-wider mb-2">Your Room Code</p>
            <div className="text-5xl font-mono tracking-widest text-blue-400 font-bold mb-4">
              {/* We can auto-generate and redirect to a room code, or prompt */}
              ABCD
            </div>
            <p className="text-gray-500 text-sm">Create a session on the sender to join.</p>
          </div>
        </div>
      )}
    </div>
  );
}
