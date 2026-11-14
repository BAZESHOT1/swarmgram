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

namespace {

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
  return esp_ota_set_boot_partition(g_target) == ESP_OK;
}

void abort_target(void *) {
  if (g_ota) {
    esp_ota_abort(g_ota);
    g_ota = 0;
  }
}

void reboot(void *) { esp_restart(); }

void mark_valid(void *) { esp_ota_mark_app_valid_cancel_rollback(); }

}  // namespace

bool kl_ota_esp32_verify_pubkey(const uint8_t digest[32], const uint8_t *sig, size_t sig_len) {
  return verify_signature(nullptr, digest, sig, sig_len);
}

bool kl_ota_esp32_begin() {
  if (!LittleFS.begin(true)) return false;
  if (!LittleFS.exists("/ota")) LittleFS.mkdir("/ota");
  return true;
}

const kl_ota_platform_t *kl_ota_esp32_platform() {
  static kl_ota_platform_t platform = {
      nullptr, patch_write, patch_read, patch_erase, read_running, begin_target,
      write_target, commit_target, abort_target, reboot, verify_signature, mark_valid,
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
                         "Accept: application/json\r\nConnection: close\r\n\r\n",
                         url.path, url.host, token ? token : "");
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
                         "Connection: close\r\n\r\n",
                         url.path, url.host, token ? token : "");
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
                         "Connection: close\r\n\r\n",
                         url.path, url.host, token ? token : "");
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

}  // namespace

bool kl_ota_esp32_sync(const char *hub_url, const char *module_token, uint8_t chip_arch,
                       uint16_t current_build, kl_ota_manifest_t *out) {
  if (!hub_url || !module_token || !out) return false;
  HttpUrl url;
  if (!parseHttpUrl(hub_url, &url)) return false;
  const char *chip_name = chip_arch == 2 ? "esp32c3"
                          : chip_arch == 3 ? "esp32s3"
                          : chip_arch == 4 ? "esp32c6"
                                           : "esp32";
  char path[160];
  snprintf(path, sizeof(path), "/v1/kmesh/v1/ota/latest?chip=%s&base_build=%u", chip_name,
           (unsigned)current_build);
  strncpy(url.path, path, sizeof(url.path) - 1);
  char body[1024];
  if (httpGet(url, module_token, body, sizeof(body)) <= 0) return false;
  bool is_full = false;
  (void)kl_json_get_bool(body, "full", &is_full);
  uint32_t base_build = 0, target_build = 0, total_chunks = 0, patch_size = 0, patch_id = 0;
  if (!kl_json_get_uint(body, "base_build", &base_build) ||
      !kl_json_get_uint(body, "target_build", &target_build) ||
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

#else

bool kl_ota_esp32_sync(const char *, const char *, uint8_t, uint16_t, kl_ota_manifest_t *) {
  return false;
}

#endif  // KL_HAS_MQTT

#endif  // ESP32
