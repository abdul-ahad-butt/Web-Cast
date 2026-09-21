import { SignalingClient } from "./SignalingClient";
import type { SignalingMessage } from "./SignalingClient";

export class WebRTCPeerConnection {
  public pc: RTCPeerConnection;
  private signaling: SignalingClient;
  public targetId?: string;
  public sessionId?: string;
  private unsubscribe?: () => void;
  
  public onTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
  public onDataChannel?: (channel: RTCDataChannel) => void;
  public onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(signaling: SignalingClient, targetId?: string, sessionId?: string) {
    this.signaling = signaling;
    this.targetId = targetId;
    this.sessionId = sessionId; // Receiver might receive it via offer, Sender generates it
    
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
      ],
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.sessionId) {
        this.signaling.send({ 
          type: "ice-candidate", 
          candidate: event.candidate, 
          targetId: this.targetId,
          sessionId: this.sessionId
        } as any);
      }
    };

    this.pc.ontrack = (event) => {
      this.onTrack?.(event.track, event.streams);
    };

    this.pc.ondatachannel = (event) => {
      this.onDataChannel?.(event.channel);
    };

    this.pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] connection state = ${this.pc.connectionState} for ${this.targetId?.slice(0, 8) || 'unknown'}`);
      this.onConnectionStateChange?.(this.pc.connectionState);
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ice state = ${this.pc.iceConnectionState} for ${this.targetId?.slice(0, 8) || 'unknown'}`);
      if (this.pc.iceConnectionState === "disconnected" || this.pc.iceConnectionState === "failed") {
        this.onConnectionStateChange?.("disconnected");
      }
    };

    this.unsubscribe = this.signaling.on(async (msg: SignalingMessage) => {
      try {
        if (msg.targetId && msg.targetId !== this.signaling.clientId) {
          return;
        }
        
        // We only process targeted messages or specific negotiation messages from our target
        if (this.targetId && msg.clientId && msg.clientId !== this.targetId) {
          return;
        }

        switch (msg.type) {
          case "offer":
            if (!this.targetId && msg.clientId) this.targetId = msg.clientId;
            if (msg.sessionId) this.sessionId = msg.sessionId;
            await this.handleOffer(msg.offer);
            break;
          case "answer":
            if (!this.targetId && msg.clientId) this.targetId = msg.clientId;
            if (msg.sessionId !== this.sessionId) {
              console.debug(`[WebRTC] Dropping answer with mismatched sessionId (expected ${this.sessionId}, got ${msg.sessionId})`);
              return;
            }
            if (this.pc.signalingState !== "have-local-offer") {
              console.debug(`[WebRTC] Dropping answer because signalingState is ${this.pc.signalingState}`);
              return;
            }
            await this.handleAnswer(msg.answer);
            break;
          case "ice-candidate":
            if (!this.targetId && msg.clientId) this.targetId = msg.clientId;
            if (msg.sessionId !== this.sessionId) {
              console.debug(`[WebRTC] Dropping ice-candidate with mismatched sessionId`);
              return;
            }
            await this.handleIceCandidate(msg.candidate);
            break;
        }
      } catch (err) {
        console.error(`[WebRTC] Error handling signaling message for ${this.targetId?.slice(0, 8)}`, err);
      }
    });
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream) {
    // Check if track is already added to prevent InvalidAccessError
    if (this.pc.getSenders().some(s => s.track === track)) {
      console.debug("[WebRTC] Track already added to peer connection, skipping");
      return;
    }

    const sender = this.pc.addTrack(track, stream);
    
    if (track.kind === 'video') {
      const isScreen = track.label.toLowerCase().includes('screen') || 
                       track.label.toLowerCase().includes('monitor') ||
                       track.label.toLowerCase().includes('window');
      
      try {
        if ('contentHint' in track) {
          (track as any).contentHint = isScreen ? 'detail' : 'motion';
        }
      } catch (e) {}

      const parameters = sender.getParameters();
      if (!parameters.encodings) {
        parameters.encodings = [{}];
      }
      
      const settings = track.getSettings();
      const capturedHeight = settings.height || 1080;
      
      const is4K = capturedHeight >= 2160;
      const maxBitrate = isScreen ? 5_000_000 : (is4K ? 15_000_000 : 5_000_000);
      parameters.encodings[0].maxBitrate = maxBitrate;
      
      // Only scale down if it exceeds 4K
      parameters.encodings[0].scaleResolutionDownBy = Math.max(1, capturedHeight / 2160);
      parameters.encodings[0].maxFramerate = is4K ? 30 : 60;
      
      sender.setParameters(parameters).catch(e => {
        console.warn("[WebRTC] Failed to set max bitrate/framerate", e);
      });
    }
  }

  controlChannel?: RTCDataChannel;

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    const dc = this.pc.createDataChannel(label, options);
    if (label === 'control') {
      this.controlChannel = dc;
    }
    return dc;
  }

  tuneOpus(sdp: string) {
    if (!sdp.includes("stereo=1")) {
      sdp = sdp.replace(
        /(a=fmtp:\d+ .*useinbandfec=1)/g,
        "$1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000"
      );
    }
    return sdp;
  }

  async createOffer() {
    try {
      this.sessionId = crypto.randomUUID();
      console.log(`[WebRTC] negotiation start receiver=${this.targetId?.slice(0, 8) || 'unknown'} session=${this.sessionId?.slice(0, 8)}`);
      let offer = await this.pc.createOffer();
      offer.sdp = this.tuneOpus(offer.sdp || "");
      console.log(`[WebRTC] offer created`);
      await this.pc.setLocalDescription(offer);
      
      const sent = this.signaling.send({ 
        type: "offer", 
        offer: offer, 
        targetId: this.targetId,
        sessionId: this.sessionId
      } as any);
      console.log(`[WebRTC] offer ${sent ? 'sent' : 'queued'}`);
    } catch (e) {
      console.error(`[WebRTC] negotiation failed reason=`, e);
    }
  }

  async resendOffer() {
    if (this.pc.localDescription && this.sessionId) {
      this.signaling.send({ 
        type: "offer", 
        offer: this.pc.localDescription, 
        targetId: this.targetId,
        sessionId: this.sessionId
      } as any);
      console.log(`[WebRTC] offer resent to ${this.targetId?.slice(0, 8)}`);
    } else {
      await this.createOffer();
    }
  }

  private async handleOffer(offer: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.send({ 
      type: "answer", 
      answer: answer, 
      targetId: this.targetId,
      sessionId: this.sessionId
    } as any);
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit) {
    console.log(`[WebRTC] answer received from ${this.targetId?.slice(0, 8) || 'unknown'}`);
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    await this.flushCandidates();
  }

  private async handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (this.pc.remoteDescription) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      this.pendingCandidates.push(candidate);
    }
  }

  private async flushCandidates() {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error("[WebRTC] Error adding queued ICE candidate", e);
        }
      }
    }
  }

  close() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    
    this.pc.close();
  }
}
