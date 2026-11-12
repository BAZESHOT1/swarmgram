-- 028_module_identity_dedup.sql
-- Идентичность модуля — только заводской MAC ESP32 (esp32-<12 hex>).
-- У старых записей hardware_id мог быть выдуманным ID, а MAC лежал в
-- board_uuid. Канонизируем и сливаем дубли, чтобы один физический модуль
-- всегда был одной строкой.

-- 1. Если hardware_id не MAC, но MAC есть в board_uuid — берём его.
UPDATE modules
SET hardware_id = 'esp32-' || lower(substring(board_uuid from '([0-9a-fA-F]{12})'))
WHERE (hardware_id IS NULL OR hardware_id !~* '^esp32-[0-9a-f]{12}$')
  AND coalesce(board_uuid, '') ~* '([0-9a-fA-F]{12})';

-- 2. Если MAC встречается внутри произвольного hardware_id — канонизируем.
UPDATE modules
SET hardware_id = 'esp32-' || lower(substring(hardware_id from '([0-9a-fA-F]{12})'))
WHERE hardware_id !~* '^esp32-[0-9a-f]{12}$'
  AND hardware_id ~* '([0-9a-fA-F]{12})';

-- 3. board_uuid всегда равен каноническому MAC.
UPDATE modules
SET board_uuid = hardware_id
WHERE hardware_id ~* '^esp32-[0-9a-f]{12}$'
  AND board_uuid IS DISTINCT FROM hardware_id;

-- 4. Сливаем дубли по MAC: оставляем запись реального пользователя,
--    затем самую свежую. Дочерние строки удаляются каскадно.
WITH system_owner AS (
  SELECT id FROM users WHERE username = 'system_modules' LIMIT 1
),
ranked AS (
  SELECT m.id,
         row_number() OVER (
           PARTITION BY lower(m.hardware_id)
           ORDER BY
             CASE WHEN m.owner_id = (SELECT id FROM system_owner) THEN 1 ELSE 0 END ASC,
             m.last_seen_at DESC NULLS LAST,
             m.created_at DESC
         ) AS rn
  FROM modules m
  WHERE m.hardware_id ~* '^esp32-[0-9a-f]{12}$'
)
DELETE FROM modules m
USING ranked r
WHERE m.id = r.id AND r.rn > 1;

-- 5. Больше один MAC не может иметь две записи.
CREATE UNIQUE INDEX IF NOT EXISTS modules_hardware_id_unique
  ON modules (lower(hardware_id))
  WHERE hardware_id ~* '^esp32-[0-9a-f]{12}$';
