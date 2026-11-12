-- OTA-обновления модулей: app-only образ сборки и очередь заданий.

ALTER TABLE firmware_builds ADD COLUMN IF NOT EXISTS app_path text;
ALTER TABLE firmware_builds ADD COLUMN IF NOT EXISTS app_sha256 text;
ALTER TABLE firmware_builds ADD COLUMN IF NOT EXISTS app_size_bytes bigint;

ALTER TABLE modules ADD COLUMN IF NOT EXISTS firmware_build_id uuid;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS firmware_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS module_ota_jobs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id     uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    build_id      uuid NOT NULL REFERENCES firmware_builds(id) ON DELETE CASCADE,
    requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    status        text NOT NULL DEFAULT 'pending',
    progress      int NOT NULL DEFAULT 0,
    error         text,
    version       text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS module_ota_jobs_module_idx
    ON module_ota_jobs (module_id, created_at DESC);
CREATE INDEX IF NOT EXISTS module_ota_jobs_active_idx
    ON module_ota_jobs (module_id) WHERE status IN ('pending', 'downloading', 'installing');
