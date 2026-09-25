// Central quality config — r3
// Single source of truth for all WebRTC quality parameters.

/** Max video bitrate by capture height (bps). No artificial ceiling — let source determine quality. */
export function videoMaxBitrate(height: number): number {
  if (height <= 480)  return  4_000_000;
  if (height <= 720)  return  8_000_000;
  if (height <= 1080) return 15_000_000;
  if (height <= 1440) return 25_000_000;
  return 40_000_000; // 2160p / 4K
}

/**
 * Scale factor applied to per-receiver bitrate based on total receiver count.
 */
export function multiReceiverFactor(receiverCount: number): number {
  if (receiverCount <= 1) return 1.0;
  if (receiverCount === 2) return 0.7;
  return 0.5;
}

/** Minimum bitrate floor per receiver (bps). */
export const MULTI_RECEIVER_FLOOR_BPS = 1_500_000;

/** Max Opus audio bitrate (bps). */
export const OPUS_MAX_BITRATE = 192_000;

/** Jitter buffer target in ms for WebRTC tab/screen cast. */
export const JITTER_TARGET_MS_SCREEN = 400;

/** @deprecated use JITTER_TARGET_MS_SCREEN */
export const JITTER_TARGET_MS: Record<"local-media" | "screen", number> = {
  "local-media": 400,
  "screen": 400,
};

/** Content hint for screen/tab capture. */
export const SCREEN_CONTENT_HINT = "motion";

/** Enable periodic stats logging (every 2 s). */
export const STATS_LOG = true;
