-- KMesh_v1: реестр chat_ref и маршрутизация downlink по node_id.
--
-- Клиент считает chat_ref = CRC16(chatId). Hub запоминает соответствие,
-- чтобы по RPC (в котором есть только chat_ref) найти чат, получателей
-- и положить ответ/сообщение в очередь нужного шлюза.

CREATE TABLE IF NOT EXISTS kmesh_v1_chat_refs (
  chat_ref   integer NOT NULL,
  chat_id    uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_ref, chat_id)
);

CREATE INDEX IF NOT EXISTS kmesh_v1_chat_refs_chat_idx
  ON kmesh_v1_chat_refs (chat_id);

ALTER TABLE kmesh_v1_downlink
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes';

CREATE INDEX IF NOT EXISTS kmesh_v1_downlink_node_idx
  ON kmesh_v1_downlink (dst_node_id, id)
  WHERE delivered_at IS NULL;
