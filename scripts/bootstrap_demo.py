#!/usr/bin/env python3
"""
Разовая инициализация демо-сети SwarmGram на сервере:
  1) регистрирует пользователей-владельцев узлов,
  2) создаёт claim-токены,
  3) пишет .env для контейнеров узлов,
  4) генерирует docker-compose.nodes-local.yml.

Запуск на сервере:  python3 scripts/bootstrap_demo.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("HUB_URL", "http://127.0.0.1:8080")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODES = [
    {"user": "node1", "email": "node1@swarmgram.local", "name": "swarm-node-1", "port": 9091},
    {"user": "node2", "email": "node2@swarmgram.local", "name": "swarm-node-2", "port": 9092},
    {"user": "node3", "email": "node3@swarmgram.local", "name": "swarm-node-3", "port": 9093},
]
PASSWORD = os.environ.get("DEMO_PASSWORD", "Demo12345!")
PUBLIC_HOST = os.environ.get("NODE_PUBLIC_HOST", "150.251.143.212")
CAPACITY_GB = os.environ.get("NODE_CAPACITY_GB", "5")


def req(method: str, path: str, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("content-type", "application/json")
    if token:
        r.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        payload = e.read().decode()
        print(f"  ! {method} {path} -> {e.code}: {payload[:200]}")
        raise


def main():
    os.makedirs(os.path.join(ROOT, "nodes"), exist_ok=True)
    tokens = {}
    print("== регистрация пользователей ==")
    for n in NODES:
        try:
            res = req(
                "POST",
                "/v1/auth/register",
                {
                    "email": n["email"],
                    "username": n["user"],
                    "password": PASSWORD,
                    "displayName": n["user"],
                    "device": {"deviceName": "demo bootstrap", "platform": "server"},
                },
            )
            tokens[n["user"]] = res["accessToken"]
            print(f"  ok {n['user']}")
        except Exception:
            # возможно, уже зарегистрирован — логинимся
            res = req("POST", "/v1/auth/login", {"login": n["user"], "password": PASSWORD, "device": {}})
            tokens[n["user"]] = res["accessToken"]
            print(f"  ok {n['user']} (вход)")

    print("== claim-токены и .env узлов ==")
    env_files = []
    for n in NODES:
        claim = req("POST", "/v1/nodes/claim", {"nodeName": n["name"]}, tokens[n["user"]])
        env_path = os.path.join(ROOT, "nodes", f"{n['user']}.env")
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(
                f"MAIN_SERVER_URL={BASE}\n"
                f"OWNER_USERNAME={n['user']}\n"
                f"NODE_CLAIM_TOKEN={claim['claimToken']}\n"
                f"NODE_PUBLIC_URL=http://{PUBLIC_HOST}:{n['port']}\n"
                f"NODE_PORT_HOST={n['port']}\n"
                f"NODE_NAME={n['name']}\n"
                f"NODE_REGION=eu\n"
                f"NODE_CAPACITY_GB={CAPACITY_GB}\n"
            )
        env_files.append((n, env_path))
        print(f"  ok {n['user']} -> {env_path}")

    compose = ["services:"]
    for n, env_path in env_files:
        compose += [
            f"  {n['user']}:",
            "    image: swarmgram/node:1.0.0",
            f"    container_name: swarmgram-node-{n['user']}",
            "    restart: unless-stopped",
            f"    env_file: {os.path.relpath(env_path, ROOT)}",
            "    environment:",
            '      NODE_PORT: "9090"',
            '      NODE_DATA_DIR: /data',
            "    volumes:",
            f"      - {n['user']}_data:/data",
            "    ports:",
            f"      - \"{n['port']}:9090\"",
        ]
    compose += ["", "volumes:"]
    for n, _ in env_files:
        compose.append(f"  {n['user']}_data:")

    compose_path = os.path.join(ROOT, "docker-compose.nodes-local.yml")
    with open(compose_path, "w", encoding="utf-8") as f:
        f.write("\n".join(compose) + "\n")
    print(f"== compose написан: {compose_path} ==")
    print("\nДальше:  cd /opt/swarmgram && docker compose -f docker-compose.nodes-local.yml up -d")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Ошибка:", e, file=sys.stderr)
        sys.exit(1)
