-- Имена модулей, сохранённая конфигурация прошивки и релизы для бейджа обновления.

ALTER TABLE modules ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS board text;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS firmware_config jsonb;

CREATE TABLE IF NOT EXISTS firmware_releases (
    board       text PRIMARY KEY,
    version     text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Разумные имена для уже существующих модулей: username + порядковый номер.
WITH numbered AS (
  SELECT m.id,
         u.username,
         row_number() OVER (PARTITION BY m.owner_id ORDER BY m.created_at, m.id) AS rn
    FROM modules m
    JOIN users u ON u.id = m.owner_id
)
UPDATE modules m
   SET name = numbered.username || ' #' || numbered.rn
  FROM numbered
 WHERE numbered.id = m.id AND (m.name IS NULL OR m.name = '');

-- Восстанавливаем сохранённую конфигурацию по последней совпавшей сборке.
UPDATE modules m
   SET firmware_config = b.config,
       board = COALESCE(m.board, b.config->>'board')
  FROM firmware_builds b
 WHERE m.firmware_config IS NULL
   AND b.status = 'ready'
   AND m.firmware = b.version;
