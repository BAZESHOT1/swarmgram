-- ============================================================================
--  023: прогресс серверной сборки прошивки.
--
--  progress   — 0..100, плавно растёт во время сборки (не убывает).
--  phase      — queued | preparing | compiling | linking | finalizing |
--               ready | failed | timeout.
--  started_at — момент фактического старта сборки (для расчёта фаз).
-- ============================================================================

ALTER TABLE firmware_builds
    ADD COLUMN IF NOT EXISTS progress   int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS phase      text NOT NULL DEFAULT 'queued',
    ADD COLUMN IF NOT EXISTS started_at timestamptz;

-- Поллинг активных сборок пользователя идёт по (user_id, created_at),
-- отдельный индекс для выборки зависших сборок.
CREATE INDEX IF NOT EXISTS firmware_builds_active_idx
    ON firmware_builds (updated_at)
    WHERE status IN ('queued', 'building');
