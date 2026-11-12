#include "beacon.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void kinto_beacon_init(kinto_beacon_t *b, const char *hardware_id, const char *mesh_addr) {
  if (!b) return;
  memset(b, 0, sizeof(*b));
  if (hardware_id) snprintf(b->hardware_id, sizeof(b->hardware_id), "%s", hardware_id);
  if (mesh_addr) snprintf(b->mesh_addr, sizeof(b->mesh_addr), "%s", mesh_addr);
}

unsigned kinto_beacon_to_json(const kinto_beacon_t *b, char *out, unsigned cap) {
  if (!b || !out || !cap) return 0;
  char hues[32] = "";
  if (b->hues_mask & 0x01) strncat(hues, "\"wifi\"", sizeof(hues) - strlen(hues) - 1);
  if (b->hues_mask & 0x02) {
    if (hues[0]) strncat(hues, ",", sizeof(hues) - strlen(hues) - 1);
    strncat(hues, "\"lora\"", sizeof(hues) - strlen(hues) - 1);
  }
  if (b->hues_mask & 0x04) {
    if (hues[0]) strncat(hues, ",", sizeof(hues) - strlen(hues) - 1);
    strncat(hues, "\"ble\"", sizeof(hues) - strlen(hues) - 1);
  }
  int n = snprintf(
      out, cap,
      "{\"mesh_addr\":\"%s\",\"hw\":\"%s\",\"cluster_id\":%lu,"
      "\"is_anchor\":%d,\"is_border\":%d,\"neighbor_clusters\":[%lu,%lu],"
      "\"hues\":[%s],\"load\":%.2f}",
      b->mesh_addr, b->hardware_id, (unsigned long)b->cluster_id,
      b->is_anchor ? 1 : 0, b->is_border ? 1 : 0,
      (unsigned long)b->neighbor_clusters[0], (unsigned long)b->neighbor_clusters[1],
      hues, (double)b->load);
  return (n > 0 && (unsigned)n < cap) ? (unsigned)n : 0;
}

static const char *find_key(const char *json, const char *key) {
  if (!json || !key) return NULL;
  const char *p = strstr(json, key);
  return p ? p + strlen(key) : NULL;
}

bool kinto_beacon_from_json(const char *json, kinto_beacon_t *out) {
  if (!json || !out) return false;
  memset(out, 0, sizeof(*out));
  const char *p = find_key(json, "\"hw\":\"");
  if (p) {
    const char *end = strchr(p, '"');
    if (end && (size_t)(end - p) < sizeof(out->hardware_id)) {
      memcpy(out->hardware_id, p, (size_t)(end - p));
    }
  }
  p = find_key(json, "\"mesh_addr\":\"");
  if (p) {
    const char *end = strchr(p, '"');
    if (end && (size_t)(end - p) < sizeof(out->mesh_addr)) {
      memcpy(out->mesh_addr, p, (size_t)(end - p));
    }
  }
  p = find_key(json, "\"cluster_id\":");
  if (p) out->cluster_id = (uint32_t)strtoul(p, NULL, 10);
  p = find_key(json, "\"is_anchor\":");
  if (p) out->is_anchor = strtoul(p, NULL, 10) != 0;
  p = find_key(json, "\"is_border\":");
  if (p) out->is_border = strtoul(p, NULL, 10) != 0;
  p = find_key(json, "\"hues\":[");
  if (p) {
    if (strstr(p, "\"wifi\"")) out->hues_mask |= 0x01;
    if (strstr(p, "\"lora\"")) out->hues_mask |= 0x02;
    if (strstr(p, "\"ble\"")) out->hues_mask |= 0x04;
  }
  p = find_key(json, "\"load\":");
  if (p) out->load = (float)atof(p);
  return out->hardware_id[0] != '\0';
}
