/**
 * KMesh_v1 OTA: генератор дельта-патчей и подпись манифестов.
 *
 * Формат патча KLDP1 совпадает с firmware/klinto_core/klinto_ota_patcher:
 *   "KLDP" | ver u8 | base_size u32 | target_size u32 | target_sha256[32]
 *   COPY {offset u32, length u32} | ADD {length u16, bytes} | END
 *
 * Чанкинг контентно-зависимый (gear hash): изменение кода не сдвигает
 * границы всех блоков, поэтому патч остаётся компактным.
 */
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';

const PATCH_MAGIC = Buffer.from('KLDP', 'ascii');
const PATCH_VERSION = 1;
const HEADER_SIZE = 45;
const CHUNK_MIN = 256;
const CHUNK_MAX = 8192;
const CHUNK_MASK = 1023; // средний размер ~1 КБ
const ADD_MAX = 4096;

export interface DeltaPatch {
  patch: Buffer;
  patchSha256: string;
  targetSha256: string;
  baseSize: number;
  targetSize: number;
}

export interface OtaManifest {
  chip: string;
  baseBuild: number;
  targetBuild: number;
  version: string;
  totalChunks: number;
  patchSize: number;
  patchSha256: string;
  targetSha256: string;
  signature: string;
  sigAlg: string;
}

function gearTable(): Uint32Array {
  const table = new Uint32Array(256);
  let x = 0x12345678;
  for (let i = 0; i < 256; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    table[i] = x;
  }
  return table;
}

const GEAR = gearTable();

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface Chunk {
  offset: number;
  length: number;
  key: string;
}

function splitChunks(buf: Buffer): Chunk[] {
  const out: Chunk[] = [];
  let start = 0;
  let hash = 0;
  for (let i = 0; i < buf.length; i += 1) {
    hash = ((hash << 1) + GEAR[buf[i]]) >>> 0;
    const len = i - start + 1;
    const atBoundary = len >= CHUNK_MIN && (hash & CHUNK_MASK) === 0;
    if (atBoundary || len >= CHUNK_MAX || i === buf.length - 1) {
      const slice = buf.subarray(start, i + 1);
      const key = `${len}:${createHash('sha256').update(slice).digest('hex').slice(0, 24)}`;
      out.push({ offset: start, length: len, key });
      start = i + 1;
      hash = 0;
    }
  }
  return out;
}

function u16(value: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(value & 0xffff, 0);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

/** Построить KLDP1-патч base -> target. */
export function buildDeltaPatch(base: Buffer, target: Buffer): DeltaPatch {
  const targetSha = sha256Hex(target);
  const baseChunks = splitChunks(base);
  const index = new Map<string, Chunk>();
  for (const chunk of baseChunks) {
    if (!index.has(chunk.key)) index.set(chunk.key, chunk);
  }
  const ops: Buffer[] = [];
  let pending: Buffer[] = [];
  let pendingLen = 0;

  const flushAdd = () => {
    if (!pendingLen) return;
    const data = Buffer.concat(pending, pendingLen);
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(ADD_MAX, data.length - offset);
      ops.push(Buffer.from([0x02]), u16(take), data.subarray(offset, offset + take));
      offset += take;
    }
    pending = [];
    pendingLen = 0;
  };

  for (const chunk of splitChunks(target)) {
    const match = index.get(chunk.key);
    if (match && match.length === chunk.length) {
      flushAdd();
      ops.push(Buffer.from([0x01]), u32(match.offset), u32(chunk.length));
    } else {
      pending.push(target.subarray(chunk.offset, chunk.offset + chunk.length));
      pendingLen += chunk.length;
      if (pendingLen >= ADD_MAX) flushAdd();
    }
  }
  flushAdd();

  const header = Buffer.concat([
    PATCH_MAGIC,
    Buffer.from([PATCH_VERSION]),
    u32(base.length),
    u32(target.length),
    Buffer.from(targetSha, 'hex'),
  ]);
  const patch = Buffer.concat([header, ...ops, Buffer.from([0x00])]);
  return {
    patch,
    patchSha256: sha256Hex(patch),
    targetSha256: targetSha,
    baseSize: base.length,
    targetSize: target.length,
  };
}

/** Канонический digest манифеста (совпадает с C-кодом прошивки). */
export function manifestCanonical(m: {
  chip: string;
  baseBuild: number;
  targetBuild: number;
  totalChunks: number;
  patchSize: number;
  patchSha256: string;
  targetSha256: string;
}): string {
  const chipId = { esp32: 1, esp32c3: 2, esp32s3: 3, esp32c6: 4 }[m.chip] || 0;
  return `KLINTO-OTA1|${chipId}|${m.baseBuild}|${m.targetBuild}|${m.patchSha256}|${m.targetSha256}|${m.totalChunks}|${m.patchSize}`;
}

/** Канонический digest манифеста (совпадает с C-кодом прошивки). */
export function manifestDigest(m: {
  chip: string;
  baseBuild: number;
  targetBuild: number;
  totalChunks: number;
  patchSize: number;
  patchSha256: string;
  targetSha256: string;
}): string {
  return createHash('sha256').update(manifestCanonical(m), 'utf8').digest('hex');
}

function signingKey(): KeyObject | null {
  const raw = String(process.env.OTA_SIGNING_KEY || '').trim();
  if (!raw) return null;
  try {
    const pem = raw.includes('BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8');
    return createPrivateKey(pem);
  } catch {
    return null;
  }
}

/** Подписать манифест ECDSA P-256 (DER, hex). */
export function signManifest(m: OtaManifest): string {
  const key = signingKey();
  if (!key) return '';
  return sign('sha256', Buffer.from(manifestCanonical(m), 'utf8'), {
    key,
    dsaEncoding: 'der',
  }).toString('hex');
}

export function otaSigningAvailable(): boolean {
  return signingKey() !== null;
}
