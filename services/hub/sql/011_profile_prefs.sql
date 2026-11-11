-- ============================================================================
--  SwarmGram Hub — миграция 011: расширенный профиль и синхронизация настроек.
--  Аватар хранится децентрализованно: в users только objectId, ключ шифрования
--  и mime. Сам шифротекст лежит на узлах сети.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_object_id uuid REFERENCES objects(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday date;
-- Кто видит «был(а) в сети»: everyone | shared | nobody
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_visibility text NOT NULL DEFAULT 'everyone';
-- Кто видит био/ссылки/локацию/ДР: everyone | chat
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio_visibility text NOT NULL DEFAULT 'everyone';
-- Синхронизируемые настройки интерфейса (тема/акцент/язык/приглушённые чаты)
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_name text NOT NULL DEFAULT 'system';
ALTER TABLE users ADD COLUMN IF NOT EXISTS accent_name text NOT NULL DEFAULT 'orange';
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'ru';
ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_chats jsonb NOT NULL DEFAULT '[]'::jsonb;
