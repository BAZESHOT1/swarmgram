-- ============================================================================
--  SwarmGram Hub — миграция 015: аватар группы/канала.
--
--  Файл аватара, как и у профиля пользователя, хранится зашифрованным на узлах:
--  Hub знает только objectId, ключ расшифровки (base64url) и mime.
--
--  Право set_avatar хранится в jsonb-матрице chats.permissions (переопределения
--  ролей admin/moderator). Отдельной таблицы permissions/role_matrix в проекте
--  нет: значения по умолчанию задаются в коде (DEFAULT_PERMISSIONS в
--  routes/chats.ts). Для уже существующих чатов пустой объект permissions
--  означает «взять defaults», поэтому set_avatar = true для admin/moderator
--  включается автоматически. Владелец всегда имеет все права.
-- ============================================================================

ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_object_id uuid REFERENCES objects(id) ON DELETE SET NULL;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_key text NOT NULL DEFAULT '';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_mime text NOT NULL DEFAULT '';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
