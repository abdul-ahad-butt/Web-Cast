import { SignalingClient } from "./SignalingClient";

export class WebRTCPeerConnection {
  private pc: RTCPeerConnection;
  private signaling: SignalingClient;
  private targetId?: string;
  
  public onTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
  public onDataChannel?: (channel: RTCDataChannel) => void;
  public onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(signaling: SignalingClient, targetId?: string) {
    this.signaling = signaling;
    this.targetId = targetId;
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
      ],
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({ type: "ice-candidate", candidate: event.candidate, targetId: this.targetId } as any);
      }
    };

    this.pc.ontrack = (event) => {
      this.onTrack?.(event.track, event.streams);
    };

    this.pc.ondatachannel = (event) => {
      this.onDataChannel?.(event.channel);
    };

    this.pc.onconnectionstatechange = () => {
      this.onConnectionStateChange?.(this.pc.connectionState);
    };

    this.pc.oniceconnectionstatechange = () => {
      // Sometimes ICE connection state detects drops faster than connection state
      if (this.pc.iceConnectionState === "disconnected" || this.pc.iceConnectionState === "failed") {
        this.onConnectionStateChange?.("disconnected");
      }
    };

    // Handle incoming signaling messages
    const existingOnMessage = this.signaling.onMessage;
    this.signaling.onMessage = async (msg) => {
      existingOnMessage?.(msg);
      
      try {
        if (msg.targetId && msg.targetId !== this.signaling.clientId) {
          // Ignore messages not meant for this peer
          return;
        }

        switch (msg.type) {
          case "offer":
            if (!this.targetId && msg.clientId) {
              this.targetId = msg.clientId;
            }
            await this.handleOffer(msg.offer);
            break;
          case "answer":
            if (!this.targetId && msg.clientId) {
              this.targetId = msg.clientId;
            }
            await this.handleAnswer(msg.answer);
            break;
          case "ice-candidate":
            if (!this.targetId && msg.clientId) {
              this.targetId = msg.clientId;
            }
            await this.handleIceCandidate(msg.candidate);
            break;
        }
      } catch (err) {
        console.error("[WebRTC] Error handling signaling message", err);
      }
    };
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream) {
    const sender = this.pc.addTrack(track, stream);
    
    // Force high bitrate for 4K streaming preservation
    if (track.kind === 'video') {
      const parameters = sender.getParameters();
      if (!parameters.encodings) {
        parameters.encodings = [{}];
      }
      // Allow up to 50 Mbps for pristine 4K quality
      parameters.encodings[0].maxBitrate = 50 * 1000 * 1000;
      
      sender.setParameters(parameters).catch(e => {
        console.warn("[WebRTC] Failed to set max bitrate", e);
      });
    }
  }

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    return this.pc.createDataChannel(label, options);
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send({ type: "offer", offer: this.pc.localDescription, targetId: this.targetId } as any);
  }

  private async handleOffer(offer: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    
    // Add any pending candidates
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate) await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.send({ type: "answer", answer: this.pc.localDescription, targetId: this.targetId } as any);
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  private async handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (this.pc.remoteDescription) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      this.pendingCandidates.push(candidate);
    }
  }

  close() {
    this.pc.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
      }
    });
    this.pc.close();
  }
}
