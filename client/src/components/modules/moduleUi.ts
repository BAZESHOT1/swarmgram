/** Общие константы и подписи экрана модулей. */

export const MESH_ALWAYS = {
  /** Глобальная сеть едина для всех модулей; UI только показывает параметры. */
  networkLine: 'Сеть SG-MESH · канал 11 · 869.525 МГц · SF9 / BW125 · hops 14/12',
  publicIdLength: 8,
} as const;

export function moduleRoleLabel(role: string | undefined | null): string {
  switch (role) {
    case 'repeater':
      return 'Ретранслятор';
    case 'wearable':
      return 'Носимый';
    case 'gateway':
      return 'Шлюз';
    default:
      return 'Шлюз';
  }
}

export function moduleTransportLabel(transport: string | undefined | null): string {
  switch (transport) {
    case 'lora':
      return 'LoRa';
    case 'ble':
      return 'BLE';
    case 'usb':
      return 'USB';
    default:
      return 'Wi-Fi';
  }
}

/** Среда работы модуля: Wi-Fi, LoRa или оба канала. */
export function moduleEnvironmentLabel(kind: string | undefined | null, transport?: string | null): string {
  const value = `${kind ?? ''} ${transport ?? ''}`.toLowerCase();
  if (value.includes('lora')) return 'Wi-Fi + LoRa';
  if (value.includes('ble')) return 'BLE';
  if (value.includes('usb')) return 'USB';
  return 'Wi-Fi';
}

export type ModuleStatusText = 'онлайн' | 'офлайн' | 'заблокирован' | 'отвязан';
export type ModuleStatusTone = 'success' | 'neutral' | 'danger' | 'warning';

/** Единый статус карточки и узла карты: блокировка важнее online. */
export function moduleStatusView(module: {
  blocked?: boolean;
  status?: string;
  online?: boolean;
}): { text: ModuleStatusText; tone: ModuleStatusTone } {
  if (module.blocked || module.status === 'blocked') return { text: 'заблокирован', tone: 'danger' };
  if (module.status === 'detached') return { text: 'отвязан', tone: 'warning' };
  if (module.online === true) return { text: 'онлайн', tone: 'success' };
  return { text: 'офлайн', tone: 'neutral' };
}

/**
 * Хопы до шлюза: показываем только если сервер реально прислал число.
 * Ничего не додумываем — иначе карта и карточки начнут врать.
 */
export function moduleHops(module: object): number | null {
  const raw = module as Record<string, unknown>;
  for (const key of ['hops', 'hopCount', 'hopsToGateway', 'hops_to_gateway']) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
  }
  return null;
}

/** Оценка качества связи из RSSI (0…100), только для реальных значений. */
export function qualityFromRssi(rssi: number | undefined | null): number | null {
  const value = Number(rssi);
  if (!Number.isFinite(value) || value === 0) return null;
  return Math.max(0, Math.min(100, Math.round(2 * (value + 100))));
}

