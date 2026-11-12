-- 032_offline_sync.sql
-- Аудит пакетов, досланных клиентом после офлайн-передачи по mesh.
-- Сами сообщения здесь не хранятся: только результат проверки Ed25519-подписи.

CREATE TABLE IF NOT EXISTS offline_sync_batches (
  id               bigserial PRIMARY KEY,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  client_id        text NOT NULL DEFAULT '',
  chat_id          uuid,
  ephemeral_pubkey text NOT NULL DEFAULT '',
  signature        text NOT NULL DEFAULT '',
  accepted         boolean NOT NULL DEFAULT false,
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS offline_sync_batches_user_time_idx
  ON offline_sync_batches (user_id, created_at DESC);
