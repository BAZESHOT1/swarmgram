-- ============================================================================
--  Klinto Hub — миграция 008: обработка жалоб и предупреждения.
-- ============================================================================

-- Статус разбора жалобы: open | resolved | dismissed
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
-- Комментарий модератора к решению
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS resolution_note text NOT NULL DEFAULT '';
-- Кто и когда разобрал жалобу
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

CREATE INDEX IF NOT EXISTS user_reports_status_idx ON user_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS user_reports_target_idx ON user_reports (target_id, created_at DESC);

-- Предупреждения пользователям от администраторов
CREATE TABLE IF NOT EXISTS user_warnings (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_warnings_user_idx ON user_warnings (user_id, created_at DESC);
