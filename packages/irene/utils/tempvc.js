// Shared temp VC state — imported by voiceStateUpdate.js, executor.js, vcrenamer.js, vcpanel.js

// channelId → ownerId (userId string)
export const tempChannels = new Map();

// "guildId:userId" entries currently creating a join-to-create VC.
// This closes the small race where duplicate voiceStateUpdate events can both
// pass the "already owns a VC" check before the first channel is committed.
export const pendingCreateVcUsers = new Set();

// guildId → highest seq number assigned so far (avoids O(n) scan on every VC creation)
export const guildVcSeqCounters = new Map();

// vcChannelId → textChannelId (for paired text channels)
export const tempTextChannels = new Map();

// vcChannelId → sequential number assigned at creation (stable across renames)
export const tempVcSeq = new Map();

// vcChannelId → { messageId, textChannelId } for control panel
export const tempControlPanels = new Map();

// vcChannelId → { timer, lastRenameAt } for rename rate limiting
export const renameTimers = new Map();

// ─── Feature: VC History Logging ─────────────────────────────────────────────

// channelId → Date (when the VC was created)
export const tempVcCreatedAt = new Map();

// channelId → Set<userId> (all members who were ever in the VC)
export const tempVcMembers = new Map();

// ─── Feature: Rejoin Grace Period ────────────────────────────────────────────

// channelId → { timer, ownerId }
export const ownerGraceTimers = new Map();

// ─── Feature: Manual Rename Lock ─────────────────────────────────────────────
// When the owner manually renames their VC via the panel, the auto-renamer
// should back off for a while to respect their choice.
// channelId → timestamp (Date.now()) of the last manual rename
export const manualRenames = new Map();
