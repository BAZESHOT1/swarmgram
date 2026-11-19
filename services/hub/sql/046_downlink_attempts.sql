-- Повторная доставка downlink ограничена: раньше каждый heartbeat модуля заново ставил в очередь
-- все уже доставленные пакеты и продлевал их на сутки — старые сообщения приходили снова и снова.
ALTER TABLE kmesh_v1_downlink ADD COLUMN IF NOT EXISTS attempts smallint NOT NULL DEFAULT 0;
-- Старые «вечные» пакеты, уже доставленные хотя бы раз, больше не повторяем.
UPDATE kmesh_v1_downlink SET attempts = 3 WHERE delivered_at IS NOT NULL;
