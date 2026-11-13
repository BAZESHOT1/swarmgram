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

void kinto_mesh_addr_from_u32(uint32_t id, uint8_t out[KINTO_MESH_ADDR_LEN]) {
  if (!out) return;
  out[0] = (uint8_t)((id >> 24) & 0xFF);
  out[1] = (uint8_t)((id >> 16) & 0xFF);
  out[2] = (uint8_t)((id >> 8) & 0xFF);
  out[3] = (uint8_t)(id & 0xFF);
  /* Суффикс отделяет адрес от простого 32-битного id и заполняет 8 байт. */
  char tmp[11];
  tmp[0] = (char)((id >> 24) & 0xFF);
  tmp[1] = (char)((id >> 16) & 0xFF);
  tmp[2] = (char)((id >> 8) & 0xFF);
  tmp[3] = (char)(id & 0xFF);
  tmp[4] = '|';
  tmp[5] = 'm';
  tmp[6] = 'e';
  tmp[7] = 's';
  tmp[8] = 'h';
  tmp[9] = '2';
  tmp[10] = 0;
  uint32_t h = kinto_fnv1a32(tmp, 10);
  out[4] = (uint8_t)((h >> 24) & 0xFF);
  out[5] = (uint8_t)((h >> 16) & 0xFF);
  out[6] = (uint8_t)((h >> 8) & 0xFF);
  out[7] = (uint8_t)(h & 0xFF);
}

void kinto_mesh_addr_from_string(const char *text, uint8_t out[KINTO_MESH_ADDR_LEN]) {
  if (!out) return;
  if (!text || !*text) {
    for (unsigned i = 0; i < KINTO_MESH_ADDR_LEN; i++) out[i] = 0;
    return;
  }
  uint32_t a = kinto_fnv1a32(text, (unsigned)strlen(text));
  char tmp[256];
  unsigned n = 0;
  while (text[n] && n < sizeof(tmp) - 6) {
    tmp[n] = text[n];
    n++;
  }
  tmp[n++] = '|';
  tmp[n++] = 'a';
  tmp[n++] = 'd';
  tmp[n++] = 'd';
  tmp[n++] = 'r';
  tmp[n] = 0;
  uint32_t b = kinto_fnv1a32(tmp, n);
  for (unsigned i = 0; i < 4; i++) out[i] = (uint8_t)((a >> (24 - i * 8)) & 0xFF);
  for (unsigned i = 0; i < 4; i++) out[4 + i] = (uint8_t)((b >> (24 - i * 8)) & 0xFF);
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

/** CRC32 (IEEE 802.3), как в требовании: CRC32(sorted(anchor MACs)). */
static uint32_t crc32_bytes(const uint8_t *data, unsigned len, uint32_t crc) {
  crc = ~crc;
  for (unsigned i = 0; i < len; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++) {
      crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t)(-(int32_t)(crc & 1)));
    }
  }
  return ~crc;
}

uint32_t kinto_compute_cluster_id(const char *const *anchors, unsigned count) {
  if (!anchors || count == 0) return 0;
  const char *sorted[32];
  if (count > 32) count = 32;
  for (unsigned i = 0; i < count; i++) sorted[i] = anchors[i];
  sort_anchors(sorted, count);
  uint32_t crc = 0;
  for (unsigned i = 0; i < count; i++) {
    const char *p = sorted[i];
    if (!p) continue;
    if (i > 0) {
      const uint8_t sep = '|';
      crc = crc32_bytes(&sep, 1, crc);
    }
    crc = crc32_bytes((const uint8_t *)p, (unsigned)strlen(p), crc);
  }
  return crc;
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
  for (unsigned i = 0; i < count; i++) {
    const kinto_cluster_neighbor_t *a = &neighbors[i];
    if (a->rssi < KINTO_BORDER_MIN_RSSI || a->queue_depth > KINTO_BORDER_MAX_QUEUE) continue;
    if (a->streaks < 3) continue;   // кандидат должен стабильно видеть эфир
    if (now_ms - a->last_seen_ms > 12000u) continue;
    for (unsigned j = i + 1; j < count; j++) {
      const kinto_cluster_neighbor_t *b = &neighbors[j];
      if (b->cluster_id == a->cluster_id) continue;
      if (b->rssi < KINTO_BORDER_MIN_RSSI || b->queue_depth > KINTO_BORDER_MAX_QUEUE) continue;
      if (b->streaks < 3) continue;
      if (now_ms - b->last_seen_ms > 12000u) continue;
      const int rssi = a->rssi < b->rssi ? a->rssi : b->rssi;
      const int queue = a->queue_depth > b->queue_depth ? a->queue_depth : b->queue_depth;
      // score = min(rssi_A, rssi_B) - queue_depth * 4
      const int16_t score = (int16_t)(rssi - queue * 4);
      bool duplicate = false;
      for (unsigned k = 0; k < found; k++) {
        if (memcmp(out[k].mesh_addr, a->mesh_addr, KINTO_MESH_ADDR_LEN) == 0) duplicate = true;
      }
      if (duplicate) continue;
      // Держим до двух кандидатов, отсортированных по score (лучший первым).
      unsigned pos = found;
      while (pos > 0 && score > out[pos - 1].score) pos--;
      if (pos >= KINTO_BORDER_MAX) continue;
      for (unsigned k = (found < KINTO_BORDER_MAX ? found : KINTO_BORDER_MAX - 1); k > pos; k--) {
        out[k] = out[k - 1];
      }
      memcpy(out[pos].mesh_addr, a->mesh_addr, KINTO_MESH_ADDR_LEN);
      out[pos].cluster_a = a->cluster_id;
      out[pos].cluster_b = b->cluster_id;
      out[pos].score = score;
      if (found < KINTO_BORDER_MAX) found++;
      break;   // для узла a достаточно лучшей пары b
    }
  }
  for (unsigned k = 0; k < found; k++) out[k].primary = (k == 0);
  return found;
}
