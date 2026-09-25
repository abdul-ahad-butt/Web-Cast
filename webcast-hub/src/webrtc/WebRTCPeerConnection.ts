import { SignalingClient } from "./SignalingClient";
import type { SignalingMessage } from "./SignalingClient";
import {
  videoMaxBitrate,
  multiReceiverFactor,
  MULTI_RECEIVER_FLOOR_BPS,
  OPUS_MAX_BITRATE,
  SCREEN_CONTENT_HINT,
  STATS_LOG,
} from "./qualityConfig";

// CHANGE 8 – build tag
// Logged in Dashboard.tsx and Receiver.tsx; updated here for reference.
export const BUILD_TAG = "2026-09-24-quality-r2";

// ─── SDP helper (CHANGE 3) ────────────────────────────────────────────────────
/**
 * Tune Opus and video fmtp lines in an SDP string.
 * Applies stereo Opus at high bitrate and sets x-google-*-bitrate hints.
 * Returns the original SDP on any error.
 */
export function tuneSdp(
  sdp: string,
  opts: { videoMaxKbps?: number; opusKbps?: number } = {}
): string {
  try {
    const opusKbps = opts.opusKbps ?? Math.round(OPUS_MAX_BITRATE / 1000);
    const videoKbps = opts.videoMaxKbps;

    let out = sdp;

    // Opus: force stereo + high bitrate + inband FEC, no DTX
    out = out.replace(
      /(a=fmtp:\d+ [^\r\n]*)/g,
      (line) => {
        // Only modify lines that contain useinbandfec or are Opus fmtp
        if (!/useinbandfec|minptime|opus\/48000/i.test(line) && !/ 111 /.test(sdp.slice(0, sdp.indexOf(line)))) {
          // Heuristic: check if this fmtp PT matches an Opus payload type
          const ptMatch = line.match(/a=fmtp:(\d+)/);
          if (!ptMatch) return line;
          const pt = ptMatch[1];
          // Check the rtpmap for this PT
          if (!new RegExp(`a=rtpmap:${pt} opus/`, "i").test(out)) return line;
        }
        if (!/opus\/48000/i.test(out.slice(0, out.indexOf(line))) &&
            !/(useinbandfec|minptime)/i.test(line)) {
          return line; // not Opus fmtp
        }
        // Strip existing stereo/sprop/maxaverage/dtx/fec overrides, then re-apply
        let cleaned = line.replace(/;?(stereo|sprop-stereo|maxaveragebitrate|usedtx|useinbandfec)=[^;]*/gi, "");
        cleaned = cleaned.replace(/\s*$/, "");
        return `${cleaned};stereo=1;sprop-stereo=1;maxaveragebitrate=${opusKbps * 1000};useinbandfec=1;usedtx=0`;
      }
    );

    // Simpler Opus pass: match the common pattern directly
    out = out.replace(
      /(a=fmtp:\d+ .*useinbandfec=\d+[^\r\n]*)/g,
      (line) => {
        let cleaned = line
          .replace(/;?(stereo=[^;]*)/gi, "")
          .replace(/;?(sprop-stereo=[^;]*)/gi, "")
          .replace(/;?(maxaveragebitrate=[^;]*)/gi, "")
          .replace(/;?(usedtx=[^;]*)/gi, "")
          .replace(/;?(useinbandfec=[^;]*)/gi, "");
        cleaned = cleaned.replace(/\s*$/, "");
        return `${cleaned};stereo=1;sprop-stereo=1;maxaveragebitrate=${opusKbps * 1000};useinbandfec=1;usedtx=0`;
      }
    );

    // Video fmtp: append x-google bitrate hints
    if (videoKbps && videoKbps > 0) {
      const minKbps = Math.round(videoKbps * 0.5);
      const startKbps = Math.round(videoKbps * 0.6);
      // Append to existing video fmtp lines (VP8/VP9/H264)
      out = out.replace(
        /(a=fmtp:\d+ [^\r\n]*(?:profile-level-id|packetization-mode|apt=\d|profile-id)[^\r\n]*)/g,
        (line) => {
          // Skip rtx apt lines
          if (/apt=\d/.test(line)) return line;
          let cleaned = line
            .replace(/;?x-google-min-bitrate=[^;]*/gi, "")
            .replace(/;?x-google-start-bitrate=[^;]*/gi, "")
            .replace(/;?x-google-max-bitrate=[^;]*/gi, "");
          cleaned = cleaned.replace(/\s*$/, "");
          return `${cleaned};x-google-min-bitrate=${minKbps};x-google-start-bitrate=${startKbps};x-google-max-bitrate=${videoKbps}`;
        }
      );
    }

    return out;
  } catch (err) {
    console.warn("[WebRTC] tuneSdp error, returning original SDP:", err);
    return sdp;
  }
}

// ─── Codec preference helper (CHANGE 3) ──────────────────────────────────────
function applyCodecPreferences(
  transceiver: RTCRtpTransceiver,
  kind: "video" | "audio",
  height: number
): void {
  try {
    if (!RTCRtpSender.getCapabilities) {
      console.log("[WebRTC] RTCRtpSender.getCapabilities not supported, skipping setCodecPreferences");
      return;
    }
    const caps = RTCRtpSender.getCapabilities(kind);
    if (!caps) {
      console.log("[WebRTC] getCapabilities returned null for", kind, "- skipping setCodecPreferences");
      return;
    }
    const codecs = caps.codecs;

    if (kind === "video") {
      // Preferred order: <=720 → VP9, H264, VP8; >720 → H264, VP9, VP8
      // RTX/RED/ULPFEC go after the primary codecs
      const primary = height <= 720
        ? ["video/VP9", "video/H264", "video/VP8"]
        : ["video/H264", "video/VP9", "video/VP8"];
      const ordered: any[] = [];
      for (const mime of primary) {
        for (const c of codecs) {
          if (c.mimeType.toLowerCase() === mime.toLowerCase()) ordered.push(c);
        }
      }
      // Append rtx/red/ulpfec
      for (const c of codecs) {
        if (!ordered.includes(c)) ordered.push(c);
      }
      if (ordered.length > 0) {
        transceiver.setCodecPreferences(ordered);
      }
    }
  } catch (err) {
    console.warn("[WebRTC] setCodecPreferences failed:", err);
  }
}

// ─── Encoding quality setter (CHANGE 3) ──────────────────────────────────────
/**
 * Apply maxBitrate, scaleResolutionDownBy, priority, and optionally maxFramerate
 * to every RTCRtpSender on `pc`. Called after addTrack and after renegotiation.
 */
export async function applyEncodingParams(
  pc: RTCPeerConnection,
  mode: "local-media" | "screen",
  receiverCount: number
): Promise<void> {
  const factor = multiReceiverFactor(receiverCount);

  for (const sender of pc.getSenders()) {
    const track = sender.track;
    if (!track) continue;

    try {
      if (track.kind === "video") {
        // Content hint
        if ("contentHint" in track) {
          try {
            (track as any).contentHint = mode === "local-media" ? "motion" : SCREEN_CONTENT_HINT;
          } catch {}
        }

        const settings = track.getSettings();
        const height = settings.height || 480;
        const rawMax = videoMaxBitrate(height);
        const scaledMax = Math.max(MULTI_RECEIVER_FLOOR_BPS, Math.floor(rawMax * factor));

        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        const enc = params.encodings[0];
        enc.maxBitrate = scaledMax;
        enc.scaleResolutionDownBy = 1;
        (enc as any).priority = "high";
        (enc as any).networkPriority = "high";
        if (mode === "local-media") {
          delete enc.maxFramerate; // no framerate cap for file playback
        } else {
          enc.maxFramerate = 60;
        }

        // degradationPreference
        if (mode === "local-media") {
          (params as any).degradationPreference = "maintain-resolution";
        } else {
          (params as any).degradationPreference = "balanced";
        }

        await sender.setParameters(params);
        console.log(
          `[WebRTC] video encoding set: height=${height} maxBitrate=${scaledMax} factor=${factor} mode=${mode}`
        );
      } else if (track.kind === "audio") {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = OPUS_MAX_BITRATE;
        await sender.setParameters(params);
        console.log(`[WebRTC] audio encoding set: maxBitrate=${OPUS_MAX_BITRATE}`);
      }
    } catch (err) {
      console.warn(`[WebRTC] setParameters failed for ${track.kind} track:`, err);
    }
  }
}

// ─── Stats logger (CHANGE 7) ─────────────────────────────────────────────────
export function startSenderStatsLoop(
  pc: RTCPeerConnection,
  receiverId: string,
  onStop: () => boolean // return true to stop
): ReturnType<typeof setInterval> | null {
  if (!STATS_LOG) return null;
  
  let lastBytesSent = 0;
  let lastTimestamp = 0;

  let waitTick = 0;
  const interval = setInterval(async () => {
    if (onStop() || pc.connectionState === "closed") {
      clearInterval(interval);
      return;
    }
    if (pc.connectionState !== "connected") {
      if (waitTick % 5 === 0) console.log(`[Stats] waiting for ${receiverId.slice(0, 8)} state=${pc.connectionState}`);
      waitTick++;
      return;
    }
    waitTick = 0;

    try {
      const reports = await pc.getStats();
      let codec = "", width = 0, height = 0, fps = 0;
      let bytesSent = 0, bitrate = 0;
      let qualityLimit = "none", lost = 0, rtt = 0, pathType = "unknown";
      let packetsSent = 0, packetsLost = 0;
      let hasVideo = false;

      reports.forEach((r: any) => {
        if (r.type === "outbound-rtp" && r.kind === "video") {
          hasVideo = true;
          bytesSent = r.bytesSent || 0;
          const currentTimestamp = r.timestamp || Date.now();
          if (lastBytesSent > 0 && lastTimestamp > 0 && currentTimestamp > lastTimestamp) {
            bitrate = ((bytesSent - lastBytesSent) * 8) / (currentTimestamp - lastTimestamp);
          }
          lastBytesSent = bytesSent;
          lastTimestamp = currentTimestamp;
          
          fps = r.framesPerSecond || 0;
          qualityLimit = r.qualityLimitationReason || "none";
          packetsSent = r.packetsSent || 0;
          if (r.codecId) {
            const codecReport = (reports as any).get(r.codecId);
            if (codecReport) codec = codecReport.mimeType || "";
          }
          if (r.frameWidth) width = r.frameWidth;
          if (r.frameHeight) height = r.frameHeight;
        }
        if (r.type === "remote-inbound-rtp" && r.kind === "video") {
          packetsLost = r.packetsLost || 0;
          rtt = Math.round((r.roundTripTime || 0) * 1000);
        }
        if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
          const local = (reports as any).get(r.localCandidateId);
          if (local) pathType = local.candidateType || "unknown";
        }
      });

      if (!hasVideo) return;
      if (packetsSent > 0) lost = Math.round((packetsLost / (packetsSent + packetsLost)) * 100);

      console.log(
        `[Stats][Sender] rx=${receiverId.slice(0, 8)} codec=${codec} res=${width}x${height} fps=${Math.round(fps)} bitrate=${Math.round(bitrate)} limit=${qualityLimit} lost=${lost}% rtt=${rtt}ms path=${pathType}`
      );
    } catch {}
  }, 2000);

  return interval;
}

export function startReceiverStatsLoop(
  pc: RTCPeerConnection,
  onStop: () => boolean
): ReturnType<typeof setInterval> | null {
  if (!STATS_LOG) return null;
  
  let lastBytesReceived = 0;
  let lastTimestamp = 0;

  let waitTick = 0;
  const interval = setInterval(async () => {
    if (onStop() || pc.connectionState === "closed") {
      clearInterval(interval);
      return;
    }
    if (pc.connectionState !== "connected") {
      if (waitTick % 5 === 0) console.log(`[Stats] waiting for sender state=${pc.connectionState}`);
      waitTick++;
      return;
    }
    waitTick = 0;

    try {
      const reports = await pc.getStats();
      let width = 0, height = 0, fps = 0, bitrate = 0;
      let jitterBuf = 0, lost = 0, freezes = 0, pathType = "unknown";
      let packetsReceived = 0, packetsLost = 0, bytesReceived = 0;
      let hasVideo = false;

      reports.forEach((r: any) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          hasVideo = true;
          bytesReceived = r.bytesReceived || 0;
          const currentTimestamp = r.timestamp || Date.now();
          if (lastBytesReceived > 0 && lastTimestamp > 0 && currentTimestamp > lastTimestamp) {
            bitrate = ((bytesReceived - lastBytesReceived) * 8) / (currentTimestamp - lastTimestamp);
          }
          lastBytesReceived = bytesReceived;
          lastTimestamp = currentTimestamp;

          fps = r.framesPerSecond || 0;
          jitterBuf = Math.round((r.jitterBufferDelay || 0) * 1000);
          packetsReceived = r.packetsReceived || 0;
          packetsLost = r.packetsLost || 0;
          freezes = r.freezeCount || 0;
          if (r.frameWidth) width = r.frameWidth;
          if (r.frameHeight) height = r.frameHeight;
        }
        if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
          const local = (reports as any).get(r.localCandidateId);
          if (local) pathType = local.candidateType || "unknown";
        }
      });

      if (!hasVideo) return;
      if (packetsReceived + packetsLost > 0) {
        lost = Math.round((packetsLost / (packetsReceived + packetsLost)) * 100);
      }

      console.log(
        `[Stats][Receiver] res=${width}x${height} fps=${Math.round(fps)} bitrate=${Math.round(bitrate)} jitterBuf=${jitterBuf}ms lost=${lost}% freezes=${freezes} path=${pathType}`
      );
    } catch {}
  }, 2000);

  return interval;
}

// ─── Main peer connection class ───────────────────────────────────────────────

// ICE restart state per instance (CHANGE 6)
const ICE_RESTART_BACKOFFS = [1000, 2000, 4000, 8000, 8000];

export type CastMode = "local-media" | "screen";

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
  private lastNegotiationTime = 0;
  private consecutiveFailures = 0;

  // CHANGE 6 – ICE restart
  private iceRestartAttempts = 0;
  private iceRestartTimer?: ReturnType<typeof setTimeout>;
  public onIceRestart?: () => Promise<void>; // set by Dashboard to trigger renegotiation

  // Mode for quality/jitter config
  public mode: CastMode = "screen";
  public receiverCount = 1;

  // Stats loop handle
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  controlChannel?: RTCDataChannel;

  constructor(signaling: SignalingClient, targetId?: string, sessionId?: string, pcConfig?: RTCConfiguration) {
    this.signaling = signaling;
    this.targetId = targetId;
    this.sessionId = sessionId;

    // CHANGE 2 – use provided config (with TURN) or a safe default
    this.pc = new RTCPeerConnection(pcConfig ?? {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 2,
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.sessionId) {
        this.signaling.send({
          type: "ice-candidate",
          candidate: event.candidate,
          targetId: this.targetId,
          sessionId: this.sessionId,
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
      const state = this.pc.connectionState;
      console.log(`[WebRTC] connection state = ${state} for ${this.targetId?.slice(0, 8) || "unknown"}`);
      this.onConnectionStateChange?.(state);

      // CHANGE 2 – log candidate path on connected
      if (state === "connected") {
        this._logCandidatePath();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const ice = this.pc.iceConnectionState;
      console.log(`[WebRTC] ice state = ${ice} for ${this.targetId?.slice(0, 8) || "unknown"}`);

      // CHANGE 6 – ICE restart logic (sender only, when onIceRestart is set)
      if (this.onIceRestart) {
        if (ice === "disconnected") {
          this._scheduleIceRestart(3000);
        } else if (ice === "failed") {
          this._scheduleIceRestart(0);
        } else if (ice === "connected" || ice === "completed") {
          this._cancelIceRestart();
        }
      }

      if (ice === "disconnected" || ice === "failed") {
        this.onConnectionStateChange?.("disconnected");
      }
    };

    this.unsubscribe = this.signaling.on(async (msg: SignalingMessage) => {
      try {
        if (msg.targetId && msg.targetId !== this.signaling.clientId) return;
        if (this.targetId && msg.clientId && msg.clientId !== this.targetId) return;

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

  // ─── Track management ───────────────────────────────────────────────────────

  addTrack(track: MediaStreamTrack, stream: MediaStream) {
    // Check if track is already added
    if (this.pc.getSenders().some((s) => s.track === track)) {
      console.debug("[WebRTC] Track already added to peer connection, skipping");
      return;
    }

    // CHANGE 3 – set codec preferences before adding track (via transceiver)
    if (track.kind === "video") {
      const settings = track.getSettings();
      const height = settings.height || 480;
      const transceiver = this.pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
      applyCodecPreferences(transceiver, "video", height);
    } else {
      this.pc.addTrack(track, stream);
    }
  }

  // ─── Data channel ───────────────────────────────────────────────────────────

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    const dc = this.pc.createDataChannel(label, options);
    if (label === "control") {
      this.controlChannel = dc;
    }
    return dc;
  }

  // ─── SDP helpers ────────────────────────────────────────────────────────────

  /** @deprecated Use tuneSdp() instead. Kept for safety. */
  tuneOpus(sdp: string): string {
    return tuneSdp(sdp);
  }

  private _getVideoKbps(): number {
    for (const sender of this.pc.getSenders()) {
      const track = sender.track;
      if (track?.kind === "video") {
        const h = track.getSettings().height || 480;
        const raw = videoMaxBitrate(h);
        const factor = multiReceiverFactor(this.receiverCount);
        return Math.round(Math.max(MULTI_RECEIVER_FLOOR_BPS, raw * factor) / 1000);
      }
    }
    return 4000;
  }

  // ─── Offer / Answer ─────────────────────────────────────────────────────────

  async createOffer(opts?: RTCOfferOptions) {
    if (this.pc.signalingState === "closed") {
      console.warn(`[WebRTC] createOffer aborted, PC is closed for ${this.targetId}`);
      return;
    }

    const now = Date.now();
    if (this.consecutiveFailures >= 3 && now - this.lastNegotiationTime < 10000) {
      console.warn(`[WebRTC] Circuit breaker active for ${this.targetId}, ignoring negotiation`);
      return;
    }
    if (!opts?.iceRestart && now - this.lastNegotiationTime < 1000) {
      console.warn(`[WebRTC] Rate limiting negotiation for ${this.targetId}`);
      return;
    }
    this.lastNegotiationTime = now;

    try {
      this.sessionId = crypto.randomUUID();
      console.log(
        `[WebRTC] negotiation start receiver=${this.targetId?.slice(0, 8) || "unknown"} session=${this.sessionId?.slice(0, 8)} state=${this.pc.signalingState}`
      );

      // CHANGE 3 – apply codec preferences to all video transceivers
      this.pc.getTransceivers().forEach((t) => {
        if (t.sender.track?.kind === "video") {
          const h = t.sender.track.getSettings().height || 480;
          applyCodecPreferences(t, "video", h);
        }
      });

      let offer = await this.pc.createOffer(opts || {});

      // CHANGE 3 – tune SDP
      const videoKbps = this._getVideoKbps();
      const offerDesc = {
        type: offer.type,
        sdp: tuneSdp(offer.sdp || "", { videoMaxKbps: videoKbps }),
      };

      console.log(`[WebRTC] offer created`);
      await this.pc.setLocalDescription(offerDesc as RTCSessionDescriptionInit);

      setTimeout(() => {
        if (!this.stopped && this.pc.connectionState !== "connected") {
          console.warn(`[WebRTC] receiver ${this.targetId?.slice(0, 8)} still not connected after 15s. states: signaling=${this.pc.signalingState} iceConn=${this.pc.iceConnectionState} conn=${this.pc.connectionState} iceGather=${this.pc.iceGatheringState}`);
        }
      }, 15000);

      // CHANGE 5 – include mode in offer message
      const sent = this.signaling.send({
        type: "offer",
        offer: { type: offerDesc.type, sdp: offerDesc.sdp, mode: this.mode },
        targetId: this.targetId,
        sessionId: this.sessionId,
      } as any);
      console.log(`[WebRTC] offer ${sent ? "sent" : "queued"}`);

      // CHANGE 3 – apply encoding params after offer
      await applyEncodingParams(this.pc, this.mode, this.receiverCount);

      this.consecutiveFailures = 0;
    } catch (e: any) {
      this.consecutiveFailures++;
      console.error(`[WebRTC] negotiation failed reason=${e.message} state=${this.pc.signalingState}`, e);
    }
  }

  async resendOffer() {
    if (this.pc.signalingState === "closed") return;
    if (this.pc.localDescription && this.sessionId) {
      this.signaling.send({
        type: "offer",
        offer: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp, mode: this.mode },
        targetId: this.targetId,
        sessionId: this.sessionId,
      } as any);
      console.log(`[WebRTC] offer resent to ${this.targetId?.slice(0, 8)}`);
    } else {
      await this.createOffer();
    }
  }

  // ─── Internal handlers ──────────────────────────────────────────────────────

  private async handleOffer(offer: RTCSessionDescriptionInit & { mode?: string }) {
    if (!offer.sdp || typeof offer.sdp !== "string" || offer.sdp.trim() === "") {
      console.warn("[WebRTC] Ignored offer with empty or missing SDP");
      return;
    }
    let type = offer.type;
    if (type !== "offer") {
      console.warn(`[WebRTC] Invalid offer type '${type}', forcing 'offer'`);
      type = "offer";
    }

    // CHANGE 5 – read mode from offer
    if (offer.mode === "local-media" || offer.mode === "screen") {
      this.mode = offer.mode;
    }

    // CHANGE 3 – tune incoming SDP before setRemoteDescription
    const videoKbps = this._getVideoKbps();
    const tunedSdp = tuneSdp(offer.sdp, { videoMaxKbps: videoKbps });
    try {
      await this.pc.setRemoteDescription({ type, sdp: tunedSdp } as RTCSessionDescriptionInit);
      await this.flushCandidates();

      const answer = await this.pc.createAnswer();
      const finalAnswer = { type: answer.type || "answer", sdp: tuneSdp(answer.sdp || "") };
      await this.pc.setLocalDescription(finalAnswer as RTCSessionDescriptionInit);

      this.signaling.send({
        type: "answer",
        answer: finalAnswer,
        targetId: this.targetId,
        sessionId: this.sessionId,
      } as any);
    } catch (err) {
      console.error("[WebRTC] handleOffer failed:", err);
      if ((this as any)._requestOfferRetries === undefined) (this as any)._requestOfferRetries = 0;
      if ((this as any)._requestOfferRetries < 3) {
        (this as any)._requestOfferRetries++;
        console.warn(`[WebRTC] Retrying request-offer in 2s (retry ${(this as any)._requestOfferRetries}/3)`);
        setTimeout(() => {
          this.signaling.send({ type: "request-offer", targetId: this.targetId, sessionId: this.sessionId } as any);
        }, 2000);
      }
    }
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit) {
    console.log(`[WebRTC] answer received from ${this.targetId?.slice(0, 8) || "unknown"}`);
    if (!answer.sdp || typeof answer.sdp !== "string" || answer.sdp.trim() === "") {
      console.warn("[WebRTC] Ignored answer with empty or missing SDP");
      return;
    }
    let type = answer.type;
    if (type !== "answer") {
      console.warn(`[WebRTC] Invalid answer type '${type}', forcing 'answer'`);
      type = "answer";
    }

    // CHANGE 3 – tune incoming answer SDP
    const videoKbps = this._getVideoKbps();
    const tunedSdp = tuneSdp(answer.sdp, { videoMaxKbps: videoKbps });
    await this.pc.setRemoteDescription({ type, sdp: tunedSdp } as RTCSessionDescriptionInit);
    await this.flushCandidates();

    // CHANGE 3 – re-apply encoding after renegotiation
    await applyEncodingParams(this.pc, this.mode, this.receiverCount);
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

  // ─── CHANGE 2 – log path ────────────────────────────────────────────────────
  private async _logCandidatePath() {
    try {
      const reports = await this.pc.getStats();
      reports.forEach((r: any) => {
        if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
          const local = (reports as any).get(r.localCandidateId);
          const pathType = local?.candidateType || "unknown";
          console.log(`[WebRTC] path = ${pathType} for ${this.targetId?.slice(0, 8) || "unknown"}`);
        }
      });
    } catch {}
  }

  // ─── CHANGE 6 – ICE restart ─────────────────────────────────────────────────
  private _scheduleIceRestart(delayMs: number) {
    if (!this.onIceRestart) return;
    this._cancelIceRestart();
    if (this.iceRestartAttempts >= ICE_RESTART_BACKOFFS.length) {
      console.warn(`[WebRTC] Max ICE restart attempts reached for ${this.targetId?.slice(0, 8)}`);
      return;
    }
    const backoff = ICE_RESTART_BACKOFFS[this.iceRestartAttempts];
    const wait = Math.max(delayMs, backoff);
    console.log(`[WebRTC] ice restart #${this.iceRestartAttempts + 1} scheduled in ${wait}ms for ${this.targetId?.slice(0, 8)}`);
    this.iceRestartTimer = setTimeout(async () => {
      if (this.stopped) return;
      this.iceRestartAttempts++;
      console.log(`[WebRTC] ice restart #${this.iceRestartAttempts} for ${this.targetId?.slice(0, 8)}`);
      try {
        await this.onIceRestart!();
      } catch (e) {
        console.warn("[WebRTC] ICE restart callback failed:", e);
      }
    }, wait);
  }

  private _cancelIceRestart() {
    if (this.iceRestartTimer) {
      clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = undefined;
    }
    this.iceRestartAttempts = 0;
  }

  // ─── CHANGE 7 – sender stats ─────────────────────────────────────────────────
  startSenderStats() {
    this.statsInterval = startSenderStatsLoop(this.pc, this.targetId || "unknown", () => this.stopped);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  close() {
    this.stopped = true;
    this._cancelIceRestart();
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.pc.close();
  }
}


