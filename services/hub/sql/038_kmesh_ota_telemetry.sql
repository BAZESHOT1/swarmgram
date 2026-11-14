-- ============================================================
-- 038_kmesh_ota_telemetry.sql
--  Телеметрия версий прошивок и каскадная радио-OTA.
-- ============================================================

-- Полные образы релизов: нужны для генерации дельта-патчей.
CREATE TABLE IF NOT EXISTS kmesh_ota_releases (
  id           bigserial PRIMARY KEY,
  chip         text NOT NULL,
  build_number integer NOT NULL,
  version      text NOT NULL,
  full_sha256  text NOT NULL,
  full_size    integer NOT NULL,
  image        bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chip, build_number)
);
CREATE INDEX IF NOT EXISTS kmesh_ota_releases_chip_idx
  ON kmesh_ota_releases (chip, build_number DESC);

-- Манифесты и готовые патчи base -> target для каждого чипа.
CREATE TABLE IF NOT EXISTS kmesh_ota_manifests (
  patch_id      serial PRIMARY KEY,
  chip          text NOT NULL,
  base_build    integer NOT NULL,
  target_build  integer NOT NULL,
  version       text NOT NULL,
  total_chunks  integer NOT NULL,
  patch_size    integer NOT NULL,
  patch_sha256  text NOT NULL,
  target_sha256 text NOT NULL,
  sig_alg       text NOT NULL DEFAULT 'ecdsa-p256',
  signature     text NOT NULL DEFAULT '',
  patch         bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chip, base_build, target_build)
);
CREATE INDEX IF NOT EXISTS kmesh_ota_manifests_lookup_idx
  ON kmesh_ota_manifests (chip, base_build, target_build DESC);

-- Сквозная телеметрия всех узлов без отдельных пакетов в эфире.
CREATE TABLE IF NOT EXISTS kmesh_nodes_telemetry (
  node_id         bigint PRIMARY KEY,
  chip_arch       smallint NOT NULL DEFAULT 0,
  node_role       smallint NOT NULL DEFAULT 0,
  radio_caps      smallint NOT NULL DEFAULT 0,
  fw_build        integer NOT NULL DEFAULT 0,
  fw_version_str  text NOT NULL DEFAULT '',
  ota_state       smallint NOT NULL DEFAULT 0,
  battery_pct     smallint NOT NULL DEFAULT 0,
  last_gateway_id bigint NOT NULL DEFAULT 0,
  hops_to_gw      smallint NOT NULL DEFAULT 0,
  last_rssi       smallint NOT NULL DEFAULT 0,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kmesh_nodes_telemetry_seen_idx
  ON kmesh_nodes_telemetry (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS kmesh_nodes_telemetry_build_idx
  ON kmesh_nodes_telemetry (fw_build, last_seen_at DESC);
