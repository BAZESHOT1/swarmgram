/**
 * Оффлайн-идентичность модуля по BLE-имени KL-<USER8>-<MOD6>.
 *
 * USER8 — первые 4 байта users.id (UUID) в hex, MOD6 — последние 3 байта MAC.
 */
export interface ParsedModuleName {
  ownerPrefix: string;
  mod6: string;
}

export type ModuleOwnership = 'own' | 'free' | 'foreign' | 'unknown';

export function parseModuleBleName(name: string | null | undefined): ParsedModuleName | null {
  const text = String(name ?? '').trim();
  const match = /^KL-([0-9a-fA-F]{8})-([0-9a-fA-F]{6})$/.exec(text);
  if (!match) return null;
  return { ownerPrefix: match[1].toLowerCase(), mod6: match[2].toLowerCase() };
}

export function moduleBleName(ownerPrefix: string, mod6: string): string {
  return `KL-${ownerPrefix.toLowerCase()}-${mod6.toLowerCase()}`;
}

export function classifyModuleName(
  name: string | null | undefined,
  myPrefix: string | null | undefined,
): ModuleOwnership {
  const parsed = parseModuleBleName(name);
  if (!parsed) return 'unknown';
  if (parsed.ownerPrefix === '00000000') return 'free';
  if (myPrefix && parsed.ownerPrefix === myPrefix.toLowerCase()) return 'own';
  return 'foreign';
}

/** Свободный ли модуль (KL-00000000-<MOD6>). */
export function isFreeModuleName(name: string | null | undefined): boolean {
  return classifyModuleName(name, null) === 'free';
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out: number[] = [];
  for (let i = 0; i < withPad.length; i += 4) {
    const n1 = alphabet.indexOf(withPad[i]);
    const n2 = alphabet.indexOf(withPad[i + 1]);
    const n3 = withPad[i + 2] === '=' ? -1 : alphabet.indexOf(withPad[i + 2]);
    const n4 = withPad[i + 3] === '=' ? -1 : alphabet.indexOf(withPad[i + 3]);
    if (n1 < 0 || n2 < 0) break;
    const triple = (n1 << 18) | (n2 << 12) | ((n3 < 0 ? 0 : n3) << 6) | (n4 < 0 ? 0 : n4);
    out.push((triple >> 16) & 0xff);
    if (n3 >= 0) out.push((triple >> 8) & 0xff);
    if (n4 >= 0) out.push(triple & 0xff);
  }
  return new Uint8Array(out);
}

/** Разобрать claim_token от Hub в поля для BRIDGE_CMD_SET_OWNER. */
export function decodeOwnerClaimToken(token: string): {
  prefix: string;
  netId: number;
  epoch: number;
  signature: string;
} | null {
  try {
    const json = new TextDecoder().decode(decodeBase64Url(token));
    const value = JSON.parse(json) as Record<string, unknown>;
    const prefix = String(value.prefix ?? '').toLowerCase();
    const signature = String(value.signature ?? '').toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(prefix) || !/^[0-9a-f]+$/.test(signature)) return null;
    return {
      prefix,
      netId: Number(value.netId) >>> 0,
      epoch: Number(value.epoch) >>> 0,
      signature,
    };
  } catch {
    return null;
  }
}
