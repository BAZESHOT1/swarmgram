-- KMesh_v1: очередь downlink для HTTP-транспорта шлюза.
--
-- Шлюз без MQTT забирает ответы коротким поллингом:
--   GET /v1/kmesh/v1/downlink?gateway_id=<id>&since=<cursor>
-- В очередь попадают ACK на принятые пакеты и серверные MeshPacket (packet_b64).

CREATE TABLE IF NOT EXISTS kmesh_v1_downlink (
  id BIGSERIAL PRIMARY KEY,
  gateway_id BIGINT NOT NULL,
  dst_node_id BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'packet',
  packet_id BIGINT,
  msg_uuid TEXT,
  packet_b64 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS kmesh_v1_downlink_pending_idx
  ON kmesh_v1_downlink (gateway_id, id)
  WHERE delivered_at IS NULL;
