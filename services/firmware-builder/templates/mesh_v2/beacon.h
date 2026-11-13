/**
 * beacon.c/h — расширенный beacon mesh-сети.
 *
 * Поля: mesh_addr (MAC), cluster_id, is_anchor, is_border, neighbor_clusters,
 * hues, load. Формат JSON, обратная совместимость сохраняется.
 */
#ifndef KINTO_BEACON_H
#define KINTO_BEACON_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define KINTO_BEACON_MAX_HUES 4
#define KINTO_BEACON_MAX_NEIGHBOR_CLUSTERS 2

typedef struct {
  char mesh_addr[18];       /* aa:bb:cc:dd:ee:ff */
  char hardware_id[19];     /* esp32-xxxxxxxxxxxx */
  uint32_t cluster_id;
  bool is_anchor;
  bool is_border;
  uint8_t hues_mask;        /* bit0 wifi, bit1 lora, bit2 ble */
  float load;               /* 0.0 .. 1.0 */
  uint32_t neighbor_clusters[KINTO_BEACON_MAX_NEIGHBOR_CLUSTERS];
  uint8_t neighbor_cluster_count;
} klinto_beacon_t;

/** Заполняет структуру значениями по умолчанию. */
void klinto_beacon_init(klinto_beacon_t *b, const char *hardware_id, const char *mesh_addr);

/** Сериализует beacon в JSON. Возвращает длину или 0 при нехватке буфера. */
unsigned klinto_beacon_to_json(const klinto_beacon_t *b, char *out, unsigned cap);

/** Разбирает JSON beacon (только нужные поля, неизвестные игнорируются). */
bool klinto_beacon_from_json(const char *json, klinto_beacon_t *out);

#ifdef __cplusplus
}
#endif

#endif /* KINTO_BEACON_H */
