-- 033_mesh_device_registry.sql
-- DeviceRegistry: одна строка на физический модуль, ключ — mesh_addr (MAC).
-- Раньше mesh_devices был view; теперь это самостоятельная таблица.

DROP VIEW IF EXISTS mesh_devices;

CREATE TABLE IF NOT EXISTS mesh_devices (
  mesh_addr      text PRIMARY KEY,
  hardware_id    text NOT NULL,
  ble_mac        text NOT NULL DEFAULT '',
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  public_id      text NOT NULL DEFAULT '',
  role           text NOT NULL DEFAULT '',
  transport      text NOT NULL DEFAULT '',
  kind           text NOT NULL DEFAULT '',
  cluster_id     text NOT NULL DEFAULT '',
  border         boolean NOT NULL DEFAULT false,
  transports     text[] NOT NULL DEFAULT '{}',
  neighbors      int NOT NULL DEFAULT 0,
  last_rssi      int NOT NULL DEFAULT 0,
  firmware       text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'offline',
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mesh_devices_user_idx ON mesh_devices (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS mesh_devices_ble_idx ON mesh_devices (lower(ble_mac)) WHERE ble_mac <> '';

INSERT INTO mesh_devices
  (mesh_addr, hardware_id, ble_mac, user_id, public_id, role, transport, kind,
   cluster_id, border, transports, neighbors, last_rssi, firmware, status, last_seen_at)
SELECT
  COALESCE(NULLIF(mesh_addr, ''), hardware_id), hardware_id, ble_mac, owner_id,
  public_id, role, transport, kind, cluster_id, border, transports, neighbors,
  rssi, firmware, status, last_seen_at
FROM modules
WHERE hardware_id LIKE 'esp32-%'
ON CONFLICT (mesh_addr) DO UPDATE SET
  hardware_id = EXCLUDED.hardware_id,
  ble_mac = CASE WHEN EXCLUDED.ble_mac <> '' THEN EXCLUDED.ble_mac ELSE mesh_devices.ble_mac END,
  user_id = COALESCE(EXCLUDED.user_id, mesh_devices.user_id),
  public_id = COALESCE(NULLIF(EXCLUDED.public_id, ''), mesh_devices.public_id),
  role = COALESCE(NULLIF(EXCLUDED.role, ''), mesh_devices.role),
  transport = COALESCE(NULLIF(EXCLUDED.transport, ''), mesh_devices.transport),
  kind = COALESCE(NULLIF(EXCLUDED.kind, ''), mesh_devices.kind),
  cluster_id = COALESCE(NULLIF(EXCLUDED.cluster_id, ''), mesh_devices.cluster_id),
  border = EXCLUDED.border OR mesh_devices.border,
  transports = CASE WHEN EXCLUDED.transports = '{}' THEN mesh_devices.transports ELSE EXCLUDED.transports END,
  neighbors = EXCLUDED.neighbors,
  last_rssi = EXCLUDED.last_rssi,
  firmware = COALESCE(NULLIF(EXCLUDED.firmware, ''), mesh_devices.firmware),
  status = EXCLUDED.status,
  last_seen_at = GREATEST(COALESCE(EXCLUDED.last_seen_at, mesh_devices.last_seen_at), COALESCE(mesh_devices.last_seen_at, EXCLUDED.last_seen_at)),
  updated_at = now();
