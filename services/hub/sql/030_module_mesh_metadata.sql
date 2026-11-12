-- 030_module_mesh_metadata.sql
-- Расширенная запись модуля: кластер, признак border-ноды и активные
-- транспорты (wifi/lora/ble). Заполняется из register/checkin прошивки.

ALTER TABLE modules ADD COLUMN IF NOT EXISTS cluster_id text NOT NULL DEFAULT '';
ALTER TABLE modules ADD COLUMN IF NOT EXISTS border boolean NOT NULL DEFAULT false;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS transports text[] NOT NULL DEFAULT '{}';
ALTER TABLE modules ADD COLUMN IF NOT EXISTS last_neighbors jsonb NOT NULL DEFAULT '[]'::jsonb;
