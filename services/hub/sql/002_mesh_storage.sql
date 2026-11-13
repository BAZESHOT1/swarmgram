-- ============================================================================
--  Klinto Hub — миграция 002: mesh-модули, каналы, блокировки узлов,
--  Hub больше не хранит содержимое сообщений (только метаданные и маршруты).
-- ============================================================================

-- Содержимое сообщений переезжает на узлы: Hub хранит только object_id и nonce
ALTER TABLE messages DROP COLUMN IF EXISTS ciphertext;
ALTER TABLE messages DROP COLUMN IF EXISTS nonce;

-- Статусы доставки ссылаются на message_id
CREATE UNIQUE INDEX IF NOT EXISTS messages_id_key ON messages (id);

-- Объекты: двухфазная загрузка (прямо на узлы, минуя Hub)
ALTER TABLE objects ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active';
ALTER TABLE objects ADD COLUMN IF NOT EXISTS replicas_acked int NOT NULL DEFAULT 0;

-- Узлы: идентификация по IP и железу, подсеть для разнообразия размещения
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS subnet text NOT NULL DEFAULT '';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_ip text NOT NULL DEFAULT '';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS hw_hash text NOT NULL DEFAULT '';

-- Каналы (новостные): публичный флаг + видимость
ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS chats_public_idx ON chats (is_public, type);

-- Блокировки узлов (по IP / по железу)
CREATE TABLE IF NOT EXISTS blocked_nodes (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ip        text NOT NULL DEFAULT '',
    hw_hash   text NOT NULL DEFAULT '',
    reason    text NOT NULL DEFAULT '',
    active    boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid
);
CREATE INDEX IF NOT EXISTS blocked_nodes_ip_idx ON blocked_nodes (ip, active);
CREATE INDEX IF NOT EXISTS blocked_nodes_hw_idx ON blocked_nodes (hw_hash, active);

-- ESP32-модули связи: привязываются к пользователю по UUID платы
CREATE TABLE IF NOT EXISTS modules (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    board_uuid    text NOT NULL,
    kind          text NOT NULL DEFAULT 'wifi',      -- wifi | lora
    firmware      text NOT NULL DEFAULT '',
    battery       int NOT NULL DEFAULT 0,
    gateway       boolean NOT NULL DEFAULT false,    -- есть ли выход в интернет через модуль/соседей
    neighbors     int NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'offline',   -- offline | online
    last_seen_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS modules_board_key ON modules (lower(board_uuid));
CREATE INDEX IF NOT EXISTS modules_owner_idx ON modules (owner_id);

CREATE TABLE IF NOT EXISTS module_neighbors (
    id           bigserial PRIMARY KEY,
    module_id    uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    neighbor_uuid text NOT NULL,
    rssi         int NOT NULL DEFAULT 0,
    channel      text NOT NULL DEFAULT 'ble',         -- ble | lora
    has_gateway  boolean NOT NULL DEFAULT false,
    seen_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS module_neighbors_module_idx ON module_neighbors (module_id, seen_at DESC);

-- Статусы доставки сообщений
CREATE TABLE IF NOT EXISTS message_receipts (
    message_id   uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id    uuid REFERENCES devices(id) ON DELETE SET NULL,
    delivered_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, device_id)
);
CREATE INDEX IF NOT EXISTS message_receipts_message_idx ON message_receipts (message_id);
