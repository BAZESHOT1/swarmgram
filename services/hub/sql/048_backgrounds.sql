-- Фоны: профиль пользователя, группа/канал, личный чат. Тот же зашифрованный контракт, что у аватаров.
ALTER TABLE users ADD COLUMN IF NOT EXISTS background_object_id uuid REFERENCES objects(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS background_key text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS background_mime text NOT NULL DEFAULT '';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS background_object_id uuid REFERENCES objects(id) ON DELETE SET NULL;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS background_key text NOT NULL DEFAULT '';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS background_mime text NOT NULL DEFAULT '';
-- Канал или группа, закреплённые в профиле (карточка «Канал» в профиле).
ALTER TABLE users ADD COLUMN IF NOT EXISTS featured_chat_id uuid REFERENCES chats(id) ON DELETE SET NULL;
