/** Классификатор трафика для гибридного роутинга (зеркало прошивки). */

export type TrafficClass = 'text' | 'telemetry' | 'telemetry_request' | 'search' | 'media' | 'ota';
export type MeshInterface = 'wifi' | 'lora';

export interface TrafficDecision {
  priority: 'high' | 'medium' | 'low';
  preferred: MeshInterface[];
  allowLora: boolean;
  maxLoraBytes: number;
  compression: 'none' | 'binary' | 'protobuf' | 'webp';
}

export const TRAFFIC_POLICY: Record<TrafficClass, TrafficDecision> = {
  text: { priority: 'high', preferred: ['wifi', 'lora'], allowLora: true, maxLoraBytes: Infinity, compression: 'protobuf' },
  telemetry: { priority: 'low', preferred: ['lora'], allowLora: true, maxLoraBytes: 512, compression: 'binary' },
  telemetry_request: { priority: 'medium', preferred: ['wifi', 'lora'], allowLora: true, maxLoraBytes: 512, compression: 'none' },
  search: { priority: 'medium', preferred: ['wifi', 'lora'], allowLora: true, maxLoraBytes: 1024, compression: 'none' },
  media: { priority: 'low', preferred: ['wifi'], allowLora: true, maxLoraBytes: 2048, compression: 'webp' },
  ota: { priority: 'low', preferred: ['wifi'], allowLora: false, maxLoraBytes: 0, compression: 'none' },
};

export function classifyTraffic(kind: string, sizeBytes = 0): TrafficClass {
  const k = kind.toLowerCase();
  if (k === 'ota') return 'ota';
  if (k === 'telemetry') return 'telemetry';
  if (k === 'telemetry_request') return 'telemetry_request';
  if (k === 'search') return 'search';
  if (k.startsWith('media') || k === 'image' || k === 'video' || k === 'file') return 'media';
  return 'text';
}

/**
 * true — можно отправить по LoRa с учётом размера и очереди.
 * Медиа разрешено только как thumbnail ≤2 КБ при queueDepth < 3.
 */
export function canUseLora(kind: string, sizeBytes: number, loraQueueDepth: number): boolean {
  const traffic = classifyTraffic(kind, sizeBytes);
  const policy = TRAFFIC_POLICY[traffic];
  if (!policy.allowLora) return false;
  if (traffic === 'media') return sizeBytes <= policy.maxLoraBytes && loraQueueDepth < 3;
  return sizeBytes <= policy.maxLoraBytes;
}

export function dropReason(kind: string, sizeBytes: number, loraQueueDepth: number): string | null {
  if (canUseLora(kind, sizeBytes, loraQueueDepth)) return null;
  return classifyTraffic(kind) === 'media'
    ? 'media_dropped_due_to_lora_congestion'
    : 'lora_unavailable_for_traffic';
}
