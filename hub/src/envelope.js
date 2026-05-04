// Hub-side helpers for envelope-encrypted clip routing.
import { OP } from '../../shared/protocol.js';

export function buildPerRecipient(clip, recipientId, sourceDeviceId) {
  const wk = clip.wrapped_keys?.[recipientId];
  if (!wk) return null;
  return {
    op: OP.BROADCAST,
    clip: {
      id: clip.id,
      type: clip.type,
      mime: clip.mime,
      size: clip.size,
      source_device: sourceDeviceId,
      timestamp: clip.timestamp,
      checksum: clip.checksum,
      name: clip.name || null,
      encrypted_payload: clip.encrypted_payload,
      sender_ephemeral_public: clip.sender_ephemeral_public,
      wrap_salt: clip.wrap_salt,
      wrapped_key: wk,
    },
  };
}

export function packageHistoryRow(row, recipientId) {
  let meta = {};
  try { meta = JSON.parse(row.meta_json || '{}'); } catch {}
  if (!meta.wrapped_keys?.[recipientId]) return null;
  return {
    id: row.id, type: row.type, mime: row.mime, size: row.size,
    source_device: row.source_id, timestamp: row.timestamp, checksum: row.checksum,
    encrypted_payload: row.payload_b64,
    sender_ephemeral_public: meta.sender_ephemeral_public,
    wrap_salt: meta.wrap_salt,
    wrapped_key: meta.wrapped_keys[recipientId],
  };
}
