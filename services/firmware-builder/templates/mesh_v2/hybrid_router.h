#ifndef KINTO_HYBRID_ROUTER_H
#define KINTO_HYBRID_ROUTER_H

#include <stdint.h>
#include <stdbool.h>
#include "beacon_format.h"

#define KINTO_ROUTE_MAX 64
#define KINTO_DUP_RING 256
#define KINTO_ROUTE_EXPIRY_MS 45000
#define KINTO_WIFI_PREFERRED 120
#define KINTO_LORA_PREFERRED 400
#define KINTO_TTL_WIFI 16
#define KINTO_TTL_LORA 8

typedef enum { KINTO_IFACE_NONE = 0, KINTO_IFACE_WIFI = 1, KINTO_IFACE_LORA = 2 } kinto_iface_t;
typedef enum { KINTO_ROUTE_NONE = 0, KINTO_ROUTE_WIFI = 1, KINTO_ROUTE_LORA = 2 } kinto_route_t;
typedef enum { KINTO_TRAFFIC_TEXT = 0, KINTO_TRAFFIC_MEDIA, KINTO_TRAFFIC_OTA, KINTO_TRAFFIC_TELEMETRY, KINTO_TRAFFIC_SEARCH } kinto_traffic_t;

typedef struct {
  uint8_t dst[KINTO_MESH_ADDR_LEN];
  uint8_t next_hop[KINTO_MESH_ADDR_LEN];
  kinto_iface_t iface;
  uint16_t ewma_ms;
  uint8_t hops;
  uint8_t queue_depth;
  uint32_t expiry_ms;
  bool valid;
} kinto_route_t;

void kinto_router_init(void);
bool kinto_route_upsert(const kinto_route_t *route);
void kinto_route_remove(const uint8_t dst[KINTO_MESH_ADDR_LEN]);
uint16_t kinto_route_metric(const kinto_route_t *route);

/* select_route: учитывает класс трафика, метрику и очередь. */
kinto_route_t kinto_select_route(const uint8_t dst[KINTO_MESH_ADDR_LEN], kinto_traffic_t traffic, uint32_t now_ms);

/* TTL: Wi-Fi → LoRa уменьшает вдвое. */
uint8_t kinto_ttl_for_iface(kinto_iface_t iface, uint8_t incoming_ttl);

/* duplicate detection по (src, seq). */
bool kinto_is_duplicate(const uint8_t src[KINTO_MESH_ADDR_LEN], uint32_t seq, uint32_t now_ms);

#endif
