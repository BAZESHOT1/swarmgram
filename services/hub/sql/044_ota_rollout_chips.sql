-- Раскатка только для выбранных чипов (NULL — все): например, сначала ESP32-C3, потом ESP32.
ALTER TABLE kmesh_ota_rollouts ADD COLUMN IF NOT EXISTS chips text[];
