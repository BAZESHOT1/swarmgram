-- 031_mesh_network_registry.sql
-- DeviceRegistry, HandoverLog и TelemetryAggregator для mesh-сети.
-- Идентичность устройства — заводской MAC (mesh_addr), BLE MAC — только алиас.

ALTER TABLE modules ADD COLUMN IF NOT EXISTS ble_mac text NOT NULL DEFAULT '';
ALTER TABLE modules ADD COLUMN IF NOT EXISTS mesh_addr text NOT NULL DEFAULT '';
UPDATE modules SET mesh_addr = hardware_id WHERE mesh_addr = '' AND hardware_id LIKE 'esp32-%';

CREATE INDEX IF NOT EXISTS modules_ble_mac_idx
  ON modules (lower(ble_mac)) WHERE ble_mac <> '';

CREATE TABLE IF NOT EXISTS handover_events (
  id          bigserial PRIMARY KEY,
  module_id   uuid REFERENCES modules(id) ON DELETE SET NULL,
  mesh_addr   text NOT NULL,
  from_cluster text NOT NULL DEFAULT '',
  to_cluster   text NOT NULL DEFAULT '',
  state        text NOT NULL DEFAULT 'request',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS handover_events_module_idx ON handover_events (module_id, created_at DESC);
CREATE INDEX IF NOT EXISTS handover_events_time_idx ON handover_events (created_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_reports (
  id           bigserial PRIMARY KEY,
  module_id    uuid REFERENCES modules(id) ON DELETE SET NULL,
  mesh_addr    text NOT NULL DEFAULT '',
  cluster_id   text NOT NULL DEFAULT '',
  neighbors    int NOT NULL DEFAULT 0,
  avg_rssi     int NOT NULL DEFAULT 0,
  outbox_depth int NOT NULL DEFAULT 0,
  hues         text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telemetry_reports_cluster_idx ON telemetry_reports (cluster_id, created_at DESC);

-- Единый реестр устройств по mesh_addr (MAC Wi-Fi STA). Отдельное имя,
-- чтобы не конфликтовать с таблицей аккаунт-устройств devices.
CREATE OR REPLACE VIEW mesh_devices AS
SELECT
  m.id,
  COALESCE(NULLIF(m.mesh_addr, ''), m.hardware_id) AS mesh_addr,
  m.ble_mac,
  m.owner_id AS user_id,
  m.public_id,
  m.role,
  m.transport,
  m.kind,
  m.status,
  m.last_seen_at,
  m.cluster_id,
  m.border,
  m.transports,
  m.neighbors,
  m.firmware,
  m.created_at
FROM modules m;
