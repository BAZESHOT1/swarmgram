-- ============================================================
-- 043_kmesh_ota_rollouts.sql
--  OTA по kMesh: варианты сборок (узел/шлюз) и раскатки по кластерам.
-- ============================================================

-- Узел (BLE) и шлюз (Wi-Fi/HTTP) — разные сборки одного чипа.
ALTER TABLE kmesh_ota_releases ADD COLUMN IF NOT EXISTS variant smallint NOT NULL DEFAULT 0;
ALTER TABLE kmesh_ota_releases DROP CONSTRAINT IF EXISTS kmesh_ota_releases_chip_build_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS kmesh_ota_releases_chip_variant_build
  ON kmesh_ota_releases (chip, variant, build_number);

ALTER TABLE kmesh_ota_manifests ADD COLUMN IF NOT EXISTS variant smallint NOT NULL DEFAULT 0;
ALTER TABLE kmesh_ota_manifests DROP CONSTRAINT IF EXISTS kmesh_ota_manifests_chip_base_build_target_build_key;
CREATE UNIQUE INDEX IF NOT EXISTS kmesh_ota_manifests_chip_variant_base_target
  ON kmesh_ota_manifests (chip, variant, base_build, target_build);

-- Раскатка: какие кластеры (шлюзы) обновлять и по каким транспортам раздавать.
CREATE TABLE IF NOT EXISTS kmesh_ota_rollouts (
  id          bigserial PRIMARY KEY,
  gateways    bigint[],              -- NULL — все кластеры
  ifc_mask    smallint NOT NULL DEFAULT 1, -- бит 0 — ESP-NOW, бит 1 — LoRa
  target_build integer NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'done')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  stopped_at  timestamptz
);
CREATE INDEX IF NOT EXISTS kmesh_ota_rollouts_active_idx ON kmesh_ota_rollouts (status, created_at DESC);
