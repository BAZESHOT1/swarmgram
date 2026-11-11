-- ============================================================
--  019: Глобальная mesh-сеть, публичные ID модулей и очередь
--  конвертов, пересланных шлюзом.
--
--  * public_id — 8-значный стабильный публичный идентификатор
--    модуля (только цифры). Вычисляется в коде из hardware_id
--    по FNV-1a 32 (см. src/meshId.ts), перепрошивка его не меняет.
--  * module_shadows — «тень» модуля у прежнего владельца после
--    перепривязки к другому аккаунту. Новый аккаунт не раскрываем.
--  * mesh_config — singleton с единственной глобальной сетью для
--    ВСЕХ модулей (никаких per-account сетей).
--  * mesh_inbox — конверты, которые шлюз прислал через mesh.
-- ============================================================
ALTER TABLE modules ADD COLUMN IF NOT EXISTS public_id text NOT NULL DEFAULT '';
ALTER TABLE modules ADD COLUMN IF NOT EXISTS last_ip text NOT NULL DEFAULT '';
ALTER TABLE modules ADD COLUMN IF NOT EXISTS last_claim_at timestamptz;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS detached_to_owner uuid;
CREATE UNIQUE INDEX IF NOT EXISTS modules_public_id_key ON modules (public_id) WHERE public_id <> '';

CREATE TABLE IF NOT EXISTS module_shadows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  old_owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  public_id text NOT NULL DEFAULT '',
  hardware_id text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  dismissed boolean NOT NULL DEFAULT false,
  reported boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS module_shadows_owner_idx ON module_shadows (old_owner_id, dismissed);

CREATE TABLE IF NOT EXISTS mesh_config (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ssid text NOT NULL,
  password text NOT NULL,
  channel int NOT NULL DEFAULT 11,
  lora_freq_mhz numeric NOT NULL DEFAULT 869.525,
  lora_sf int NOT NULL DEFAULT 9,
  lora_bw_khz int NOT NULL DEFAULT 125,
  wifi_hops int NOT NULL DEFAULT 14,
  lora_hops int NOT NULL DEFAULT 12,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO mesh_config (id, ssid, password, channel, lora_freq_mhz, lora_sf, lora_bw_khz, wifi_hops, lora_hops)
VALUES (1, 'SG-MESH', 'sgmesh-2026-11-11-a7f3c9d2e6b14580', 11, 869.525, 9, 125, 14, 12)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS mesh_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid REFERENCES modules(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  chat_id uuid,
  packet_id text NOT NULL DEFAULT '',
  envelope jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued', -- queued|processed|failed
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS mesh_inbox_status_idx ON mesh_inbox (status, created_at);
