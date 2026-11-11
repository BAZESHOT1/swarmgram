-- ============================================================
--  Стабильная идентичность модулей:
--  hardware_id = esp32-<MAC> из eFuse (не меняется при перепрошивке),
--  роль, транспорт, состояние привязки к клиенту и блокировка.
-- ============================================================
ALTER TABLE modules ADD COLUMN IF NOT EXISTS hardware_id text NOT NULL DEFAULT '';   -- esp32-<mac>, стабилен при перепрошивке
ALTER TABLE modules ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'gateway';     -- gateway|repeater|wearable
ALTER TABLE modules ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'wifi';   -- wifi|lora|ble|usb
ALTER TABLE modules ADD COLUMN IF NOT EXISTS attached boolean NOT NULL DEFAULT false;  -- wearable реально подключён к клиенту
ALTER TABLE modules ADD COLUMN IF NOT EXISTS attached_at timestamptz;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS rssi int NOT NULL DEFAULT 0;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS uptime bigint NOT NULL DEFAULT 0;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS block_reason text NOT NULL DEFAULT '';
ALTER TABLE modules ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Старые записи: board_uuid уже равен esp32-<mac>, переносим его в hardware_id.
UPDATE modules SET hardware_id = lower(board_uuid) WHERE hardware_id = '';

-- Один hardware_id не может принадлежать двум строкам. Частичный индекс:
-- пустые значения (например, до первого check-in) не конфликтуют.
CREATE UNIQUE INDEX IF NOT EXISTS modules_hardware_key ON modules (lower(hardware_id)) WHERE hardware_id <> '';
