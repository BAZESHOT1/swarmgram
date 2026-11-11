-- Архив чатов: участник может скрыть чат в отдельную вкладку «Архив».
-- Флаг хранится на строке участия (у каждого пользователя свой).
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS chat_members_archived_idx ON chat_members (user_id, archived);
