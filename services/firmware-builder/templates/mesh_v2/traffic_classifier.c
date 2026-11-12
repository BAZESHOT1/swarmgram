#include "traffic_classifier.h"

#include <string.h>

static bool eq(const char *a, const char *b) { return strcmp(a, b) == 0; }

kinto_traffic_class_t kinto_classify(const char *kind, uint32_t size_bytes) {
  (void)size_bytes;
  if (!kind) return KINTO_CLASS_TEXT;
  if (eq(kind, "ota")) return KINTO_CLASS_OTA;
  if (eq(kind, "telemetry")) return KINTO_CLASS_TELEMETRY;
  if (eq(kind, "telemetry_request")) return KINTO_CLASS_TELEMETRY_REQ;
  if (eq(kind, "search")) return KINTO_CLASS_SEARCH;
  if (eq(kind, "media") || eq(kind, "image") || eq(kind, "video") || eq(kind, "file")) return KINTO_CLASS_MEDIA;
  return KINTO_CLASS_TEXT;
}

kinto_traffic_policy_t kinto_traffic_policy(kinto_traffic_class_t cls) {
  switch (cls) {
    case KINTO_CLASS_TEXT: return (kinto_traffic_policy_t){0, true, false, 0xFFFF};
    case KINTO_CLASS_TELEMETRY_REQ: return (kinto_traffic_policy_t){1, true, false, 512};
    case KINTO_CLASS_SEARCH: return (kinto_traffic_policy_t){1, true, false, 1024};
    case KINTO_CLASS_TELEMETRY: return (kinto_traffic_policy_t){2, true, false, 512};
    case KINTO_CLASS_OTA: return (kinto_traffic_policy_t){2, false, true, 0};
    case KINTO_CLASS_MEDIA: return (kinto_traffic_policy_t){2, true, false, 2048};
  }
  return (kinto_traffic_policy_t){2, true, false, 512};
}

bool kinto_can_use_lora(kinto_traffic_class_t cls, uint32_t size_bytes, uint8_t lora_queue_depth) {
  kinto_traffic_policy_t policy = kinto_traffic_policy(cls);
  if (!policy.allow_lora) return false;
  if (cls == KINTO_CLASS_MEDIA) return size_bytes <= policy.max_lora_bytes && lora_queue_depth < 3;
  return size_bytes <= policy.max_lora_bytes;
}

const char *kinto_drop_reason(kinto_traffic_class_t cls, uint32_t size_bytes, uint8_t lora_queue_depth) {
  if (kinto_can_use_lora(cls, size_bytes, lora_queue_depth)) return NULL;
  return cls == KINTO_CLASS_MEDIA ? "media_dropped_due_to_lora_congestion" : "lora_unavailable_for_traffic";
}
