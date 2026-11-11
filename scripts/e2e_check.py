#!/usr/bin/env python3
"""Сквозная проверка сети SwarmGram: загрузка объекта, 3 реплики, прямое скачивание с узла по тикету."""
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("HUB_URL", "http://127.0.0.1:8080")
USER = os.environ.get("DEMO_USER", "node1")
PASSWORD = os.environ.get("DEMO_PASSWORD", "Demo12345!")


def req(method, path, body=None, token=None, raw=False, headers=None):
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if not raw:
        r.add_header("content-type", "application/json")
    if token:
        r.add_header("authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main():
    login = json.loads(req("POST", "/v1/auth/login", {"login": USER, "password": PASSWORD, "device": {}})[2])
    token = login["accessToken"]
    print(f"1. login ok: {login['user']['username']}")

    payload = os.urandom(200_000)
    sha = hashlib.sha256(payload).hexdigest()
    status, _, body = req(
        "POST",
        "/v1/objects",
        payload,
        token,
        raw=True,
        headers={"content-type": "application/octet-stream", "x-sg-filename": "test.bin"},
    )
    print(f"2. upload: HTTP {status} {body.decode()[:160]}")
    if status != 201:
        sys.exit(1)
    obj = json.loads(body)
    oid = obj["id"]

    status, _, body = req("GET", f"/v1/objects/{oid}", None, token)
    routes = json.loads(body)
    ok_replicas = len(routes["fragments"]) == obj["replicasDesired"]
    print(f"3. routes: {len(routes['fragments'])} реплик (ожидалось {obj['replicasDesired']}) — {'OK' if ok_replicas else 'FAIL'}")
    print(f"   sha256 совпадает: {routes['sha256'] == sha}")
    nodes_used = set()
    for f in routes["fragments"]:
        nodes_used.add(f["nodeId"])
        print(f"   frag {f['index']} -> узел {f['nodeId'][:8]} online={f['nodeOnline']}")
    print(f"4. реплики на разных узлах: {len(nodes_used)} — {'OK' if len(nodes_used) == len(routes['fragments']) else 'FAIL'}")

    frag = routes["fragments"][0]
    r2 = urllib.request.Request(frag["url"], headers={"x-sg-ticket": frag["ticket"]})
    with urllib.request.urlopen(r2, timeout=60) as resp:
        data = resp.read()
    same = hashlib.sha256(data).hexdigest() == sha
    print(f"5. прямое скачивание с узла: {len(data)} байт, sha совпадает — {'OK' if same else 'FAIL'}")

    # без тикета узел обязан отказать
    try:
        urllib.request.urlopen(frag["url"], timeout=10)
        print("6. доступ без тикета: FAIL (узел отдал данные!)")
    except urllib.error.HTTPError as e:
        print(f"6. доступ без тикета: HTTP {e.code} — {'OK' if e.code == 401 else 'FAIL'}")

    status, _, body = req("GET", "/v1/stats")
    stats = json.loads(body)
    print(f"7. stats: {stats['objects']} объектов, {stats['storedBytes']} байт, узлов онлайн {stats['nodes']['online']}")

    all_ok = ok_replicas and len(nodes_used) == len(routes["fragments"]) and same
    print("\nRESULT:", "PASS" if all_ok else "FAIL")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
