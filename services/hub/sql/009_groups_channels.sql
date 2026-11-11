-- ============================================================================
--  SwarmGram Hub — миграция 009: группы/каналы, приватность, приглашения,
--  роли и права, заявки, блокировки, журнал и комментарии под постами.
-- ============================================================================

-- Видимость чата: public — в поиске и вступление сразу; closed — в поиске,
-- вступление по заявке; private — только по ссылке/прямому приглашению.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
-- Переопределения матрицы прав по ролям (admin/moderator), пусто = defaults.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Кто может приглашать пользователя напрямую: everyone | shared | chat | nobody.
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_privacy text NOT NULL DEFAULT 'everyone';

-- Пригласительные ссылки в чат/канал.
CREATE TABLE IF NOT EXISTS chat_invite_links (
  id uuid PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  token text UNIQUE NOT NULL,
  role text NOT NULL DEFAULT 'member',
  expires_at timestamptz,
  max_uses int,
  uses int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS chat_invite_links_chat_idx ON chat_invite_links (chat_id, created_at DESC);

-- Заявки на вступление (закрытые чаты и вход по ссылке в закрытый чат).
CREATE TABLE IF NOT EXISTS chat_join_requests (
  id bigserial PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  requested_role text NOT NULL DEFAULT 'member',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz
);
-- Одна активная заявка на пользователя в чате.
CREATE UNIQUE INDEX IF NOT EXISTS chat_join_requests_pending_idx
  ON chat_join_requests (chat_id, user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS chat_join_requests_chat_idx ON chat_join_requests (chat_id, created_at DESC);

-- Блокировки в чате (бан): until NULL — навсегда.
CREATE TABLE IF NOT EXISTS chat_bans (
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT '',
  until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);

-- Журнал действий в чате.
CREATE TABLE IF NOT EXISTS chat_audit (
  id bigserial PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target text NOT NULL DEFAULT '',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_audit_chat_idx ON chat_audit (chat_id, created_at DESC);

-- Комментарии под постами каналов (конверт хранится на узлах, как и сообщения).
CREATE TABLE IF NOT EXISTS post_comments (
  id uuid PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_id uuid REFERENCES objects(id) ON DELETE SET NULL,
  header jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS post_comments_post_idx ON post_comments (message_id, created_at);

-- Существующие каналы: приватность выводим из прежнего флага is_public.
UPDATE chats SET visibility = CASE WHEN is_public THEN 'public' ELSE 'private' END
 WHERE type = 'channel' AND visibility = 'public';
