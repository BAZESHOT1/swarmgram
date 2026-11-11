/** Realtime-канал: доставка зашифрованных конвертов и служебных событий онлайн-устройствам. */
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { URL } from 'node:url';
import { config } from './config.js';
import { verifyToken } from './crypto.js';
import { log } from './util.js';

type Client = WebSocket & { userId?: string; deviceId?: string; alive?: boolean };

const sockets = new Map<string, Set<Client>>();

export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 256 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') return;

    const token = url.searchParams.get('token');
    const claims = token ? verifyToken(token, config.jwtSecret) : null;
    if (!claims || claims.type !== 'access') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = ws as Client;
      client.userId = claims.sub;
      client.deviceId = claims.did;
      client.alive = true;

      let set = sockets.get(claims.sub);
      if (!set) sockets.set(claims.sub, (set = new Set()));
      set.add(client);
      log('debug', 'ws_connected', { userId: claims.sub, online: set.size });

      client.on('pong', () => {
        client.alive = true;
      });
      client.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg?.type === 'ping') client.send(JSON.stringify({ type: 'pong' }));
        } catch {
          /* ignore */
        }
      });
      client.on('close', () => {
        const s = sockets.get(claims.sub);
        if (s) {
          s.delete(client);
          if (!s.size) sockets.delete(claims.sub);
        }
      });
      client.on('error', () => client.terminate());
      client.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
    });
  });

  const heartbeat = setInterval(() => {
    for (const set of sockets.values()) {
      for (const c of set) {
        if (c.alive === false) {
          c.terminate();
          continue;
        }
        c.alive = false;
        c.ping();
      }
    }
  }, 30_000);
  heartbeat.unref();
}

/** Отправить событие всем устройствам пользователя. */
export function publish(userId: string, event: Record<string, unknown>): void {
  const set = sockets.get(userId);
  if (!set?.size) return;
  const data = JSON.stringify(event);
  for (const c of set) {
    if (c.readyState === c.OPEN) c.send(data);
  }
}

export function publishMany(userIds: string[], event: Record<string, unknown>): void {
  for (const id of new Set(userIds)) publish(id, event);
}

export function onlineUsers(): number {
  return sockets.size;
}
