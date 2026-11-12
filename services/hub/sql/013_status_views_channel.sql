-- ============================================================================
--  Kinto Hub — миграция 013: статус пользователя, просмотры сообщений,
--  публикация от имени канала.
--
--  ВАЖНО про статус: у users уже есть колонка status — это статус АККАУНТА
--  (active / disabled), по ней auth проверяет доступ. Поэтому пользовательский
--  «статус» (короткая строка в профиле) храним в отдельной колонке
--  profile_status, а в API отдаём под именем status.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_status text NOT NULL DEFAULT '';

-- Пост опубликован от имени канала (sender_user_id при этом остаётся автором).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS as_channel boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS message_views (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_views_message_idx ON message_views (message_id);
