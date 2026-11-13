#ifndef KINTO_TRAFFIC_CLASSIFIER_H
#define KINTO_TRAFFIC_CLASSIFIER_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  KINTO_CLASS_TEXT = 0,
  KINTO_CLASS_TELEMETRY,
  KINTO_CLASS_TELEMETRY_REQ,
  KINTO_CLASS_SEARCH,
  KINTO_CLASS_MEDIA,
  KINTO_CLASS_OTA,
} klinto_traffic_class_t;

typedef struct {
  uint8_t priority;      /* 0 high .. 2 low */
  bool allow_lora;
  bool wifi_only;
  uint16_t max_lora_bytes;
} klinto_traffic_policy_t;

klinto_traffic_class_t klinto_classify(const char *kind, uint32_t size_bytes);
klinto_traffic_policy_t klinto_traffic_policy(klinto_traffic_class_t cls);
bool klinto_can_use_lora(klinto_traffic_class_t cls, uint32_t size_bytes, uint8_t lora_queue_depth);
const char *klinto_drop_reason(klinto_traffic_class_t cls, uint32_t size_bytes, uint8_t lora_queue_depth);

#ifdef __cplusplus
}
#endif

#endif
