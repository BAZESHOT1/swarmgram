#ifndef KINTO_TRAFFIC_CLASSIFIER_H
#define KINTO_TRAFFIC_CLASSIFIER_H

#include <stdint.h>
#include <stdbool.h>

typedef enum {
  KINTO_CLASS_TEXT = 0,
  KINTO_CLASS_TELEMETRY,
  KINTO_CLASS_TELEMETRY_REQ,
  KINTO_CLASS_SEARCH,
  KINTO_CLASS_MEDIA,
  KINTO_CLASS_OTA,
} kinto_traffic_class_t;

typedef struct {
  uint8_t priority;      /* 0 high .. 2 low */
  bool allow_lora;
  bool wifi_only;
  uint16_t max_lora_bytes;
} kinto_traffic_policy_t;

kinto_traffic_class_t kinto_classify(const char *kind, uint32_t size_bytes);
kinto_traffic_policy_t kinto_traffic_policy(kinto_traffic_class_t cls);
bool kinto_can_use_lora(kinto_traffic_class_t cls, uint32_t size_bytes, uint8_t lora_queue_depth);
const char *kinto_drop_reason(kinto_traffic_class_t cls, uint32_t size_bytes, uint8_t lora_queue_depth);

#endif
