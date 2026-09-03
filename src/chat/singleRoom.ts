/**
 * Single shared global chat room.
 *
 * When MM_GLOBAL_CHAT_ROOM_ID is set for the deployed project, every player is routed into
 * that one room instead of being sharded across capped rooms. Set per environment in
 * `.env.mystic-motors-<projectId>` so sandbox can run pinned while production keeps sharding.
 */
export const getPinnedGlobalRoomId = (): string | null => {
  const raw = process.env.MM_GLOBAL_CHAT_ROOM_ID;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Caps are meaningless for the pinned room; report an effectively unbounded value. */
export const PINNED_ROOM_SOFT_CAP = 1_000_000;
export const PINNED_ROOM_HARD_CAP = 1_000_000;
