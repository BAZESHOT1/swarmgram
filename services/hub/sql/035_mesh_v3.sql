-- ============================================================
-- 035_kmesh_v1.sql
--  Dual-band mesh v3: gateway presence, shadow archive buffer and
--  permanently signed mesh messages.
--
--  Flow:
--   1. NODE_GATEWAY publishes an archive envelope (temp-key ciphertext).
--   2. User comes online and POSTs a permanently signed record.
--   3. Upsert by msg_uuid replaces the shadow copy, inserts a `messages`
--      row and emits MSG_SYNCED to both participants.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_uuid text;
CREATE UNIQUE INDEX IF NOT EXISTS messages_chat_msg_uuid_uidx
  ON messages (chat_id, msg_uuid) WHERE msg_uuid IS NOT NULL;

-- Last known attachment point of every mesh node.
CREATE TABLE IF NOT EXISTS kmesh_v1_presence (
  node_id       bigint PRIMARY KEY,
  gateway_id    bigint NOT NULL,
  rssi          int NOT NULL DEFAULT 0,
  hops          int NOT NULL DEFAULT 0,
  iface         int NOT NULL DEFAULT 0,
  battery       int NOT NULL DEFAULT 0,
  role          int NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS kmesh_v1_presence_gateway_idx
  ON kmesh_v1_presence (gateway_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS kmesh_v1_presence_expiry_idx
  ON kmesh_v1_presence (expires_at);

-- Shadow copies overheard by gateways. `status` moves pending -> permanent
-- when the owner uploads the re-signed record, or expired after 14 days.
CREATE TABLE IF NOT EXISTS kmesh_v1_archive (
  msg_uuid       text PRIMARY KEY,
  gateway_id     bigint NOT NULL,
  src_id         bigint NOT NULL,
  dst_id         bigint NOT NULL,
  packet_id      bigint NOT NULL DEFAULT 0,
  packet_type    int NOT NULL DEFAULT 1,
  packet_flags   int NOT NULL DEFAULT 0,
  chat_ref       int,
  rpc_op         int,
  rssi           int NOT NULL DEFAULT 0,
  iface          int NOT NULL DEFAULT 0,
  hop_count      int NOT NULL DEFAULT 0,
  packet_b64     text NOT NULL,
  status         text NOT NULL DEFAULT 'pending', -- pending|permanent|expired
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kmesh_v1_archive_status_idx
  ON kmesh_v1_archive (status, created_at);

-- Permanent record. One row per (msg_uuid); duplicate inserts are no-ops.
CREATE TABLE IF NOT EXISTS kmesh_v1_messages (
  msg_uuid            text PRIMARY KEY,
  chat_id             uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_device_id    uuid REFERENCES devices(id) ON DELETE SET NULL,
  sender_node_id      bigint NOT NULL DEFAULT 0,
  receiver_node_id    bigint NOT NULL DEFAULT 0,
  kind                text NOT NULL DEFAULT 'text',
  ciphertext_b64      text NOT NULL,
  nonce               text NOT NULL DEFAULT '',
  header              jsonb NOT NULL DEFAULT '{}'::jsonb,
  permanent_signature text NOT NULL DEFAULT '',
  sig_alg             text NOT NULL DEFAULT 'ecdsa-p256',
  resign_mode         text NOT NULL DEFAULT 'client', -- client|server
  server_seq          bigint,
  media_gateway_id    bigint,
  archived_via        text NOT NULL DEFAULT 'direct', -- direct|gateway_shadow
  created_at          timestamptz NOT NULL DEFAULT now(),
  synced_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kmesh_v1_messages_chat_idx
  ON kmesh_v1_messages (chat_id, synced_at DESC);
CREATE INDEX IF NOT EXISTS kmesh_v1_messages_sender_idx
  ON kmesh_v1_messages (sender_user_id, synced_at DESC);

-- Audit of every sync attempt (accepted and rejected).
CREATE TABLE IF NOT EXISTS kmesh_v1_sync_events (
  id          bigserial PRIMARY KEY,
  msg_uuid    text NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  chat_id     uuid,
  accepted    boolean NOT NULL DEFAULT false,
  reason      text,
  server_seq  bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kmesh_v1_sync_events_user_idx
  ON kmesh_v1_sync_events (user_id, created_at DESC);

-- Gateway liveness (separate from per-node presence).
CREATE TABLE IF NOT EXISTS kmesh_v1_gateways (
  gateway_id   bigint PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  uplink_ok    bigint NOT NULL DEFAULT 0,
  uplink_fail  bigint NOT NULL DEFAULT 0,
  version      text NOT NULL DEFAULT ''
);
