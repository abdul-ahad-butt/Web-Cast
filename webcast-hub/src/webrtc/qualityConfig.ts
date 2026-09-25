// CHANGE 1 - Central quality config
// Single source of truth for all WebRTC quality parameters.

/** Max video bitrate by capture height (bps). */
export function videoMaxBitrate(height: number): number {
  if (height <= 480) return 4_000_000;
  if (height <= 720) return 7_000_000;
  if (height <= 1080) return 12_000_000;
  return 18_000_000;
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

/** Jitter buffer target in ms, keyed by cast mode. */
export const JITTER_TARGET_MS: Record<"local-media" | "screen", number> = {
  "local-media": 2000,
  "screen": 1000,
};

/** Content hint for screen/tab capture. Flip to "detail" if preferred. */
export const SCREEN_CONTENT_HINT = "motion";

/** Enable periodic stats logging (every 2 s). */
export const STATS_LOG = true;
