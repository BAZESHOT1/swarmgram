-- ============================================================
--  014: история серверных сборок прошивок ESP32.
--  Конфигурация приходит из визарда, статус обновляет Hub
--  после асинхронной сборки в services/firmware-builder.
-- ============================================================
CREATE TABLE IF NOT EXISTS firmware_builds (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  log text NOT NULL DEFAULT '',
  bin_path text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS firmware_builds_user_idx ON firmware_builds (user_id, created_at DESC);
