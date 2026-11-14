-- ============================================================
-- 039_user_identity_modules.sql
--  Постоянная идентификация по users.id, владение модулями и
--  контракты передачи. Таблица users не изменяется.
-- ============================================================

-- Компактный сетевой идентификатор и BLE-префикс (первые 4 байта UUID).
CREATE TABLE IF NOT EXISTS user_net_identities (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  net_id      bigint UNIQUE NOT NULL,
  ble_prefix  char(8) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_net_identities_prefix_idx
  ON user_net_identities (ble_prefix);

-- Владение несколькими модулями одним аккаунтом.
CREATE TABLE IF NOT EXISTS user_modules (
  module_mac    varchar(17) PRIMARY KEY,
  mod6          char(6) NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  custom_name   text NOT NULL DEFAULT '',
  claimed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_modules_owner_idx
  ON user_modules (owner_user_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS user_modules_mod6_idx
  ON user_modules (mod6);

-- Контракт передачи модуля от старого владельца новому.
CREATE TABLE IF NOT EXISTS module_transfer_contracts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_mac   varchar(17) NOT NULL REFERENCES user_modules(module_mac) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'cancelled', 'rejected')),
  claim_token  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS module_transfer_contracts_one_pending
  ON module_transfer_contracts (module_mac) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS module_transfer_contracts_from_idx
  ON module_transfer_contracts (from_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS module_transfer_contracts_to_idx
  ON module_transfer_contracts (to_user_id, created_at DESC);

-- Телеметрия: к какому пользователю относится узел.
ALTER TABLE kmesh_nodes_telemetry
  ADD COLUMN IF NOT EXISTS owner_net_id bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS kmesh_nodes_telemetry_owner_idx
  ON kmesh_nodes_telemetry (owner_net_id, last_seen_at DESC);
