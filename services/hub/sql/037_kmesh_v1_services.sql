-- ============================================================
-- 037_kmesh_v1_services.sql
--  Поиск, лента, привязка узла к пользователю и мобильные шлюзы.
-- ============================================================

ALTER TABLE kmesh_v1_presence
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS kmesh_v1_presence_user_idx
  ON kmesh_v1_presence (user_id, expires_at);

-- Стабильный 32-битный идентификатор для радиопротокола.
CREATE TABLE IF NOT EXISTS kmesh_v1_entity_map (
  entity_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL,
  entity_uuid uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_uuid)
);
CREATE INDEX IF NOT EXISTS kmesh_v1_entity_map_uuid_idx
  ON kmesh_v1_entity_map (entity_uuid);

-- Привязка mesh-узла к аккаунту (телефон сообщает её через BLE).
CREATE TABLE IF NOT EXISTS kmesh_v1_node_bindings (
  node_id     bigint PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kmesh_v1_node_bindings_user_idx
  ON kmesh_v1_node_bindings (user_id);

-- Быстрый поиск по чатам/каналам без тяжёлых JOIN-ов.
CREATE INDEX IF NOT EXISTS chats_type_title_idx
  ON chats (type, lower(title));
