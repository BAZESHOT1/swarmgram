-- ============================================================================
--  Klinto Hub — миграция 006: серверные ключи чатов, закреплённые сообщения,
--  реакции на сообщения.
--
--  Основной режим — 'server': ключ чата хранится только на Hub в зашифрованном
--  виде (master-ключ из окружения). E2E остаётся для «секретных» чатов.
-- ============================================================================
ALTER TABLE chats ADD COLUMN IF NOT EXISTS encryption text NOT NULL DEFAULT 'server';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS pinned_message_id uuid;

CREATE TABLE IF NOT EXISTS chat_key_versions (
    chat_id    uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    version    int NOT NULL,
    key_enc    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, version)
);

CREATE TABLE IF NOT EXISTS message_reactions (
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_msg_idx ON message_reactions (message_id);
