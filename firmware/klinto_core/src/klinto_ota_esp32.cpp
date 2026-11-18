#include "klinto_ota_esp32.h"
#include "klinto_ota_pubkey.h"
#include "klinto_util.h"

#if defined(ESP32)

#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>

#include <mbedtls/md.h>
#include <mbedtls/pk.h>

#if KL_HAS_MQTT
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#endif

#include <string.h>

#define KL_OTA_PATCH_PATH "/ota/patch.bin"

/* Последний успешный ответ Hub (мс аптайма): условие подтверждения новой прошивки шлюза. */
volatile uint32_t g_kl_hub_ok_ms = 0;

namespace {

/* Окно чужого образа для раздачи шлюзом (KL_OTA_SRC_REMOTE): 32 чанка. */
constexpr uint32_t kRemoteWindow = KL_OTA_WINDOW * KL_OTA_CHUNK_DATA;
uint8_t g_remote_buf[kRemoteWindow];
volatile uint32_t g_remote_off = 0xFFFFFFFFu;
volatile uint32_t g_remote_len = 0;
volatile uint32_t g_remote_want = 0xFFFFFFFFu;
uint32_t g_remote_size = 0;
char g_remote_url[128] = {0};
char g_remote_token[80] = {0};
char g_remote_path[128] = {0};
portMUX_TYPE g_remote_mux = portMUX_INITIALIZER_UNLOCKED;

void remember_pending(const esp_partition_t *target, uint16_t target_build);

File g_patch;
bool g_patch_open = false;
esp_ota_handle_t g_ota = 0;
const esp_partition_t *g_target = nullptr;

void close_patch() {
  if (g_patch_open) {
    g_patch.close();
    g_patch_open = false;
  }
}

bool ensure_patch(bool write) {
  if (g_patch_open) return true;
  if (!LittleFS.begin(true)) return false;
  if (!LittleFS.exists("/ota")) LittleFS.mkdir("/ota");
  g_patch = LittleFS.open(KL_OTA_PATCH_PATH, write ? "w+" : "r");
  g_patch_open = g_patch ? true : false;
  return g_patch_open;
}

bool patch_write(void *, uint32_t offset, const uint8_t *data, size_t len) {
  if (!data || !len) return false;
  if (!ensure_patch(true)) return false;
  if (!g_patch.seek(offset)) return false;
  return g_patch.write(data, len) == len;
}

bool patch_read(void *, uint32_t offset, uint8_t *out, size_t len) {
  if (!out || !len) return false;
  if (!ensure_patch(false)) return false;
  if (!g_patch.seek(offset)) return false;
  return g_patch.read(out, len) == len;
}

bool patch_erase(void *) {
  close_patch();
  if (!LittleFS.begin(true)) return false;
  if (LittleFS.exists(KL_OTA_PATCH_PATH)) LittleFS.remove(KL_OTA_PATCH_PATH);
  return true;
}

bool read_running(void *, uint32_t offset, uint8_t *out, size_t len) {
  const esp_partition_t *part = esp_ota_get_running_partition();
  if (!part || !out) return false;
  if (offset + len > part->size) return false;
  return esp_partition_read(part, offset, out, len) == ESP_OK;
}

bool begin_target(void *, uint32_t target_size) {
  g_target = esp_ota_get_next_update_partition(nullptr);
  if (!g_target) return false;
  if (target_size > g_target->size) return false;
  return esp_ota_begin(g_target, target_size, &g_ota) == ESP_OK;
}

bool write_target(void *, const uint8_t *data, size_t len) {
  if (!data || !len || g_ota == 0) return false;
  return esp_ota_write(g_ota, data, len) == ESP_OK;
}

bool verify_signature(void *, const uint8_t digest[32], const uint8_t *sig, size_t sig_len) {
  if (!digest || !sig || sig_len == 0 || sig_len > 80) return false;
  static const uint8_t kSpkiPrefix[26] = {
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00};
  uint8_t der[26 + 65];
  memcpy(der, kSpkiPrefix, sizeof(kSpkiPrefix));
  if (kl_hex_decode(KL_OTA_PUBKEY_HEX, strlen(KL_OTA_PUBKEY_HEX), der + 26, 65) != 65) return false;

  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int rc = mbedtls_pk_parse_public_key(&pk, der, sizeof(der));
  if (rc == 0) {
    rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, 32, sig, sig_len);
  }
  mbedtls_pk_free(&pk);
  return rc == 0;
}

bool commit_target(void *, const uint8_t sha[32], const kl_ota_manifest_t *m) {
  if (!m || g_ota == 0 || !g_target) return false;
  uint8_t digest[32];
  kl_ota_manifest_digest(m, digest);
  if (!verify_signature(nullptr, digest, m->sig, m->sig_len)) {
    esp_ota_abort(g_ota);
    g_ota = 0;
    return false;
  }
  uint8_t diff = 0;
  for (uint8_t i = 0; i < 32; ++i) diff |= (uint8_t)(sha[i] ^ m->target_sha256[i]);
  if (diff != 0) {
    esp_ota_abort(g_ota);
    g_ota = 0;
    return false;
  }
  if (esp_ota_end(g_ota) != ESP_OK) {
    g_ota = 0;
    return false;
  }
  g_ota = 0;
  /* Ручной откат: запоминаем прошлый слот. Новый образ должен подтвердиться
   * (mark_valid) в течение первого цикла, иначе следующая загрузка вернёт prev. */
  remember_pending(g_target, m->target_build);
  return esp_ota_set_boot_partition(g_target) == ESP_OK;
}

bool slot_begin(void *, uint32_t size) {
  g_target = esp_ota_get_next_update_partition(nullptr);
  if (!g_target || size == 0 || size > g_target->size) return false;
  const uint32_t erase = (size + 4095u) & ~4095u;
  /* Стираем частями, отдавая процессор: целиком это секунды, сторожевой таймер не любит. */
  for (uint32_t off = 0; off < erase; off += 65536u) {
    const uint32_t part = (erase - off) > 65536u ? 65536u : (erase - off);
    if (esp_partition_erase_range(g_target, off, part) != ESP_OK) return false;
    vTaskDelay(1);
  }
  return true;
}

bool slot_write(void *, uint32_t offset, const uint8_t *data, size_t len) {
  if (!g_target || !data || !len || offset + len > g_target->size) return false;
  return esp_partition_write(g_target, offset, data, len) == ESP_OK;
}

void remember_pending(const esp_partition_t *target, uint16_t target_build) {
  const esp_partition_t *running = esp_ota_get_running_partition();
  Preferences prefs;
  if (prefs.begin("klinto_ota", false)) {
    prefs.putUInt("prev", running ? running->address : 0);
    prefs.putUInt("target", target->address);
    prefs.putUShort("tbuild", target_build);
    prefs.putUChar("pend", 1);
    prefs.putUChar("boots", 0);
    prefs.end();
  }
}

bool slot_finish(void *, const kl_ota_manifest_t *m) {
  if (!m || !g_target) return false;
  uint8_t digest[32];
  kl_ota_manifest_digest(m, digest);
  if (!verify_signature(nullptr, digest, m->sig, m->sig_len)) return false;
  KlintoSha256 sha;
  kl_sha256_init(&sha);
  uint8_t buf[1024];
  for (uint32_t off = 0; off < m->patch_size; off += sizeof(buf)) {
    const uint32_t take = (m->patch_size - off) > sizeof(buf) ? (uint32_t)sizeof(buf) : (m->patch_size - off);
    if (esp_partition_read(g_target, off, buf, take) != ESP_OK) return false;
    kl_sha256_update(&sha, buf, take);
    if ((off & 0xFFFF) == 0) vTaskDelay(1);
  }
  uint8_t got[32];
  kl_sha256_final(&sha, got);
  if (memcmp(got, m->target_sha256, 32) != 0) return false;
  remember_pending(g_target, m->target_build);
  /* esp_ota_set_boot_partition дополнительно проверяет заголовок и checksum образа. */
  return esp_ota_set_boot_partition(g_target) == ESP_OK;
}

bool remote_read(void *, uint32_t offset, uint8_t *out, size_t len) {
  if (!out || !len || !g_remote_size) return false;
  bool hit = false;
  portENTER_CRITICAL(&g_remote_mux);
  if (g_remote_off != 0xFFFFFFFFu && offset >= g_remote_off && offset + len <= g_remote_off + g_remote_len) {
    memcpy(out, g_remote_buf + (offset - g_remote_off), len);
    hit = true;
  } else {
    g_remote_want = offset - (offset % kRemoteWindow);
  }
  portEXIT_CRITICAL(&g_remote_mux);
  return hit;
}

void store_manifest(void *, const kl_ota_manifest_t *m) {
  if (!m) return;
  Preferences prefs;
  if (prefs.begin("klinto_ota", false)) {
    prefs.putBytes("mf", m, sizeof(*m));
    prefs.end();
  }
}

void abort_target(void *) {
  if (g_ota) {
    esp_ota_abort(g_ota);
    g_ota = 0;
  }
}

void reboot(void *) { esp_restart(); }

void mark_valid(void *) {
  esp_ota_mark_app_valid_cancel_rollback();
  Preferences prefs;
  if (prefs.begin("klinto_ota", false)) {
    prefs.putUChar("pend", 0);
    prefs.putUChar("boots", 0);
    prefs.end();
  }
}

}  // namespace

bool kl_ota_esp32_verify_pubkey(const uint8_t digest[32], const uint8_t *sig, size_t sig_len) {
  return verify_signature(nullptr, digest, sig, sig_len);
}

bool kl_ota_esp32_begin() {
  kl_ota_esp32_check_rollback();
  if (!LittleFS.begin(true)) return false;
  if (!LittleFS.exists("/ota")) LittleFS.mkdir("/ota");
  return true;
}

const kl_ota_platform_t *kl_ota_esp32_platform() {
  static kl_ota_platform_t platform = {
      nullptr, patch_write, patch_read, patch_erase, read_running, begin_target,
      write_target, commit_target, abort_target, reboot, verify_signature, mark_valid,
      slot_begin, slot_write, slot_finish, remote_read, store_manifest,
  };
  return &platform;
}

uint16_t kl_ota_esp32_stored_build() {
  Preferences prefs;
  if (!prefs.begin("klinto_ota", true)) return 0;
  const uint16_t value = prefs.getUShort("build", 0);
  prefs.end();
  return value;
}

void kl_ota_esp32_store_build(uint16_t build) {
  Preferences prefs;
  if (!prefs.begin("klinto_ota", false)) return;
  prefs.putUShort("build", build);
  prefs.end();
}

void kl_ota_esp32_mark_valid() { esp_ota_mark_app_valid_cancel_rollback(); }

bool kl_ota_esp32_pending() {
  Preferences prefs;
  if (!prefs.begin("klinto_ota", true)) return false;
  const bool pend = prefs.getUChar("pend", 0) != 0;
  const uint32_t target = prefs.getUInt("target", 0);
  prefs.end();
  const esp_partition_t *running = esp_ota_get_running_partition();
  return pend && running && running->address == target;
}

void kl_ota_esp32_rollback_now(const char *reason) {
  Preferences prefs;
  if (!prefs.begin("klinto_ota", false)) return;
  const uint32_t prev = prefs.getUInt("prev", 0);
  const uint16_t tbuild = prefs.getUShort("tbuild", 0);
  prefs.putUShort("bad", tbuild);
  prefs.putUChar("pend", 0);
  prefs.putUChar("boots", 0);
  prefs.end();
  Serial.printf("[ota] rollback: %s (build %u marked bad)\n", reason ? reason : "", (unsigned)tbuild);
  const esp_partition_t *candidates[3] = {
      esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, nullptr),
      esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, nullptr),
      esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_FACTORY, nullptr),
  };
  for (const esp_partition_t *p : candidates) {
    if (p && p->address == prev) {
      esp_ota_set_boot_partition(p);
      break;
    }
  }
  delay(200);
  esp_restart();
}

uint16_t kl_ota_esp32_bad_build() {
  Preferences prefs;
  if (!prefs.begin("klinto_ota", true)) return 0;
  const uint16_t v = prefs.getUShort("bad", 0);
  prefs.end();
  return v;
}

void kl_ota_esp32_set_need_ifc(uint8_t mask) {
  Preferences prefs;
  if (prefs.begin("klinto_ota", false)) {
    prefs.putUChar("nifc", mask);
    prefs.end();
  }
}

uint8_t kl_ota_esp32_need_ifc() {
  Preferences prefs;
  if (!prefs.begin("klinto_ota", true)) return 0;
  const uint8_t v = prefs.getUChar("nifc", 0);
  prefs.end();
  return v;
}

bool kl_ota_esp32_load_manifest(kl_ota_manifest_t *out) {
  if (!out) return false;
  Preferences prefs;
  if (!prefs.begin("klinto_ota", true)) return false;
  const size_t got = prefs.getBytes("mf", out, sizeof(*out));
  prefs.end();
  return got == sizeof(*out) && out->patch_size > 0;
}

void kl_ota_esp32_remote_set(const char *hub_url, const char *token, const char *path, uint32_t size) {
  portENTER_CRITICAL(&g_remote_mux);
  strncpy(g_remote_url, hub_url ? hub_url : "", sizeof(g_remote_url) - 1);
  strncpy(g_remote_token, token ? token : "", sizeof(g_remote_token) - 1);
  strncpy(g_remote_path, path ? path : "", sizeof(g_remote_path) - 1);
  g_remote_size = size;
  g_remote_off = 0xFFFFFFFFu;
  g_remote_len = 0;
  g_remote_want = 0;
  portEXIT_CRITICAL(&g_remote_mux);
}

void kl_ota_esp32_remote_clear() {
  portENTER_CRITICAL(&g_remote_mux);
  g_remote_size = 0;
  g_remote_off = 0xFFFFFFFFu;
  g_remote_want = 0xFFFFFFFFu;
  portEXIT_CRITICAL(&g_remote_mux);
}

bool kl_ota_esp32_check_rollback() {
  Preferences prefs;
  if (!prefs.begin("klinto_ota", false)) return false;
  if (!prefs.getUChar("pend", 0)) {
    prefs.end();
    return false;
  }
  const uint32_t prev = prefs.getUInt("prev", 0);
  const uint32_t target = prefs.getUInt("target", 0);
  const esp_partition_t *running = esp_ota_get_running_partition();
  const uint32_t runAddr = running ? running->address : 0;
  if (!target || runAddr != target) {
    /* Мы уже на прошлом слоте (или разметка изменилась) — подтверждение не нужно. */
    prefs.putUChar("pend", 0);
    prefs.putUChar("boots", 0);
    prefs.end();
    return false;
  }
  uint8_t boots = (uint8_t)(prefs.getUChar("boots", 0) + 1);
  if (boots >= 3 && prev) {
    prefs.putUShort("bad", prefs.getUShort("tbuild", 0));
    const esp_partition_t *candidates[3] = {
        esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, nullptr),
        esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, nullptr),
        esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_FACTORY, nullptr),
    };
    for (const esp_partition_t *p : candidates) {
      if (!p || p->address != prev) continue;
      if (esp_ota_set_boot_partition(p) == ESP_OK) {
        prefs.putUChar("pend", 0);
        prefs.putUChar("boots", 0);
        prefs.end();
        esp_restart();
        return true;
      }
    }
  }
  prefs.putUChar("boots", boots);
  prefs.end();
  return false;
}

#if KL_HAS_MQTT

namespace {

struct HttpUrl {
  bool tls;
  char host[80];
  uint16_t port;
  char path[128];
};

bool parseHttpUrl(const char *url, HttpUrl *out) {
  if (!url || !out) return false;
  const char *p = url;
  memset(out, 0, sizeof(*out));
  if (!strncmp(p, "https://", 8)) {
    out->tls = true;
    out->port = 443;
    p += 8;
  } else if (!strncmp(p, "http://", 7)) {
    out->tls = false;
    out->port = 80;
    p += 7;
  } else {
    return false;
  }
  const char *slash = strchr(p, '/');
  const char *end = slash ? slash : p + strlen(p);
  const char *colon = nullptr;
  for (const char *q = p; q < end; ++q) {
    if (*q == ':') colon = q;
  }
  const size_t host_len = (size_t)((colon ? colon : end) - p);
  if (!host_len || host_len >= sizeof(out->host)) return false;
  memcpy(out->host, p, host_len);
  out->host[host_len] = '\0';
  if (colon) out->port = (uint16_t)atoi(colon + 1);
  if (slash) {
    strncpy(out->path, slash, sizeof(out->path) - 1);
  } else {
    strcpy(out->path, "/");
  }
  return true;
}

int httpGet(const HttpUrl &url, const char *token, char *body, size_t cap) {
  WiFiClient plain;
  WiFiClientSecure secure;
  Client *client = &plain;
  if (url.tls) {
    secure.setInsecure();
    secure.setTimeout(8000);
    client = &secure;
  } else {
    plain.setTimeout(8000);
  }
  if (!client->connect(url.host, url.port)) return -1;
  char request[384];
  const int n = snprintf(request, sizeof(request),
                         "GET %s HTTP/1.0\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"
                         "x-kmesh-key: %s\r\n"
                         "Accept: application/json\r\nConnection: close\r\n\r\n",
                         url.path, url.host, token ? token : "", token ? token : "");
  if (n <= 0 || (size_t)n >= sizeof(request)) {
    client->stop();
    return -1;
  }
  client->print(request);
  uint32_t start = millis();
  while (!client->available() && millis() - start < 8000) delay(10);
  /* Заголовки ответа. */
  char line[192];
  int status = 0;
  bool headers_done = false;
  while (client->available() && !headers_done && millis() - start < 15000) {
    const int len = client->readBytesUntil('\n', line, sizeof(line) - 1);
    if (len <= 0) break;
    line[len] = '\0';
    if (!status) {
      const char *sp = strchr(line, ' ');
      if (sp) status = atoi(sp + 1);
    }
    if (len <= 2) headers_done = true;
  }
  if (status != 200) {
    client->stop();
    return -1;
  }
  g_kl_hub_ok_ms = millis() ? millis() : 1;
  size_t used = 0;
  start = millis();
  while (used + 1 < cap && millis() - start < 20000) {
    while (client->available() && used + 1 < cap) {
      const int got = client->read((uint8_t *)body + used, cap - 1 - used);
      if (got <= 0) break;
      used += (size_t)got;
    }
    if (!client->connected() && !client->available()) break;
    delay(5);
  }
  body[used] = '\0';
  client->stop();
  return (int)used;
}

bool downloadPatch(const HttpUrl &base, const char *token, const char *path, uint32_t expected) {
  HttpUrl url = base;
  strncpy(url.path, path, sizeof(url.path) - 1);
  WiFiClient plain;
  WiFiClientSecure secure;
  Client *client = &plain;
  if (url.tls) {
    secure.setInsecure();
    secure.setTimeout(15000);
    client = &secure;
  } else {
    plain.setTimeout(15000);
  }
  if (!client->connect(url.host, url.port)) return false;
  char request[384];
  const int n = snprintf(request, sizeof(request),
                         "GET %s HTTP/1.0\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"
                         "x-kmesh-key: %s\r\nConnection: close\r\n\r\n",
                         url.path, url.host, token ? token : "", token ? token : "");
  if (n <= 0 || (size_t)n >= sizeof(request)) {
    client->stop();
    return false;
  }
  client->print(request);
  uint32_t start = millis();
  while (!client->available() && millis() - start < 15000) delay(10);
  char line[192];
  int status = 0;
  bool headers_done = false;
  while (client->available() && !headers_done && millis() - start < 20000) {
    const int len = client->readBytesUntil('\n', line, sizeof(line) - 1);
    if (len <= 0) break;
    line[len] = '\0';
    if (!status) {
      const char *sp = strchr(line, ' ');
      if (sp) status = atoi(sp + 1);
    }
    if (len <= 2) headers_done = true;
  }
  if (status != 200) {
    client->stop();
    return false;
  }
  patch_erase(nullptr);
  uint8_t buf[512];
  uint32_t offset = 0;
  while (offset < expected && millis() - start < 120000) {
    const int got = client->read(buf, sizeof(buf));
    if (got <= 0) {
      if (!client->connected()) break;
      delay(10);
      continue;
    }
    const size_t take = (offset + (uint32_t)got > expected) ? (expected - offset) : (size_t)got;
    if (!patch_write(nullptr, offset, buf, take)) {
      client->stop();
      return false;
    }
    offset += (uint32_t)take;
  }
  client->stop();
  return offset == expected;
}

bool downloadFull(const HttpUrl &base, const char *token, const char *path, uint32_t expected,
                  const kl_ota_manifest_t &manifest) {
  HttpUrl url = base;
  strncpy(url.path, path, sizeof(url.path) - 1);
  WiFiClient plain;
  WiFiClientSecure secure;
  Client *client = &plain;
  if (url.tls) {
    secure.setInsecure();
    secure.setTimeout(20000);
    client = &secure;
  } else {
    plain.setTimeout(20000);
  }
  if (!client->connect(url.host, url.port)) return false;
  char request[384];
  const int n = snprintf(request, sizeof(request),
                         "GET %s HTTP/1.0\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"
                         "x-kmesh-key: %s\r\nConnection: close\r\n\r\n",
                         url.path, url.host, token ? token : "", token ? token : "");
  if (n <= 0 || (size_t)n >= sizeof(request)) {
    client->stop();
    return false;
  }
  client->print(request);
  uint32_t start = millis();
  while (!client->available() && millis() - start < 20000) delay(10);
  char line[192];
  int status = 0;
  bool headers_done = false;
  while (client->available() && !headers_done && millis() - start < 30000) {
    const int len = client->readBytesUntil('\n', line, sizeof(line) - 1);
    if (len <= 0) break;
    line[len] = '\0';
    if (!status) {
      const char *sp = strchr(line, ' ');
      if (sp) status = atoi(sp + 1);
    }
    if (len <= 2) headers_done = true;
  }
  if (status != 200) {
    client->stop();
    return false;
  }
  if (!begin_target(nullptr, expected)) {
    client->stop();
    return false;
  }
  KlintoSha256 sha;
  kl_sha256_init(&sha);
  uint8_t buf[512];
  uint32_t offset = 0;
  while (offset < expected && millis() - start < 240000) {
    const int got = client->read(buf, sizeof(buf));
    if (got <= 0) {
      if (!client->connected()) break;
      delay(10);
      continue;
    }
    const size_t take = (offset + (uint32_t)got > expected) ? (expected - offset) : (size_t)got;
    if (!write_target(nullptr, buf, take)) {
      abort_target(nullptr);
      client->stop();
      return false;
    }
    kl_sha256_update(&sha, buf, take);
    offset += (uint32_t)take;
  }
  client->stop();
  if (offset != expected) {
    abort_target(nullptr);
    return false;
  }
  uint8_t digest[32];
  kl_sha256_final(&sha, digest);
  if (!commit_target(nullptr, digest, &manifest)) {
    abort_target(nullptr);
    return false;
  }
  reboot(nullptr);
  return true;
}

/** Окно образа через HTTP Range: ровно len байт с offset. */
bool httpGetRange(const HttpUrl &base, const char *token, const char *path, uint32_t offset, uint32_t len,
                  uint8_t *out) {
  HttpUrl url = base;
  strncpy(url.path, path, sizeof(url.path) - 1);
  WiFiClient plain;
  WiFiClientSecure secure;
  Client *client = &plain;
  if (url.tls) {
    secure.setInsecure();
    secure.setTimeout(10000);
    client = &secure;
  } else {
    plain.setTimeout(10000);
  }
  if (!client->connect(url.host, url.port)) return false;
  char request[448];
  const int n = snprintf(request, sizeof(request),
                         "GET %s HTTP/1.0\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"
                         "x-kmesh-key: %s\r\nRange: bytes=%lu-%lu\r\nConnection: close\r\n\r\n",
                         url.path, url.host, token ? token : "", token ? token : "",
                         (unsigned long)offset, (unsigned long)(offset + len - 1));
  if (n <= 0 || (size_t)n >= sizeof(request)) {
    client->stop();
    return false;
  }
  client->print(request);
  uint32_t start = millis();
  while (!client->available() && millis() - start < 10000) delay(5);
  char line[192];
  int status = 0;
  bool headers_done = false;
  while (client->available() && !headers_done && millis() - start < 15000) {
    const int l = client->readBytesUntil('\n', line, sizeof(line) - 1);
    if (l <= 0) break;
    line[l] = '\0';
    if (!status) {
      const char *sp = strchr(line, ' ');
      if (sp) status = atoi(sp + 1);
    }
    if (l <= 2) headers_done = true;
  }
  if (status != 206) {
    client->stop();
    return false;
  }
  uint32_t got_total = 0;
  while (got_total < len && millis() - start < 30000) {
    const int got = client->read(out + got_total, len - got_total);
    if (got <= 0) {
      if (!client->connected()) break;
      delay(5);
      continue;
    }
    got_total += (uint32_t)got;
  }
  client->stop();
  return got_total == len;
}

}  // namespace

void kl_ota_esp32_remote_service() {
  uint32_t want, size;
  char url_s[128], token[80], path[128];
  portENTER_CRITICAL(&g_remote_mux);
  want = g_remote_want;
  size = g_remote_size;
  const bool ready = g_remote_off == want;
  memcpy(url_s, g_remote_url, sizeof(url_s));
  memcpy(token, g_remote_token, sizeof(token));
  memcpy(path, g_remote_path, sizeof(path));
  portEXIT_CRITICAL(&g_remote_mux);
  if (!size || want == 0xFFFFFFFFu || ready || want >= size) return;
  HttpUrl url;
  if (!parseHttpUrl(url_s, &url)) return;
  const uint32_t len = (size - want) > kRemoteWindow ? kRemoteWindow : (size - want);
  static uint8_t tmp[kRemoteWindow];
  if (!httpGetRange(url, token, path, want, len, tmp)) return;
  portENTER_CRITICAL(&g_remote_mux);
  memcpy(g_remote_buf, tmp, len);
  g_remote_off = want;
  g_remote_len = len;
  portEXIT_CRITICAL(&g_remote_mux);
}

bool kl_ota_esp32_query(const char *hub_url, const char *token, const char *chip_name, uint8_t chip_arch,
                        uint8_t variant, uint16_t base_build, uint32_t gw_id, bool self_update,
                        kl_ota_manifest_t *out, char *path, size_t path_cap, bool *is_full) {
  if (!hub_url || !token || !chip_name || !out || !path || !is_full) return false;
  HttpUrl url;
  if (!parseHttpUrl(hub_url, &url)) return false;
  char q[192];
  snprintf(q, sizeof(q), "/v1/kmesh/v1/ota/latest?chip=%s&base_build=%u&variant=%u&gw=%lu&self=%u",
           chip_name, (unsigned)base_build, (unsigned)variant, (unsigned long)gw_id, self_update ? 1u : 0u);
  strncpy(url.path, q, sizeof(url.path) - 1);
  char body[1024];
  if (httpGet(url, token, body, sizeof(body)) <= 0) return false;
  bool full = false;
  (void)kl_json_get_bool(body, "full", &full);
  uint32_t target_build = 0, total_chunks = 0, size = 0, patch_id = 0, ifc = 0xFF;
  if (!kl_json_get_uint(body, "target_build", &target_build) ||
      !kl_json_get_uint(body, "total_chunks", &total_chunks)) {
    return false;
  }
  (void)kl_json_get_uint(body, "patch_id", &patch_id);
  (void)kl_json_get_uint(body, "ifc_mask", &ifc);
  if (!kl_json_get_uint(body, full ? "full_size" : "patch_size", &size)) return false;
  char patch_sha[65] = {0}, target_sha[65] = {0}, signature[160] = {0};
  if (!kl_json_get_string(body, "patch_sha256", patch_sha, sizeof(patch_sha)) ||
      !kl_json_get_string(body, "target_sha256", target_sha, sizeof(target_sha)) ||
      !kl_json_get_string(body, "signature", signature, sizeof(signature)) ||
      !kl_json_get_string(body, full ? "full_url" : "patch_url", path, path_cap)) {
    return false;
  }
  memset(out, 0, sizeof(*out));
  out->patch_id = (uint16_t)patch_id;
  out->chip = chip_arch;
  out->variant = variant;
  out->ifc_mask = (uint8_t)(ifc ? ifc : 0xFF);
  out->base_build = base_build;
  out->target_build = (uint16_t)target_build;
  out->total_chunks = (uint16_t)total_chunks;
  out->patch_size = size;
  if (kl_hex_decode(patch_sha, strlen(patch_sha), out->patch_sha256, 32) != 32) return false;
  if (kl_hex_decode(target_sha, strlen(target_sha), out->target_sha256, 32) != 32) return false;
  out->sig_len = (uint8_t)kl_hex_decode(signature, strlen(signature), out->sig, KL_OTA_MAX_SIG);
  *is_full = full;
  return out->sig_len > 0;
}

bool kl_ota_esp32_install_full(const char *hub_url, const char *token, const char *path,
                               const kl_ota_manifest_t *m) {
  HttpUrl url;
  if (!m || !parseHttpUrl(hub_url, &url)) return false;
  return downloadFull(url, token, path, m->patch_size, *m);
}

bool kl_ota_esp32_fetch_patch(const char *hub_url, const char *token, const char *path, uint32_t size) {
  HttpUrl url;
  if (!parseHttpUrl(hub_url, &url)) return false;
  return downloadPatch(url, token, path, size);
}

bool kl_ota_esp32_sync_chip(const char *hub_url, const char *module_token, const char *chip_name,
                            uint8_t chip_arch, uint16_t base_build,
                            kl_ota_manifest_t *out) {
  if (!hub_url || !module_token || !chip_name || !out) return false;
  HttpUrl url;
  if (!parseHttpUrl(hub_url, &url)) return false;
  char path[160];
  snprintf(path, sizeof(path), "/v1/kmesh/v1/ota/latest?chip=%s&base_build=%u", chip_name,
           (unsigned)base_build);
  strncpy(url.path, path, sizeof(url.path) - 1);
  char body[1024];
  if (httpGet(url, module_token, body, sizeof(body)) <= 0) return false;
  bool is_full = false;
  (void)kl_json_get_bool(body, "full", &is_full);
  uint32_t target_build = 0, total_chunks = 0, patch_size = 0, patch_id = 0;
  if (!kl_json_get_uint(body, "target_build", &target_build) ||
      !kl_json_get_uint(body, "total_chunks", &total_chunks)) {
    return false;
  }
  char target_sha[65] = {0};
  char signature[160] = {0};
  if (!kl_json_get_string(body, "target_sha256", target_sha, sizeof(target_sha)) ||
      !kl_json_get_string(body, "signature", signature, sizeof(signature))) {
    return false;
  }

  if (is_full) {
    uint32_t full_size = 0;
    char full_url[128] = {0};
    char full_sha[65] = {0};
    if (!kl_json_get_uint(body, "full_size", &full_size) ||
        !kl_json_get_string(body, "patch_sha256", full_sha, sizeof(full_sha)) ||
        !kl_json_get_string(body, "full_url", full_url, sizeof(full_url))) {
      return false;
    }
    kl_ota_manifest_t manifest;
    memset(&manifest, 0, sizeof(manifest));
    manifest.chip = chip_arch;
    manifest.base_build = (uint16_t)base_build;
    manifest.target_build = (uint16_t)target_build;
    manifest.total_chunks = (uint16_t)total_chunks;
    manifest.patch_size = full_size;
    if (kl_hex_decode(full_sha, strlen(full_sha), manifest.patch_sha256, 32) != 32) return false;
    if (kl_hex_decode(target_sha, strlen(target_sha), manifest.target_sha256, 32) != 32) return false;
    const size_t bytes = kl_hex_decode(signature, strlen(signature), manifest.sig,
                                       KL_OTA_MAX_SIG);
    manifest.sig_len = (uint8_t)bytes;
    if (!manifest.sig_len) return false;
    /* Полный образ по Wi-Fi: пишем прямо в неактивный слот и проверяем подпись. */
    return downloadFull(url, module_token, full_url, full_size, manifest);
  }

  if (!kl_json_get_uint(body, "patch_id", &patch_id) ||
      !kl_json_get_uint(body, "patch_size", &patch_size)) {
    return false;
  }
  char patch_sha[65] = {0};
  char patch_url[128] = {0};
  if (!kl_json_get_string(body, "patch_sha256", patch_sha, sizeof(patch_sha)) ||
      !kl_json_get_string(body, "patch_url", patch_url, sizeof(patch_url))) {
    return false;
  }
  memset(out, 0, sizeof(*out));
  out->patch_id = (uint16_t)patch_id;
  out->chip = chip_arch;
  out->base_build = (uint16_t)base_build;
  out->target_build = (uint16_t)target_build;
  out->total_chunks = (uint16_t)total_chunks;
  out->patch_size = patch_size;
  if (kl_hex_decode(patch_sha, strlen(patch_sha), out->patch_sha256, 32) != 32) return false;
  if (kl_hex_decode(target_sha, strlen(target_sha), out->target_sha256, 32) != 32) return false;
  const size_t sig_bytes = kl_hex_decode(signature, strlen(signature), out->sig, KL_OTA_MAX_SIG);
  out->sig_len = (uint8_t)sig_bytes;
  if (out->sig_len == 0) return false;
  if (!downloadPatch(url, module_token, patch_url, patch_size)) return false;
  return true;
}

bool kl_ota_esp32_sync(const char *hub_url, const char *module_token, uint8_t chip_arch,
                       uint16_t current_build, kl_ota_manifest_t *out) {
  const char *chip = chip_arch == 2 ? "esp32c3"
                     : chip_arch == 3 ? "esp32s3"
                     : chip_arch == 4 ? "esp32c6"
                     : chip_arch == 6 ? "esp32c5"
                                      : "esp32";
  return kl_ota_esp32_sync_chip(hub_url, module_token, chip, chip_arch, current_build, out);
}

int kl_ota_esp32_plan(const char *hub_url, const char *module_token, uint32_t gw_id, char *out, size_t cap) {
  if (!hub_url || !module_token || !out || cap < 8) return -1;
  HttpUrl url;
  if (!parseHttpUrl(hub_url, &url)) return -1;
  snprintf(url.path, sizeof(url.path), "/v1/kmesh/v1/ota/plan?gw=%lu", (unsigned long)gw_id);
  return httpGet(url, module_token, out, cap);
}

#else

bool kl_ota_esp32_sync(const char *, const char *, uint8_t, uint16_t, kl_ota_manifest_t *) {
  return false;
}
bool kl_ota_esp32_sync_chip(const char *, const char *, const char *, uint8_t, uint16_t,
                            kl_ota_manifest_t *) {
  return false;
}
int kl_ota_esp32_plan(const char *, const char *, uint32_t, char *, size_t) { return -1; }
void kl_ota_esp32_remote_service() {}
bool kl_ota_esp32_query(const char *, const char *, const char *, uint8_t, uint8_t, uint16_t, uint32_t, bool,
                        kl_ota_manifest_t *, char *, size_t, bool *) {
  return false;
}
bool kl_ota_esp32_install_full(const char *, const char *, const char *, const kl_ota_manifest_t *) { return false; }
bool kl_ota_esp32_fetch_patch(const char *, const char *, const char *, uint32_t) { return false; }

#endif  // KL_HAS_MQTT

#endif  // ESP32
