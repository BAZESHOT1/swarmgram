-- ============================================================================
--  SwarmGram Hub — миграция 004: шифрованные резервные копии ключей.
--
--  Пользователь не теряет доступ к чатам на новом устройстве:
--  клиент производит blob с ключами чатов (AES-GCM, ключ = PBKDF2(пароль, kdf_salt)),
--  сервер хранит ТОЛЬКО этот blob и соль KDF. Пароль и открытые ключи на сервер не уходят.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS kdf_salt text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS key_backups (
    user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    blob        text NOT NULL,          -- {v:1,kdf,salt,nonce,ct} — всё в base64 внутри JSON
    updated_at  timestamptz NOT NULL DEFAULT now()
);
