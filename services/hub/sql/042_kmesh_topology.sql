-- Карта кластеров KMesh: кого каждый узел слышит напрямую (из presence) и отображаемые имена модулей.
CREATE TABLE IF NOT EXISTS kmesh_v1_links (
  node_id      bigint NOT NULL,
  neighbor_id  bigint NOT NULL,
  rssi         integer NOT NULL DEFAULT 0,
  flags        integer NOT NULL DEFAULT 0,
  seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, neighbor_id)
);
CREATE INDEX IF NOT EXISTS kmesh_v1_links_seen_idx ON kmesh_v1_links (seen_at);
ALTER TABLE kmesh_v1_presence ADD COLUMN IF NOT EXISTS display_name text;
