-- kMesh-сообщения, синхронизированные без схемы шифрования, в обычных (серверных) чатах:
-- проставляем scheme=server и версию ключа, иначе клиенты показывают «Зашифрованное сообщение».
UPDATE messages m
   SET header = (m.header::jsonb
                 || jsonb_build_object('scheme', 'server')
                 || COALESCE((SELECT jsonb_build_object('keyVersion', max(v.version))
                                FROM chat_key_versions v WHERE v.chat_id = m.chat_id
                              HAVING max(v.version) IS NOT NULL), '{}'::jsonb))
  FROM chats c
 WHERE c.id = m.chat_id
   AND c.encryption <> 'e2e'
   AND (m.header::jsonb ->> 'kmeshV1') = 'true'
   AND (m.header::jsonb ->> 'scheme') IS NULL;
