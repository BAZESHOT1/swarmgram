-- 029_remove_synthetic_modules.sql
-- Удаляем записи, созданные старыми версиями мастера/тестов с выдуманными
-- MAC-адресами. Реальные устройства всегда имеют заводской MAC ESP32,
-- поэтому эти строки не могут соответствовать физическому модулю.

DELETE FROM modules
WHERE lower(hardware_id) IN (
  'esp32-112233445566',
  'esp32-998877665544',
  'esp32-aabbccddeeff',
  'esp32-001122334455',
  'esp32-0123456789ab',
  'esp32-deadbeefcafe',
  'esp32-123456789012',
  'esp32-abcdefabcdef',
  'esp32-000000000000'
);
