/**
 * telemetry.c/h — снимок network_state модуля для Hub.
 *
 * current_cluster_id, neighbors, routes, outbox_depth, hues. Отправляется
 * шлюзу каждые 30 секунд; без шлюза сохраняется локально.
 */
#ifndef KINTO_TELEMETRY_H
#define KINTO_TELEMETRY_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define KINTO_TELEMETRY_MAX_NEIGHBORS 8

typedef struct {
  char mesh_addr[18];
  uint32_t cluster_id;
  bool border;
  uint8_t hue_mask;
  uint8_t neighbors_count;
  int16_t neighbor_rssi[KINTO_TELEMETRY_MAX_NEIGHBORS];
  uint8_t routes_count;
  uint16_t outbox_depth;
  uint32_t uptime_s;
} kinto_telemetry_t;

void kinto_telemetry_init(kinto_telemetry_t *t, const char *mesh_addr);
void kinto_telemetry_neighbor(kinto_telemetry_t *t, int16_t rssi);
unsigned kinto_telemetry_to_json(const kinto_telemetry_t *t, char *out, unsigned cap);

#ifdef __cplusplus
}
#endif

#endif /* KINTO_TELEMETRY_H */
