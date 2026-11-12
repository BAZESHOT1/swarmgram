-- ============================================================
--  027: заявки на перенос модуля между пользователями.
--
--  Владелец модуля создаёт заявку, целевой пользователь принимает или
--  отклоняет её. До принятия модуль остаётся у прежнего владельца.
--  token_version позволяет отозвать ранее выданные module-токены при
--  смене владельца (requireModule сверяет tv в токене с этим полем).
-- ============================================================

ALTER TABLE modules ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS module_transfers (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id      uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    from_owner_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hardware_id    text NOT NULL DEFAULT '',
    public_id      text NOT NULL DEFAULT '',
    status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
    requested_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    resolved_at    timestamptz,
    expires_at     timestamptz NOT NULL DEFAULT now() + interval '7 days'
);

-- Одна активная заявка на модуль.
CREATE UNIQUE INDEX IF NOT EXISTS module_transfers_one_pending
    ON module_transfers (module_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS module_transfers_from_idx
    ON module_transfers (from_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS module_transfers_to_idx
    ON module_transfers (to_owner_id, created_at DESC);
