-- ============================================================================
--  022: push-уведомления (FCM) — токены устройств и история доставки.
--
--  push_tokens        — зарегистрированные FCM-токены (один токен = одно
--                       устройство; UNIQUE(token) позволяет upsert).
--  push_notifications — очередь/история уведомлений. status:
--                       pending | sent | failed | delivered.
--                       attempts — число попыток отправки (retry worker).
-- ============================================================================

CREATE TABLE IF NOT EXISTS push_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform     text NOT NULL DEFAULT 'web',   -- ios | android | web
    token        text NOT NULL,
    device_id    text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    enabled      boolean NOT NULL DEFAULT true,
    CONSTRAINT push_tokens_token_key UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS push_tokens_user_idx ON push_tokens (user_id, platform);
CREATE INDEX IF NOT EXISTS push_tokens_enabled_idx ON push_tokens (user_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS push_notifications (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         text NOT NULL DEFAULT '',
    title        text NOT NULL DEFAULT '',
    body         text NOT NULL DEFAULT '',
    data         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status       text NOT NULL DEFAULT 'pending', -- pending | sent | failed | delivered
    attempts     int NOT NULL DEFAULT 0,
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    sent_at      timestamptz,
    delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS push_notifications_user_idx ON push_notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS push_notifications_status_idx ON push_notifications (status, created_at);
-- retry worker ищет только недоставленные: частичный индекс заметно дешевле.
CREATE INDEX IF NOT EXISTS push_notifications_retry_idx
    ON push_notifications (created_at)
    WHERE status IN ('pending', 'failed');
