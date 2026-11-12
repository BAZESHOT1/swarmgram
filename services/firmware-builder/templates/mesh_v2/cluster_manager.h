#ifndef KINTO_CLUSTER_MANAGER_H
#define KINTO_CLUSTER_MANAGER_H

#include <stdint.h>
#include <stdbool.h>
#include "beacon_format.h"

#define KINTO_BORDER_MIN_RSSI (-95)
#define KINTO_BORDER_MAX_QUEUE 8
#define KINTO_BORDER_MAX 2

typedef struct {
  uint8_t mesh_addr[KINTO_MESH_ADDR_LEN];
  uint32_t cluster_id;
  int8_t rssi;
  uint8_t queue_depth;
  uint8_t streaks; /* сколько beacon-интервалов подряд видим */
  uint32_t last_seen_ms;
} kinto_cluster_neighbor_t;

typedef struct {
  uint8_t mesh_addr[KINTO_MESH_ADDR_LEN];
  uint32_t cluster_a;
  uint32_t cluster_b;
  int16_t score;
  bool primary;
} kinto_border_candidate_t;

uint32_t kinto_fnv1a32(const char *data, unsigned len);

/* 8-байтовый mesh-адрес из 32-битного nodeId (big-endian + hash-суффикс). */
void kinto_mesh_addr_from_u32(uint32_t id, uint8_t out[KINTO_MESH_ADDR_LEN]);

/* 8-байтовый mesh-адрес из hardwareId/publicId строки. */
void kinto_mesh_addr_from_string(const char *text, uint8_t out[KINTO_MESH_ADDR_LEN]);

/* Cluster ID = FNV1a32(sorted(anchor ids), '|' separator). */
uint32_t kinto_compute_cluster_id(const char *const *anchors, unsigned count);

/* Выбор до 2 Border Node между всеми видимыми кластерами. */
unsigned kinto_elect_border_nodes(
    const kinto_cluster_neighbor_t *neighbors,
    unsigned count,
    uint32_t now_ms,
    kinto_border_candidate_t out[KINTO_BORDER_MAX]);

/* true — пакет видит оба кластера и подходит на роль моста. */
bool kinto_is_border_candidate(const kinto_cluster_neighbor_t *neighbors, unsigned count);

#endif
