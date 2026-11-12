-- ============================================================================
--  Kinto Hub — первичная схема
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email               text NOT NULL,
    username            text NOT NULL,
    display_name        text NOT NULL DEFAULT '',
    password_hash       text NOT NULL,
    password_algo       text NOT NULL DEFAULT 'scrypt',
    plan                text NOT NULL DEFAULT 'free',
    status              text NOT NULL DEFAULT 'active',
    email_verified      boolean NOT NULL DEFAULT false,
    quota_bytes         bigint NOT NULL DEFAULT 1073741824,
    used_bytes          bigint NOT NULL DEFAULT 0,
    avatar_object_id    uuid,
    username_changed_at timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key    ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));

CREATE TABLE IF NOT EXISTS username_history (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username   text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS username_history_user_idx ON username_history (user_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS devices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          text NOT NULL DEFAULT 'Unknown device',
    platform      text NOT NULL DEFAULT 'web',
    identity_pub  text NOT NULL DEFAULT '',
    ecdh_pub      text NOT NULL DEFAULT '',
    signed_prekey text NOT NULL DEFAULT '',
    prekey_sig    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id);

CREATE TABLE IF NOT EXISTS prekeys (
    id           bigserial PRIMARY KEY,
    device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    public_key   text NOT NULL,
    consumed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS prekeys_device_idx ON prekeys (device_id, consumed_at);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    token_hash  text NOT NULL,
    user_agent  text NOT NULL DEFAULT '',
    ip          text NOT NULL DEFAULT '',
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz,
    rotated_to  uuid
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS email_codes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email      text NOT NULL,
    code_hash  text NOT NULL,
    purpose    text NOT NULL DEFAULT 'verify',
    expires_at timestamptz NOT NULL,
    attempts   int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_codes_email_idx ON email_codes (lower(email), purpose);

-- ---------------------------- Чаты и сообщения ----------------------------

CREATE TABLE IF NOT EXISTS chats (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type       text NOT NULL DEFAULT 'direct',
    title      text NOT NULL DEFAULT '',
    owner_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_seq   bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        text NOT NULL DEFAULT 'member',
    joined_at   timestamptz NOT NULL DEFAULT now(),
    last_read_seq bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user_idx ON chat_members (user_id);

-- Оборания ключа чата под каждое устройство участника (сервер видит только шифротекст ключа)
CREATE TABLE IF NOT EXISTS chat_keys (
    chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    wrapped_key text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, device_id)
);

CREATE TABLE IF NOT EXISTS messages (
    seq              bigserial PRIMARY KEY,
    id               uuid NOT NULL DEFAULT gen_random_uuid(),
    chat_id          uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
    kind             text NOT NULL DEFAULT 'text',
    ciphertext       bytea NOT NULL,
    nonce            bytea NOT NULL,
    header           jsonb NOT NULL DEFAULT '{}'::jsonb,
    object_id        uuid,
    reply_to         uuid,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_chat_seq_idx ON messages (chat_id, seq DESC);

-- ---------------------------- Узлы и объекты ------------------------------

CREATE TABLE IF NOT EXISTS nodes (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    name             text NOT NULL DEFAULT 'node',
    public_url       text NOT NULL,
    ticket_secret    text NOT NULL,
    token_hash       text NOT NULL DEFAULT '',
    region           text NOT NULL DEFAULT '',
    version          text NOT NULL DEFAULT '1.0.0',
    capacity_bytes   bigint NOT NULL DEFAULT 0,
    used_bytes       bigint NOT NULL DEFAULT 0,
    free_bytes       bigint NOT NULL DEFAULT 0,
    status           text NOT NULL DEFAULT 'pending',
    reputation       int NOT NULL DEFAULT 50,
    uptime_ratio     numeric(5,4) NOT NULL DEFAULT 1.0,
    total_puts       bigint NOT NULL DEFAULT 0,
    total_gets       bigint NOT NULL DEFAULT 0,
    bytes_served     bigint NOT NULL DEFAULT 0,
    last_heartbeat_at timestamptz,
    last_ping_ok_at   timestamptz,
    registered_at     timestamptz NOT NULL DEFAULT now(),
    pgp_note          text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS nodes_status_idx ON nodes (status, reputation DESC);
CREATE INDEX IF NOT EXISTS nodes_owner_idx ON nodes (owner_id);

CREATE TABLE IF NOT EXISTS node_claims (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash    text NOT NULL,
    expires_at   timestamptz NOT NULL,
    consumed_at  timestamptz,
    node_id      uuid,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_events (
    id         bigserial PRIMARY KEY,
    node_id    uuid REFERENCES nodes(id) ON DELETE CASCADE,
    type       text NOT NULL,
    message    text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS node_events_node_idx ON node_events (node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS objects (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size_bytes       bigint NOT NULL,
    sha256           text NOT NULL DEFAULT '',
    replicas_desired int NOT NULL DEFAULT 3,
    created_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz
);
CREATE INDEX IF NOT EXISTS objects_owner_idx ON objects (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fragments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id  uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    node_id    uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    index      int NOT NULL,
    size_bytes bigint NOT NULL DEFAULT 0,
    sha256     text NOT NULL DEFAULT '',
    state      text NOT NULL DEFAULT 'ok',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (object_id, node_id, index)
);
CREATE INDEX IF NOT EXISTS fragments_object_idx ON fragments (object_id);
CREATE INDEX IF NOT EXISTS fragments_node_idx ON fragments (node_id);

CREATE TABLE IF NOT EXISTS object_grants (
    object_id  uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (object_id, user_id)
);

-- ---------------------------- Биллинг и аудит -----------------------------

CREATE TABLE IF NOT EXISTS node_contributions (
    id            bigserial PRIMARY KEY,
    node_id       uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    day           date NOT NULL DEFAULT current_date,
    bytes_stored  bigint NOT NULL DEFAULT 0,
    bytes_served  bigint NOT NULL DEFAULT 0,
    uptime_seconds int NOT NULL DEFAULT 0,
    credits       numeric(14,6) NOT NULL DEFAULT 0,
    UNIQUE (node_id, day)
);

CREATE TABLE IF NOT EXISTS ledger (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       text NOT NULL,
    amount     numeric(14,6) NOT NULL DEFAULT 0,
    meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
    id         bigserial PRIMARY KEY,
    actor_id   uuid,
    action     text NOT NULL,
    target     text NOT NULL DEFAULT '',
    meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
