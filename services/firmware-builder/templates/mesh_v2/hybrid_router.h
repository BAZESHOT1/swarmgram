#ifndef KINTO_HYBRID_ROUTER_H
#define KINTO_HYBRID_ROUTER_H

#include <stdint.h>
#include <stdbool.h>
#include "beacon_format.h"

#ifdef __cplusplus
extern "C" {
#endif

#define KINTO_ROUTE_MAX 64
#define KINTO_DUP_RING 256
#define KINTO_ROUTE_EXPIRY_MS 45000
#define KINTO_ROUTE_EXPIRY_ESPNOW_MS 300000UL
#define KINTO_ROUTE_EXPIRY_LORA_MS 900000UL
#define KINTO_WIFI_PREFERRED 120
#define KINTO_ESPNOW_PREFERRED KINTO_WIFI_PREFERRED
#define KINTO_LORA_PREFERRED 400
#define KINTO_TTL_WIFI 16
#define KINTO_TTL_ESPNOW KINTO_TTL_WIFI
#define KINTO_TTL_LORA 8

/* ESP-NOW LR — основной интерфейс. WIFI оставлен алиасом для совместимости. */
typedef enum {
  KINTO_IFACE_NONE = 0,
  KINTO_IFACE_ESPNOW = 1,
  KINTO_IFACE_WIFI = KINTO_IFACE_ESPNOW,
  KINTO_IFACE_LORA = 2,
} klinto_iface_t;
typedef enum { KINTO_TRAFFIC_TEXT = 0, KINTO_TRAFFIC_MEDIA, KINTO_TRAFFIC_OTA, KINTO_TRAFFIC_TELEMETRY, KINTO_TRAFFIC_SEARCH } klinto_traffic_t;

typedef struct {
  uint8_t dst[KINTO_MESH_ADDR_LEN];
  uint8_t next_hop[KINTO_MESH_ADDR_LEN];
  klinto_iface_t iface;
  uint16_t ewma_ms;
  uint8_t hops;
  uint8_t queue_depth;
  uint32_t expiry_ms;
  bool valid;
} klinto_route_t;

void klinto_router_init(void);
bool klinto_route_upsert(const klinto_route_t *route);
void klinto_route_remove(const uint8_t dst[KINTO_MESH_ADDR_LEN]);
uint16_t klinto_route_metric(const klinto_route_t *route);

/* select_route: учитывает класс трафика, метрику и очередь. */
klinto_route_t klinto_select_route(const uint8_t dst[KINTO_MESH_ADDR_LEN], klinto_traffic_t traffic, uint32_t now_ms);

/* TTL: Wi-Fi → LoRa уменьшает вдвое. */
uint8_t klinto_ttl_for_iface(klinto_iface_t iface, uint8_t incoming_ttl);

/* duplicate detection по (src, seq). */
bool klinto_is_duplicate(const uint8_t src[KINTO_MESH_ADDR_LEN], uint32_t seq, uint32_t now_ms);

#ifdef __cplusplus
}
#endif

#endif
