#include "hybrid_router.h"

#include <string.h>

static kinto_route_t g_routes[KINTO_ROUTE_MAX];

typedef struct {
  uint32_t hash;
  uint32_t seen_ms;
  bool used;
} kinto_dup_entry_t;

static kinto_dup_entry_t g_dup[KINTO_DUP_RING];
static unsigned g_dup_cursor;

static uint32_t addr_hash(const uint8_t src[KINTO_MESH_ADDR_LEN], uint32_t seq) {
  uint32_t h = 2166136261u ^ seq;
  for (unsigned i = 0; i < KINTO_MESH_ADDR_LEN; i++) {
    h ^= src[i];
    h *= 16777619u;
  }
  return h;
}

void kinto_router_init(void) {
  memset(g_routes, 0, sizeof(g_routes));
  memset(g_dup, 0, sizeof(g_dup));
  g_dup_cursor = 0;
}

uint16_t kinto_route_metric(const kinto_route_t *route) {
  if (!route) return 0xFFFF;
  uint32_t metric = (uint32_t)route->ewma_ms + (uint32_t)route->hops * 35u + (uint32_t)route->queue_depth * 8u;
  return metric > 0xFFFF ? 0xFFFF : (uint16_t)metric;
}

static kinto_route_t *find_route(const uint8_t dst[KINTO_MESH_ADDR_LEN]) {
  for (unsigned i = 0; i < KINTO_ROUTE_MAX; i++) {
    if (g_routes[i].valid && memcmp(g_routes[i].dst, dst, KINTO_MESH_ADDR_LEN) == 0) return &g_routes[i];
  }
  return NULL;
}

bool kinto_route_upsert(const kinto_route_t *route) {
  if (!route) return false;
  kinto_route_t *existing = find_route(route->dst);
  if (existing) {
    if (kinto_route_metric(route) <= kinto_route_metric(existing)) *existing = *route;
    existing->valid = true;
    return true;
  }
  for (unsigned i = 0; i < KINTO_ROUTE_MAX; i++) {
    if (!g_routes[i].valid) {
      g_routes[i] = *route;
      g_routes[i].valid = true;
      return true;
    }
  }
  return false;
}

void kinto_route_remove(const uint8_t dst[KINTO_MESH_ADDR_LEN]) {
  for (unsigned i = 0; i < KINTO_ROUTE_MAX; i++) {
    if (g_routes[i].valid && memcmp(g_routes[i].dst, dst, KINTO_MESH_ADDR_LEN) == 0) g_routes[i].valid = false;
  }
}

kinto_route_t kinto_select_route(const uint8_t dst[KINTO_MESH_ADDR_LEN], kinto_traffic_t traffic, uint32_t now_ms) {
  kinto_route_t none;
  memset(&none, 0, sizeof(none));
  kinto_route_t *best = NULL;
  kinto_route_t *wifi = NULL;
  kinto_route_t *lora = NULL;

  for (unsigned i = 0; i < KINTO_ROUTE_MAX; i++) {
    kinto_route_t *r = &g_routes[i];
    if (!r->valid) continue;
    if (r->expiry_ms && now_ms > r->expiry_ms) {
      r->valid = false;
      continue;
    }
    if (memcmp(r->dst, dst, KINTO_MESH_ADDR_LEN) != 0) continue;
    uint16_t metric = kinto_route_metric(r);
    if (r->iface == KINTO_IFACE_ESPNOW && (!wifi || metric < kinto_route_metric(wifi))) wifi = r;
    if (r->iface == KINTO_IFACE_LORA && (!lora || metric < kinto_route_metric(lora))) lora = r;
    if (!best || metric < kinto_route_metric(best)) best = r;
  }

  // Медиа/OTA не отправляем в LoRa: только ESP-NOW LR.
  if (traffic == KINTO_TRAFFIC_MEDIA || traffic == KINTO_TRAFFIC_OTA) return wifi ? *wifi : none;
  if (wifi && kinto_route_metric(wifi) < KINTO_ESPNOW_PREFERRED) return *wifi;
  if (lora && lora->queue_depth < 3 && kinto_route_metric(lora) < KINTO_LORA_PREFERRED) return *lora;
  if (best) return *best;
  return none;
}

uint8_t kinto_ttl_for_iface(kinto_iface_t iface, uint8_t incoming_ttl) {
  if (incoming_ttl == 0) return 0;
  if (iface == KINTO_IFACE_LORA) {
    uint8_t halved = incoming_ttl / 2;
    return halved > KINTO_TTL_LORA ? KINTO_TTL_LORA : halved;
  }
  return incoming_ttl > KINTO_TTL_WIFI ? KINTO_TTL_WIFI : incoming_ttl;
}

bool kinto_is_duplicate(const uint8_t src[KINTO_MESH_ADDR_LEN], uint32_t seq, uint32_t now_ms) {
  uint32_t hash = addr_hash(src, seq);
  for (unsigned i = 0; i < KINTO_DUP_RING; i++) {
    if (!g_dup[i].used) continue;
    if (now_ms - g_dup[i].seen_ms > 60000u) {
      g_dup[i].used = false;
      continue;
    }
    if (g_dup[i].hash == hash) return true;
  }
  g_dup[g_dup_cursor].hash = hash;
  g_dup[g_dup_cursor].seen_ms = now_ms;
  g_dup[g_dup_cursor].used = true;
  g_dup_cursor = (g_dup_cursor + 1) % KINTO_DUP_RING;
  return false;
}
