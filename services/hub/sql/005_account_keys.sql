-- ============================================================================
--  Kinto Hub — миграция 005: ключи уровня аккаунта (мультиустройство).
--
--  В отличие от device-level обёрток (chat_keys), ключ чата дополнительно
--  оборачивается под публичный ключ АККАУНТА каждого участника. Приватный
--  ключ аккаунта хранится только в шифрованном резерве пользователя
--  (PBKDF2 от пароля), поэтому любое новое устройство после входа
--  автоматически читает все чаты.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_pub text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS account_chat_keys (
    chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrapped_key text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS account_chat_keys_user_idx ON account_chat_keys (user_id);
