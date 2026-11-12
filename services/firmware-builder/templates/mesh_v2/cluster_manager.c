#include "cluster_manager.h"

#include <string.h>

uint32_t kinto_fnv1a32(const char *data, unsigned len) {
  uint32_t hash = 0x811c9dc5u;
  for (unsigned i = 0; i < len; i++) {
    hash ^= (uint8_t)data[i];
    hash *= 0x01000193u;
  }
  return hash;
}

/* Простая сортировка вставками: якорей мало (14–16). */
static void sort_anchors(const char **anchors, unsigned count) {
  for (unsigned i = 1; i < count; i++) {
    const char *value = anchors[i];
    int j = (int)i - 1;
    while (j >= 0 && strcmp(anchors[j], value) > 0) {
      anchors[j + 1] = anchors[j];
      j--;
    }
    anchors[j + 1] = value;
  }
}

uint32_t kinto_compute_cluster_id(const char *const *anchors, unsigned count) {
  if (!anchors || count == 0) return 0;
  const char *sorted[32];
  if (count > 32) count = 32;
  for (unsigned i = 0; i < count; i++) sorted[i] = anchors[i];
  sort_anchors(sorted, count);
  uint32_t hash = 0x811c9dc5u;
  for (unsigned i = 0; i < count; i++) {
    if (i > 0) {
      hash ^= (uint8_t)'|';
      hash *= 0x01000193u;
    }
    const char *p = sorted[i];
    while (p && *p) {
      hash ^= (uint8_t)*p++;
      hash *= 0x01000193u;
    }
  }
  return hash;
}

bool kinto_is_border_candidate(const kinto_cluster_neighbor_t *neighbors, unsigned count) {
  if (!neighbors || count < 2) return false;
  uint32_t first = 0;
  int seen = 0;
  for (unsigned i = 0; i < count; i++) {
    if (neighbors[i].last_seen_ms == 0) continue;
    if (neighbors[i].rssi < KINTO_BORDER_MIN_RSSI) continue;
    if (neighbors[i].queue_depth > KINTO_BORDER_MAX_QUEUE) continue;
    if (seen == 0) {
      first = neighbors[i].cluster_id;
      seen = 1;
    } else if (neighbors[i].cluster_id != first) {
      return true;
    }
  }
  return false;
}

unsigned kinto_elect_border_nodes(
    const kinto_cluster_neighbor_t *neighbors,
    unsigned count,
    uint32_t now_ms,
    kinto_border_candidate_t out[KINTO_BORDER_MAX]) {
  unsigned found = 0;
  for (unsigned i = 0; i < count && found < KINTO_BORDER_MAX; i++) {
    const kinto_cluster_neighbor_t *a = &neighbors[i];
    if (a->rssi < KINTO_BORDER_MIN_RSSI || a->queue_depth > KINTO_BORDER_MAX_QUEUE) continue;
    if (now_ms - a->last_seen_ms > 12000u) continue;
    for (unsigned j = i + 1; j < count && found < KINTO_BORDER_MAX; j++) {
      const kinto_cluster_neighbor_t *b = &neighbors[j];
      if (b->cluster_id == a->cluster_id) continue;
      if (b->rssi < KINTO_BORDER_MIN_RSSI || b->queue_depth > KINTO_BORDER_MAX_QUEUE) continue;
      if (now_ms - b->last_seen_ms > 12000u) continue;
      int rssi = a->rssi < b->rssi ? a->rssi : b->rssi;
      int queue = a->queue_depth > b->queue_depth ? a->queue_depth : b->queue_depth;
      int16_t score = (int16_t)(rssi - queue * 4);
      bool duplicate = false;
      for (unsigned k = 0; k < found; k++) {
        if (memcmp(out[k].mesh_addr, a->mesh_addr, KINTO_MESH_ADDR_LEN) == 0) duplicate = true;
      }
      if (duplicate) continue;
      kinto_border_candidate_t *slot = &out[found];
      memcpy(slot->mesh_addr, a->mesh_addr, KINTO_MESH_ADDR_LEN);
      slot->cluster_a = a->cluster_id;
      slot->cluster_b = b->cluster_id;
      slot->score = score;
      slot->primary = (found == 0);
      found++;
    }
  }
  return found;
}
