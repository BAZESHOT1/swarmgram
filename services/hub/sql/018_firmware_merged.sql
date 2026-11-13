-- ============================================================================
--  Klinto Hub — миграция 018: формат бинарника прошивки.
--
--  merged = true  — единый .bin (bootloader + partitions + boot_app0 + app),
--                   его можно писать с адреса 0x0 из браузера.
--  merged = false — старый app-only .bin (писать только с 0x10000 вручную).
-- ============================================================================
ALTER TABLE firmware_builds ADD COLUMN IF NOT EXISTS merged boolean NOT NULL DEFAULT false;
