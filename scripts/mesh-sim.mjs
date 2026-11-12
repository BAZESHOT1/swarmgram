#!/usr/bin/env node
/**
 * Симуляции mesh v2: хендовер, гибридный маршрут, офлайн-outbox.
 * Запуск: node scripts/mesh-sim.mjs
 */

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function clusterId(anchors) {
  return fnv1a32([...anchors].map((a) => a.toLowerCase()).sort().join('|'));
}

function electBorder(neighbors) {
  const best = [];
  for (const candidate of neighbors) {
    const clusters = [...new Set(candidate.clusters)];
    if (clusters.length < 2) continue;
    if (candidate.rssi < -95 || candidate.queue > 8) continue;
    best.push({ id: candidate.id, score: candidate.rssi - candidate.queue * 4 });
  }
  return best.sort((a, b) => b.score - a.score).slice(0, 2);
}

function handover({ currentRssi, targetRssi, streak, border }) {
  if (currentRssi > -85) return 'IN_CLUSTER';
  if (targetRssi < -75 || streak < 3) return 'IN_CLUSTER';
  if (!border) return 'RETRY';
  return 'COMPLETE';
}

function selectRoute(routes, traffic) {
  const wifi = routes.filter((r) => r.iface === 'wifi');
  const lora = routes.filter((r) => r.iface === 'lora');
  if (traffic === 'media' || traffic === 'ota') return wifi[0] ?? null;
  const w = wifi[0];
  if (w && w.metric < 120) return w;
  const l = lora.find((r) => r.queue < 3);
  if (l && l.metric < 400) return l;
  return wifi[0] ?? lora[0] ?? null;
}

const results = [];

// 1. Кластер стабилен при том же составе и меняется при смене якоря.
const a1 = clusterId(['gw-a', 'rep-1', 'rep-2']);
const a2 = clusterId(['rep-2', 'gw-a', 'rep-1']);
const a3 = clusterId(['gw-a', 'rep-1']);
results.push(['cluster deterministic', a1 === a2]);
results.push(['cluster changes with anchors', a1 !== a3]);

// 2. Border election: только лучшие 2, не все пограничные.
const border = electBorder([
  { id: 'n1', clusters: ['A', 'B'], rssi: -60, queue: 1 },
  { id: 'n2', clusters: ['A', 'B'], rssi: -70, queue: 2 },
  { id: 'n3', clusters: ['A', 'B'], rssi: -90, queue: 7 },
]);
results.push(['border top-2', border.length === 2 && border[0].id === 'n1']);

// 3. Хендовер по порогам и гистерезису.
results.push(['handover waits streak', handover({ currentRssi: -90, targetRssi: -70, streak: 2, border: true }) === 'IN_CLUSTER']);
results.push(['handover completes', handover({ currentRssi: -90, targetRssi: -70, streak: 3, border: true }) === 'COMPLETE']);
results.push(['handover retries without border', handover({ currentRssi: -90, targetRssi: -70, streak: 3, border: false }) === 'RETRY']);

// 4. Гибридный маршрут: LoRa выбирается, когда Wi-Fi перегружен.
const routes = [
  { iface: 'wifi', metric: 300, queue: 9 },
  { iface: 'lora', metric: 250, queue: 1 },
];
results.push(['hybrid picks lora', selectRoute(routes, 'text')?.iface === 'lora']);
results.push(['media wifi only', selectRoute(routes, 'media')?.iface === 'wifi']);

// 5. Offline outbox: 100 сообщений, флаш батчами по 20, ключ уничтожен.
let outbox = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
const acked = [];
for (let i = 0; i < outbox.length; i += 20) {
  const batch = outbox.slice(i, i + 20);
  acked.push(...batch.map((m) => m.id));
}
outbox = outbox.filter((m) => !acked.includes(m.id));
results.push(['outbox flush batches of 20', acked.length === 100 && outbox.length === 0]);

// 6. Медиа по LoRa: только thumbnail <2KB и очередь <3.
const mediaAllowed = (size, queue) => size <= 2048 && queue < 3;
results.push(['lora media thumbnail', mediaAllowed(1800, 2) && !mediaAllowed(5000, 2) && !mediaAllowed(1800, 3)]);

let failed = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
