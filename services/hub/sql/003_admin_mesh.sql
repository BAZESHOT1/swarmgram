-- ============================================================================
--  Kinto Hub — миграция 003: админ-роль, идемпотентный sync mesh-конвертов,
--  полная типизация модулей расширения, мягкие блокировки с причиной.
-- ============================================================================

-- Роли пользователей и статус блокировки с причиной
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';       -- user | admin
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_by text;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS blocked_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason text;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS module_type text NOT NULL DEFAULT 'personal'; -- personal | public | latent
ALTER TABLE modules ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS blocked_reason text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS blocked_reason text;
-- queue-колонка для воспроизведения конвертов, синхронизированных через mesh
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id text;
CREATE UNIQUE INDEX IF NOT EXISTS messages_chat_client_uid
  ON messages (chat_id, client_id) WHERE client_id IS NOT NULL;
-- доставка mesh-сообщений без привязки к устройству
CREATE UNIQUE INDEX IF NOT EXISTS message_receipts_user_null_idx
  ON message_receipts (message_id, user_id) WHERE device_id IS NULL;

-- индекс для поиска администратором
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role, status);
CREATE INDEX IF NOT EXISTS chats_blocked_idx ON chats (blocked_reason) WHERE blocked_reason IS NOT NULL;

-- активные блок-листы (IP / железо) с историей
ALTER TABLE blocked_nodes ADD COLUMN IF NOT EXISTS created_by uuid;
