-- Удаление сообщения только у себя: скрываем его для конкретного пользователя.
CREATE TABLE IF NOT EXISTS message_hidden (
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hidden_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_hidden_user_idx ON message_hidden (user_id);
