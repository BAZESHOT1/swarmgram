#!/usr/bin/env node
/**
 * Kinto module bridge — локальный сервис для админ-страницы модулей.
 *
 * Даёт браузеру то, чего у него нет: доступ к COM-портам, мониторы порта,
 * сброс и прошивку через esptool. Слушает только 127.0.0.1.
 *
 *   node server.mjs [--port 8787]
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SerialPort } from 'serialport';

const HTTP_PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 8787);
const MAX_LINES = 600;
const PYTHON = process.env.KINTO_PYTHON
  || join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe');

/** path -> { path, baud, port, lines, info, openedAt, error } */
const sessions = new Map();
const sseClients = new Map(); // path -> Set<res>

function logLine(path, line) {
  const session = sessions.get(path);
  if (!session) return;
  const text = line.replace(/\r$/, '');
  session.lines.push(text);
  if (session.lines.length > MAX_LINES) session.lines.splice(0, session.lines.length - MAX_LINES);
  parseInfo(session, text);
  const clients = sseClients.get(path);
  if (clients) {
    const payload = `data: ${JSON.stringify({ line: text, ts: Date.now() })}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* ignore */ }
    }
  }
}

function parseInfo(session, line) {
  const info = line.match(/SG-INFO (\{.*\})/);
  if (info) {
    try {
      const parsed = JSON.parse(info[1]);
      session.info = { ...(session.info ?? {}), ...parsed };
    } catch { /* ignore */ }
  }
  const fw = line.match(/firmware=([^\s]+)/);
  if (fw) session.info = { ...(session.info ?? {}), firmware: fw[1] };
  const role = line.match(/role=([a-z]+)/i);
  if (role && !session.info?.role) session.info = { ...(session.info ?? {}), role: role[1] };
  const mac = line.match(/hardwareId":"(esp32-[0-9a-f]{12})"/i);
  if (mac) session.info = { ...(session.info ?? {}), hardwareId: mac[1].toLowerCase() };
}

function broadcastStatus(path) {
  const clients = sseClients.get(path);
  if (!clients) return;
  const session = sessions.get(path);
  const payload = `event: status\ndata: ${JSON.stringify(statusOf(session))}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

function statusOf(session) {
  if (!session) return null;
  return {
    path: session.path,
    baud: session.baud,
    open: Boolean(session.port?.isOpen),
    info: session.info ?? null,
    openedAt: session.openedAt ?? null,
    error: session.error ?? null,
    lines: session.lines.length,
  };
}

async function listPorts() {
  const ports = await SerialPort.list();
  return ports.map((p) => {
    const session = sessions.get(p.path);
    return {
      ...p,
      open: Boolean(session?.port?.isOpen),
      info: session?.info ?? null,
    };
  });
}

async function openPort(path, baud = 115200) {
  let session = sessions.get(path);
  if (session?.port?.isOpen) {
    if (session.baud === baud) return statusOf(session);
    await closePort(path);
    return openPort(path, baud);
  }
  session = session ?? { path, baud, port: null, lines: [], info: null };
  session.baud = baud;
  session.error = null;
  sessions.set(path, session);

  const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
  session.port = port;
  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });
  // ESP32-C3/S3 (USB-Serial/JTAG) после esptool остаётся в download mode,
  // если линии DTR/RTS выставлены «как при прошивке». Нормальный boot:
  // DTR=0, RTS=1 (EN low) -> RTS=0 (EN high при GPIO9 high).
  try {
    port.set({ dtr: false, rts: true });
    await sleep(250);
    port.set({ dtr: false, rts: false });
    await sleep(150);
  } catch {
    /* платы с обычным UART не требуют этой последовательности */
  }
  session.openedAt = new Date().toISOString();

  let pending = '';
  port.on('data', (buf) => {
    pending += buf.toString('utf8');
    let idx;
    while ((idx = pending.indexOf('\n')) >= 0) {
      logLine(path, pending.slice(0, idx));
      pending = pending.slice(idx + 1);
    }
    if (pending.length > 4096) pending = pending.slice(-2048);
  });
  port.on('close', () => {
    session.error = 'closed';
    broadcastStatus(path);
  });
  port.on('error', (err) => {
    session.error = err.message;
    logLine(path, `[bridge] port error: ${err.message}`);
    broadcastStatus(path);
  });
  // ВАЖНО: не дёргаем DTR/RTS при открытии. У ESP32-C3/S3 с USB-JTAG этот
  // импульс переводит чип в download mode, и модуль «пропадает» из mesh,
  // хотя физически исправен. Сброс — только явной кнопкой /api/reset.
  broadcastStatus(path);
  return statusOf(session);
}

async function closePort(path) {
  const session = sessions.get(path);
  if (!session) return null;
  if (session.port?.isOpen) {
    // close() может не вызвать callback, если в порт стоит незавершённая
    // запись. Не даём bridge зависнуть и держать COM-порт.
    await Promise.race([
      new Promise((resolve) => session.port.close(() => resolve())),
      sleep(1500),
    ]);
    try { session.port?.destroy?.(); } catch { /* ignore */ }
  }
  session.port = null;
  broadcastStatus(path);
  return statusOf(session);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function writePort(path, text) {
  const session = sessions.get(path);
  if (!session?.port?.isOpen) throw new Error('port_not_open');
  const payload = text.endsWith('\n') ? text : `${text}\n`;
  logLine(path, `[tx] ${text}`);
  await new Promise((resolve, reject) => session.port.write(payload, (err) => (err ? reject(err) : resolve())));
  return { ok: true };
}

async function resetPort(path) {
  const session = sessions.get(path);
  if (!session?.port?.isOpen) throw new Error('port_not_open');
  session.port.set({ dtr: false, rts: true });
  await sleep(150);
  session.port.set({ dtr: false, rts: false });
  return { ok: true };
}

function run(cmd, args, onLine) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const push = (buf) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine?.(line);
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (err) => resolve({ code: -1, error: err.message }));
    child.on('close', (code) => resolve({ code }));
  });
}

async function flash({ path, url, file, token, board = 'esp32', baud = 921600, offset = '0x0' }) {
  if (!existsSync(PYTHON)) throw new Error(`python_not_found:${PYTHON}`);
  let localFile = file;
  if (!localFile && url) {
    localFile = await download(url, token);
  }
  if (!localFile || !existsSync(localFile)) throw new Error('firmware_file_missing');

  await closePort(path);
  const chip = board === 'esp32c3' ? 'esp32c3' : board === 'esp32s3' ? 'esp32s3' : 'esp32';
  logLine(path, `[flash] ${board} ${localFile} -> ${path}`);
  // После close порт не открыт, поэтому пишем прогресс в общий буфер.
  const emit = (line) => logLine(path, `[flash] ${line}`);
  const result = await run(PYTHON, [
    '-m', 'esptool', '--chip', chip, '--port', path, '--baud', String(baud),
    '--before', 'default_reset', '--after', 'hard_reset',
    'write_flash', offset, localFile,
  ], emit);
  emit(`esptool exit=${result.code}`);
  await sleep(500);
  await openPort(path, 115200);
  return { ok: result.code === 0, code: result.code, file: localFile };
}

async function download(url, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`download_${res.status}`);
  const dir = mkdtempSync(join(tmpdir(), 'kinto-fw-'));
  const target = join(dir, 'firmware.bin');
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target));
  return target;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) reject(new Error('body_too_large')); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, code, value) {
  if (res.headersSent || res.writableEnded) return;
  cors(res);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${HTTP_PORT}`);
  const path = url.pathname;
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  try {
    if (path === '/' || path === '/index.html') {
      cors(res);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(new URL('./index.html', import.meta.url)));
      return;
    }
    if (path === '/api/health') return json(res, 200, { ok: true, python: existsSync(PYTHON), pythonPath: PYTHON });
    if (path === '/api/fscheck') {
      const p = url.searchParams.get('path') ?? '';
      return json(res, 200, { path: p, exists: existsSync(p), cwd: process.cwd(), platform: process.platform });
    }
    if (path === '/api/ports') return json(res, 200, { ports: await listPorts(), sessions: [...sessions.values()].map(statusOf) });
    if (path === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await openPort(String(body.path), Number(body.baud ?? 115200)));
    }
    if (path === '/api/close' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await closePort(String(body.path)));
    }
    if (path === '/api/write' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await writePort(String(body.path), String(body.text ?? '')));
    }
    if (path === '/api/reset' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await resetPort(String(body.path)));
    }
    if (path === '/api/flash' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, await flash(body));
    }
    if (path === '/api/logs') {
      const portPath = url.searchParams.get('path') ?? '';
      const limit = Math.min(600, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
      const session = sessions.get(portPath);
      return json(res, 200, { path: portPath, lines: (session?.lines ?? []).slice(-limit) });
    }
    if (path === '/api/stream') {
      const portPath = url.searchParams.get('path');
      if (!portPath) return json(res, 400, { error: 'path_required' });
      cors(res);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`retry: 1500\n\n`);
      const session = sessions.get(portPath);
      if (session) {
        res.write(`event: status\ndata: ${JSON.stringify(statusOf(session))}\n\n`);
        for (const line of session.lines.slice(-200)) {
          res.write(`data: ${JSON.stringify({ line, ts: Date.now() })}\n\n`);
        }
      } else {
        res.write(`event: status\ndata: ${JSON.stringify({ path: portPath, open: false })}\n\n`);
      }
      if (!sseClients.has(portPath)) sseClients.set(portPath, new Set());
      sseClients.get(portPath).add(res);
      req.on('close', () => {
        sseClients.get(portPath)?.delete(res);
      });
      return;
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    if (res.headersSent) {
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

// Монитор порта не должен ронять весь bridge из-за обрыва SSE-клиента.
process.on('uncaughtException', (error) => {
  console.error('[kinto-bridge] uncaught', error);
});
process.on('unhandledRejection', (error) => {
  console.error('[kinto-bridge] rejection', error);
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[kinto-bridge] http://127.0.0.1:${HTTP_PORT} python=${PYTHON}`);
});
