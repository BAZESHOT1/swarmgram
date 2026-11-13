-- ============================================================================
--  Klinto Hub — миграция 007: публичные профили, блокировки и жалобы.
-- ============================================================================

-- Био пользователя (публичный профиль)
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '';

-- Время последней активности (уже есть в 001, оставляем IF NOT EXISTS)
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

-- Кто кого заблокировал
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Жалобы на пользователей
CREATE TABLE IF NOT EXISTS user_reports (
  id bigserial PRIMARY KEY,
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
