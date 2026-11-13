#ifndef KINTO_BEACON_FORMAT_H
#define KINTO_BEACON_FORMAT_H

#include <stdint.h>
#include <stdbool.h>

#define KINTO_BEACON_VERSION 2
#define KINTO_MAX_NEIGHBOR_CLUSTERS 4
#define KINTO_BEACON_INTERVAL_MS 3000
#define KINTO_MESH_ADDR_LEN 8

typedef enum {
  KINTO_BEACON = 1,
  KINTO_HANDOVER_REQUEST = 16,
  KINTO_HANDOVER_ACCEPT = 17,
  KINTO_HANDOVER_COMPLETE = 18,
  KINTO_HANDOVER_RETRY = 19,
  KINTO_TELEMETRY_REQUEST = 32,
  KINTO_TELEMETRY_REPORT = 33,
  KINTO_OTA_ANNOUNCE = 48,
  KINTO_OTA_CHUNK_REQUEST = 49,
  KINTO_OTA_CHUNK = 50,
} klinto_packet_type_t;

typedef struct {
  uint8_t version;
  uint8_t type;
  uint8_t mesh_addr[KINTO_MESH_ADDR_LEN];
  uint32_t cluster_id;
  uint8_t border;
  uint32_t neighbor_clusters[KINTO_MAX_NEIGHBOR_CLUSTERS];
  uint8_t neighbor_cluster_count;
  int8_t rssi_hint;
  uint8_t queue_depth;
  uint8_t ttl;
  uint16_t flags;
  uint32_t seq;
} klinto_beacon_t;

enum {
  KINTO_FLAG_GATEWAY = 1 << 0,
  KINTO_FLAG_ANCHOR = 1 << 1,
  KINTO_FLAG_WEARABLE = 1 << 2,
  KINTO_FLAG_WIFI = 1 << 3,
  KINTO_FLAG_LORA = 1 << 4,
};

#endif
