-- ============================================================
-- 036_kmesh_v1_rename.sql
--  Безопасное переименование таблиц SwarmGram Mesh v3 -> Klinto KMesh_v1.
--
--  На существующей базе миграция 035 уже применена и создала
--  mesh_v3_*; здесь они переименовываются один раз.
--  На новой базе 035 уже создаёт kmesh_v1_*, поэтому все проверки
--  ниже являются no-op. Данные не копируются и не теряются.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.mesh_v3_presence') IS NOT NULL
     AND to_regclass('public.kmesh_v1_presence') IS NULL THEN
    ALTER TABLE public.mesh_v3_presence RENAME TO kmesh_v1_presence;
  END IF;

  IF to_regclass('public.mesh_v3_archive') IS NOT NULL
     AND to_regclass('public.kmesh_v1_archive') IS NULL THEN
    ALTER TABLE public.mesh_v3_archive RENAME TO kmesh_v1_archive;
  END IF;

  IF to_regclass('public.mesh_v3_messages') IS NOT NULL
     AND to_regclass('public.kmesh_v1_messages') IS NULL THEN
    ALTER TABLE public.mesh_v3_messages RENAME TO kmesh_v1_messages;
  END IF;

  IF to_regclass('public.mesh_v3_sync_events') IS NOT NULL
     AND to_regclass('public.kmesh_v1_sync_events') IS NULL THEN
    ALTER TABLE public.mesh_v3_sync_events RENAME TO kmesh_v1_sync_events;
  END IF;

  IF to_regclass('public.mesh_v3_gateways') IS NOT NULL
     AND to_regclass('public.kmesh_v1_gateways') IS NULL THEN
    ALTER TABLE public.mesh_v3_gateways RENAME TO kmesh_v1_gateways;
  END IF;

  -- Индексы: имена не меняются автоматически при RENAME TABLE.
  IF to_regclass('public.mesh_v3_presence_gateway_idx') IS NOT NULL THEN
    ALTER INDEX public.mesh_v3_presence_gateway_idx RENAME TO kmesh_v1_presence_gateway_idx;
  END IF;
  IF to_regclass('public.mesh_v3_presence_expiry_idx') IS NOT NULL THEN
    ALTER INDEX public.mesh_v3_presence_expiry_idx RENAME TO kmesh_v1_presence_expiry_idx;
  END IF;
  IF to_regclass('public.mesh_v3_archive_status_idx') IS NOT NULL THEN
    ALTER INDEX public.mesh_v3_archive_status_idx RENAME TO kmesh_v1_archive_status_idx;
  END IF;
  IF to_regclass('public.mesh_v3_messages_chat_idx') IS NOT NULL THEN
    ALTER INDEX public.mesh_v3_messages_chat_idx RENAME TO kmesh_v1_messages_chat_idx;
  END IF;
  IF to_regclass('public.mesh_v3_messages_sender_idx') IS NOT NULL THEN
    ALTER INDEX public.mesh_v3_messages_sender_idx RENAME TO kmesh_v1_messages_sender_idx;
  END IF;
  IF to_regclass('public.mesh_v3_sync_events_user_idx') IS NOT NULL THEN
    ALTER INDEX public.mesh_v3_sync_events_user_idx RENAME TO kmesh_v1_sync_events_user_idx;
  END IF;

  -- Последовательность bigserial тоже сохраняет старое имя.
  IF to_regclass('public.mesh_v3_sync_events_id_seq') IS NOT NULL
     AND to_regclass('public.kmesh_v1_sync_events_id_seq') IS NULL THEN
    ALTER SEQUENCE public.mesh_v3_sync_events_id_seq RENAME TO kmesh_v1_sync_events_id_seq;
  END IF;
END $$;
