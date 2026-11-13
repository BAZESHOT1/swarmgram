#include "telemetry.h"

#include <stdio.h>
#include <string.h>

void klinto_telemetry_init(klinto_telemetry_t *t, const char *mesh_addr) {
  if (!t) return;
  memset(t, 0, sizeof(*t));
  if (mesh_addr) snprintf(t->mesh_addr, sizeof(t->mesh_addr), "%s", mesh_addr);
}

void klinto_telemetry_neighbor(klinto_telemetry_t *t, int16_t rssi) {
  if (!t || t->neighbors_count >= KINTO_TELEMETRY_MAX_NEIGHBORS) return;
  t->neighbor_rssi[t->neighbors_count++] = rssi;
}

static int avg_rssi(const klinto_telemetry_t *t) {
  if (!t->neighbors_count) return 0;
  int sum = 0;
  for (uint8_t i = 0; i < t->neighbors_count; i++) sum += t->neighbor_rssi[i];
  return sum / t->neighbors_count;
}

unsigned klinto_telemetry_to_json(const klinto_telemetry_t *t, char *out, unsigned cap) {
  if (!t || !out || !cap) return 0;
  int n = snprintf(
      out, cap,
      "{\"meshAddr\":\"%s\",\"clusterId\":%lu,\"border\":%d,"
      "\"neighbors\":%u,\"avgRssi\":%d,\"routes\":%u,"
      "\"outboxDepth\":%u,\"hues\":%s%s%s,\"uptime\":%lu}",
      t->mesh_addr, (unsigned long)t->cluster_id, t->border ? 1 : 0,
      (unsigned)t->neighbors_count, avg_rssi(t), (unsigned)t->routes_count,
      (unsigned)t->outbox_depth,
      (t->hue_mask & 1) ? "\"wifi\"" : "",
      (t->hue_mask & 2) ? ((t->hue_mask & 1) ? ",\"lora\"" : "\"lora\"") : "",
      (t->hue_mask & 4) ? (((t->hue_mask & 3) ? ",\"ble\"" : "\"ble\"")) : "",
      (unsigned long)t->uptime_s);
  return (n > 0 && (unsigned)n < cap) ? (unsigned)n : 0;
}
