#!/usr/bin/env python3
"""
Выдача claim-токена для привязки узла серверу SwarmGram (обходной путь
администратора: узел регистрируется на сервере без открытия UI).

Запуск на сервере:  python3 scripts/issue_claim.py <username>
Вывод: claim-токен (12 символов), вставить в .env узла как NODE_CLAIM_TOKEN.

Формат хэша идентичен API Hub: scrypt$sha256(code:swarmgram).
"""
import hashlib
import secrets
import subprocess
import sys

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CLAIM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
SALT = "swarmgram"


def sql(query: str) -> str:
    out = subprocess.check_output(
        ["docker", "exec", "swarmgram-postgres", "psql", "-U", "swarm", "-d", "swarm", "-tAc", query],
        text=True,
    )
    return out.strip()


def claim_hash(code: str) -> str:
    digest = hashlib.sha256(f"{code}:{SALT}".encode()).hexdigest()
    return f"scrypt${digest}"


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python3 scripts/issue_claim.py <username>")
        sys.exit(1)
    username = sys.argv[1].lower().strip()
    user_id = sql(f"SELECT id FROM users WHERE lower(username) = '{username}'")
    if not user_id:
        print(f"ERROR user_not_found: {username}")
        sys.exit(1)
    status = sql(f"SELECT status FROM users WHERE id = '{user_id}'")
    if status != "active":
        print(f"ERROR user_inactive: {username}")
        sys.exit(1)

    code = "".join(secrets.choice(CLAIM_ALPHABET) for _ in range(12))
    sql(
        "INSERT INTO node_claims (user_id, code_hash, expires_at) "
        f"VALUES ('{user_id}', '{claim_hash(code)}', now() + interval '30 minutes')"
    )
    print(code)


if __name__ == "__main__":
    main()
