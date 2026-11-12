/**
 * MeshIdentityService — единая точка идентичности модуля в приложении.
 *
 * Основной идентификатор — Wi-Fi STA MAC (hardwareId вида esp32-xxxxxxxxxxxx).
 * BLE MAC — только алиас. Сервер и прошивка используют ту же каноническую
 * форму, поэтому повторное BLE-подключение не создаёт новый модуль.
 */
import { kv } from '../crypto/storage';
import type { ModuleInfo } from '../modules/types';

export interface MeshIdentity {
  /** esp32-<12 hex> — канонический ID. */
  hardwareId: string;
  /** Тот же MAC в виде aa:bb:cc:dd:ee:ff. */
  meshAddr: string;
  /** BLE MAC-алиас (может отличаться от Wi-Fi MAC). */
  bleMac?: string;
  publicId?: string;
}

const STORAGE_KEY = 'sg:mesh:identity';
const CACHE = new Map<string, MeshIdentity>();

/** Приводит любой MAC/hardwareId к канону esp32-<12 hex>. */
export function canonicalHardwareId(value?: string | null): string | null {
  if (!value) return null;
  const hex = value.toLowerCase().replace(/^esp32-/, '').replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return `esp32-${hex}`;
}

export function meshAddrOf(hardwareId: string): string {
  const hex = hardwareId.replace(/^esp32-/, '').toLowerCase();
  return hex.match(/.{2}/g)?.join(':') ?? hardwareId;
}

export function bleMacFromDeviceId(deviceId?: string | null): string | undefined {
  if (!deviceId) return undefined;
  // iOS отдаёт UUID, Android — MAC. Берём только явный MAC.
  const match = deviceId.match(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
  return match ? match[0].toLowerCase() : undefined;
}

/** Регистрирует идентичность, полученную из INFO модуля по BLE/USB. */
export async function rememberIdentity(
  info: Pick<ModuleInfo, 'hardwareId' | 'publicId' | 'bleMac'>,
  deviceId?: string | null,
): Promise<MeshIdentity | null> {
  const hardwareId = canonicalHardwareId(info.hardwareId);
  if (!hardwareId) return null;
  const identity: MeshIdentity = {
    hardwareId,
    meshAddr: meshAddrOf(hardwareId),
    bleMac: info.bleMac ?? bleMacFromDeviceId(deviceId),
    publicId: info.publicId,
  };
  CACHE.set(hardwareId, identity);
  const stored = (await getStoredIdentities()).filter((item) => item.hardwareId !== hardwareId);
  stored.unshift(identity);
  await kv.set(STORAGE_KEY, JSON.stringify(stored.slice(0, 50)));
  return identity;
}

export function getIdentity(hardwareId?: string | null): MeshIdentity | null {
  const canonical = canonicalHardwareId(hardwareId);
  return canonical ? CACHE.get(canonical) ?? null : null;
}

export async function getStoredIdentities(): Promise<MeshIdentity[]> {
  try {
    const raw = await kv.get(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as MeshIdentity[]) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => canonicalHardwareId(item.hardwareId)) : [];
  } catch {
    return [];
  }
}

/** Отображаемый ID: MAC, а не выдуманный номер. */
export function displayMeshId(hardwareId?: string | null): string {
  const canonical = canonicalHardwareId(hardwareId);
  return canonical ? meshAddrOf(canonical) : '—';
}
