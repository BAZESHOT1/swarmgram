-- 034_module_ble_alias_unique.sql
-- BLE MAC — алиас одного физического модуля. Не даём двум записям
-- претендовать на один BLE-адрес (частая причина «размножения»).
CREATE UNIQUE INDEX IF NOT EXISTS modules_ble_mac_unique
  ON modules (lower(ble_mac))
  WHERE ble_mac <> '';

-- Исторические пары с перевёрнутым MAC сливаются кодом при register/pair
-- (mergeReversedModule). Этот индекс лишь страхует новые записи.
