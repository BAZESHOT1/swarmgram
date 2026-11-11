-- ============================================================
--  021: плавный вывод узла из эксплуатации (drain).
--
--  drain_requested_at — когда владелец попросил вывести узел;
--  drained_at         — когда реплики были перенесены и узел погашен.
--  Статусы 'draining' / 'offline' уже используются в routes/nodes.ts.
-- ============================================================
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS drain_requested_at timestamptz;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS drained_at timestamptz;

-- быстрый поиск узлов, которые ещё выводятся
CREATE INDEX IF NOT EXISTS nodes_draining_idx ON nodes (status) WHERE status = 'draining';
