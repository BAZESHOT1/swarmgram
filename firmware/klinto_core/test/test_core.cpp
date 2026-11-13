/**
 * Host-тесты портируемого ядра Klinto.
 * Сборка: firmware/klinto_core/run_tests.ps1
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "klinto_util.h"
#include "klinto_config.h"
#include "klinto_packet.h"
#include "klinto_codec.h"
#include "klinto_crypto.h"
#include "klinto_dedup.h"
#include "klinto_router.h"
#include "klinto_flash_queue.h"
#include "klinto_gateway.h"
#include "klinto_bridge.h"
#include "klinto_channel_plan.h"
#include "klinto_cell.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    ++g_checks;                                                              \
    if (!(cond)) {                                                           \
      ++g_failures;                                                          \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                 \
    }                                                                        \
  } while (0)

static void hex(const uint8_t *in, size_t len, char *out) {
  kl_hex_encode(in, len, out, len * 2 + 1, false);
}

static void test_sha_hmac(void) {
  uint8_t digest[32];
  char text[65];
  kl_sha256("abc", 3, digest);
  hex(digest, 32, text);
  CHECK(!strcmp(text, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));

  const uint8_t key[20] = {0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b,
                           0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b};
  const char *data = "Hi There";
  kl_hmac_sha256(key, sizeof(key), (const uint8_t *)data, strlen(data), digest);
  hex(digest, 32, text);
  CHECK(!strcmp(text, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"));
}

static void test_chacha(void) {
  uint8_t key[32];
  uint8_t nonce[12] = {0};
  for (int i = 0; i < 32; ++i) key[i] = (uint8_t)i;
  nonce[3] = 0x09;
  nonce[7] = 0x4a;
  uint8_t zeros[64] = {0};
  uint8_t out[64];
  kl_chacha20_xor(key, nonce, 1, zeros, out, sizeof(out));
  char text[129];
  hex(out, 64, text);
  /* RFC 8439 В§2.3.2 keystream block for counter = 1. */
  CHECK(!strcmp(text,
                "10f1e7e4d13b5915500fdd1fa32071c4"
                "c7d1f4c733c068030422aa9ac3d46c4e"
                "d2826446079faa0914c2d705d98b02a2"
                "b5129cd1de164eb9cbd083e8a2503c4e"));
}

static void test_packet(void) {
  kl_packet_t pkt;
  kl_packet_init(&pkt, KL_TYPE_DATA, 0x11111111u, 0x22222222u, KL_BROADCAST_ID,
                 KL_FLAG_NEED_ACK | KL_FLAG_TO_INTERNET);
  pkt.msg_uuid = 0x0123456789abcdefULL;
  const char payload[] = "hello";
  CHECK(kl_packet_set_payload(&pkt, payload, sizeof(payload)));
  uint8_t wire[KL_MAX_PACKET_SIZE];
  const size_t n = kl_packet_serialize(&pkt, wire, sizeof(wire));
  CHECK(n == KL_PACKET_HEADER_SIZE + sizeof(payload) + 2);
  kl_packet_t parsed;
  CHECK(kl_packet_parse(wire, n, &parsed));
  CHECK(parsed.src_id == pkt.src_id);
  CHECK(parsed.msg_uuid == pkt.msg_uuid);
  CHECK(parsed.payload_len == sizeof(payload));
  CHECK(!memcmp(parsed.payload, payload, sizeof(payload)));

  wire[KL_PACKET_HEADER_SIZE] ^= 0x01;
  CHECK(!kl_packet_parse(wire, n, &parsed));

  kl_packet_header_t h;
  CHECK(kl_packet_parse_header(wire, n, &h) == false);
}

static void test_codec(void) {
  const char *en = "hello, meet me at the station at 8pm";
  const char *ru = "\xd0\x9f\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82, "
                   "\xd0\xb2\xd1\x81\xd1\x82\xd1\x80\xd0\xb5\xd1\x87\xd0\xb0\xd0\xb5\xd0\xbc\xd1\x81\xd1\x8f "
                   "\xd0\xb2 8 \xd0\xb2\xd0\xb5\xd1\x87\xd0\xb5\xd1\x80\xd0\xb0";
  uint8_t buf[KL_MAX_PAYLOAD];
  for (int round = 0; round < 2; ++round) {
    const char *text = round == 0 ? en : ru;
    const size_t len = strlen(text);
    const size_t n = kl_codec_encode_text(buf, sizeof(buf), 42, text, len, 0);
    CHECK(n > 0);
    CHECK(buf[0] == KL_RPC_SEND_TEXT);
    if (n) {
      printf("  codec round %d: %u -> %u bytes (compressed=%d)\n", round, (unsigned)len,
             (unsigned)n, (buf[1] & KL_RPC_FLAG_COMPRESSED) ? 1 : 0);
    }
    kl_rpc_text_t out;
    char decoded[KL_MAX_TEXT + 1];
    CHECK(kl_codec_decode_text(buf, n, &out, decoded, sizeof(decoded)));
    CHECK(!strcmp(decoded, text));
    if (round == 0) CHECK(n < len);
  }

  uint8_t ack[16];
  const size_t an = kl_codec_encode_ack(ack, sizeof(ack), 7, 0xDEADBEEF, KL_STATUS_RECEIVED);
  CHECK(an == 9);
  CHECK(kl_read_le32(ack + 4) == 0xDEADBEEF);
  CHECK(ack[8] == KL_STATUS_RECEIVED);
}

static uint8_t g_key[32];
static int g_signer_calls = 0;

static bool test_signer(void *ctx, const uint8_t digest[32], uint8_t *sig, size_t *sig_len) {
  (void)ctx;
  (void)digest;
  memset(sig, 0xAB, 64);
  *sig_len = 64;
  ++g_signer_calls;
  return true;
}

static void test_crypto(void) {
  for (int i = 0; i < 32; ++i) g_key[i] = (uint8_t)(i * 7 + 1);
  const char plain[] = "secret mesh message";
  kl_crypto_aad_t aad;
  memset(&aad, 0, sizeof(aad));
  aad.packet_id = 0x10203040;
  aad.msg_uuid = 0x1122334455667788ULL;
  aad.src_id = 7;
  aad.dst_id = 9;
  aad.type = KL_TYPE_DATA;
  aad.flags = KL_FLAG_TEMP_MESH_KEY;
  aad.payload_len = sizeof(plain);

  uint8_t sealed[128];
  size_t sealed_len = 0;
  CHECK(kl_crypto_seal(g_key, &aad, (const uint8_t *)plain, sizeof(plain), KL_TEMP_TAG_LEN,
                       sealed, sizeof(sealed), &sealed_len));
  CHECK(sealed_len == KL_CRYPTO_HDR_LEN + sizeof(plain) + KL_TEMP_TAG_LEN);
  uint8_t opened[128];
  size_t opened_len = 0;
  CHECK(kl_crypto_open(g_key, sealed, sealed_len, &aad, opened, sizeof(opened), &opened_len));
  CHECK(opened_len == sizeof(plain));
  CHECK(!memcmp(opened, plain, sizeof(plain)));

  sealed[sealed_len - 1] ^= 0x80;
  CHECK(!kl_crypto_open(g_key, sealed, sealed_len, &aad, opened, sizeof(opened), &opened_len));
  sealed[sealed_len - 1] ^= 0x80;

  /* AAD tampering must fail too. */
  aad.dst_id = 10;
  CHECK(!kl_crypto_open(g_key, sealed, sealed_len, &aad, opened, sizeof(opened), &opened_len));
  aad.dst_id = 9;

  kl_crypto_set_signers(test_signer, NULL, NULL);
  uint8_t sig[64];
  size_t sig_len = 0;
  CHECK(kl_crypto_sign_perm(aad.msg_uuid, 7, 9, 1700000000000ULL, sealed, sealed_len, sig,
                            &sig_len));
  CHECK(sig_len == 64);
  CHECK(g_signer_calls == 1);
}

static void test_dedup(void) {
  KlintoDedup d;
  CHECK(!d.seen_or_add(1, 100, 1000));
  CHECK(d.seen_or_add(1, 100, 1001));
  CHECK(!d.seen_or_add(1, 101, 1001));
  CHECK(!d.seen_or_add(2, 100, 1001));
  /* Expiry: the same pair is accepted again after the TTL. */
  CHECK(!d.seen_or_add(1, 100, 1000 + KL_DEDUP_TTL_MS + 5));
}

/* ---------------------------------------------------------- router -------- */

struct FakeWorld {
  kl_packet_t sent[64];
  uint8_t sent_iface[64];
  uint32_t sent_next[64];
  int sent_count;
  int delivered;
  uint8_t last_status;
  uint64_t last_status_uuid;
  int archives;
};

static bool fake_send(void *ctx, const kl_packet_t *pkt, uint8_t iface, uint32_t next_hop) {
  FakeWorld *w = (FakeWorld *)ctx;
  if (w->sent_count >= 64) return false;
  w->sent[w->sent_count] = *pkt;
  w->sent_iface[w->sent_count] = iface;
  w->sent_next[w->sent_count] = next_hop;
  w->sent_count++;
  return true;
}

static void fake_deliver(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface) {
  (void)pkt;
  (void)rssi;
  (void)iface;
  ((FakeWorld *)ctx)->delivered++;
}

static void fake_status(void *ctx, uint64_t msg_uuid, uint32_t packet_id, uint8_t status) {
  (void)packet_id;
  FakeWorld *w = (FakeWorld *)ctx;
  w->last_status = status;
  w->last_status_uuid = msg_uuid;
}

static void fake_archive(void *ctx, const kl_packet_t *pkt) {
  (void)pkt;
  ((FakeWorld *)ctx)->archives++;
}

static void test_router_direct(void) {
  kl_config_t cfg;
  kl_config_defaults(&cfg);
  cfg.node_id = 11;
  cfg.role = KL_ROLE_CLIENT;
  cfg.espnow_enabled = true;
  cfg.lora_present = false;

  FakeWorld world;
  memset(&world, 0, sizeof(world));
  kl_router_sink_t sink = {&world, fake_send, fake_deliver, fake_status, fake_archive, NULL, NULL};

  KlintoRouter r;
  r.init(&cfg, &sink);

  kl_packet_t pkt;
  kl_packet_init(&pkt, KL_TYPE_DATA, 0, 22, 0, KL_FLAG_NEED_ACK);
  pkt.msg_uuid = 0xABCDEF;
  const char body[] = "ping";
  kl_packet_set_payload(&pkt, body, sizeof(body));

  /* Первая попытка запускает AODV: узел 22 отвечает RREP, после чего
   * отложенный DATA сразу уходит по найденному маршруту. */
  CHECK(r.send(&pkt, 1000));
  kl_packet_t rreq;
  bool have_rreq = false;
  for (int i = 0; i < world.sent_count; ++i) {
    if (world.sent[i].type == KL_TYPE_RREQ) {
      rreq = world.sent[i];
      have_rreq = true;
    }
  }
  CHECK(have_rreq);

  FakeWorld world2;
  memset(&world2, 0, sizeof(world2));
  kl_config_t cfg2 = cfg;
  cfg2.node_id = 22;
  kl_router_sink_t sink2 = {&world2, fake_send, fake_deliver, fake_status, fake_archive, NULL, NULL};
  KlintoRouter r2;
  r2.init(&cfg2, &sink2);
  r2.on_packet(&rreq, KL_IFACE_ESPNOW, -55, 1002);
  CHECK(world2.sent_count == 1);
  CHECK(world2.sent[0].type == KL_TYPE_RREP);
  r.on_packet(&world2.sent[0], KL_IFACE_ESPNOW, -55, 1003);

  /* DATA was flushed to the newly learned route. */
  kl_packet_t data;
  bool have_data = false;
  for (int i = 0; i < world.sent_count; ++i) {
    if (world.sent[i].type == KL_TYPE_DATA) {
      data = world.sent[i];
      have_data = true;
    }
  }
  CHECK(have_data);
  r2.on_packet(&data, KL_IFACE_ESPNOW, -55, 1005);
  CHECK(world2.delivered == 1);
  CHECK(world2.sent_count == 2);
  CHECK(world2.sent[1].type == KL_TYPE_ACK);

  r.on_packet(&world2.sent[1], KL_IFACE_ESPNOW, -55, 1010);
  CHECK(world.last_status == KL_STATUS_DELIVERED_TO_PEER);
  CHECK(world.last_status_uuid == 0xABCDEF);
}

static void test_router_route_discovery(void) {
  /* A(1) --- B(2) --- C(3), no route known. A wants C. */
  kl_config_t cfg;
  kl_config_defaults(&cfg);
  cfg.node_id = 11;
  cfg.role = KL_ROLE_ROUTER;

  FakeWorld wa, wb, wc;
  memset(&wa, 0, sizeof(wa));
  memset(&wb, 0, sizeof(wb));
  memset(&wc, 0, sizeof(wc));
  kl_router_sink_t sa = {&wa, fake_send, fake_deliver, fake_status, fake_archive, NULL, NULL};
  kl_router_sink_t sb = {&wb, fake_send, fake_deliver, fake_status, fake_archive, NULL, NULL};
  kl_router_sink_t sc = {&wc, fake_send, fake_deliver, fake_status, fake_archive, NULL, NULL};
  KlintoRouter a, b, c;
  a.init(&cfg, &sa);
  cfg.node_id = 12;
  b.init(&cfg, &sb);
  cfg.node_id = 13;
  c.init(&cfg, &sc);

  kl_packet_t pkt;
  kl_packet_init(&pkt, KL_TYPE_DATA, 0, 13, 0, KL_FLAG_NEED_ACK);
  pkt.msg_uuid = 0x1111;
  const char body[] = "to c";
  kl_packet_set_payload(&pkt, body, sizeof(body));
  a.send(&pkt, 2000);

  /* A emitted an RREQ broadcast. */
  bool saw_rreq = false;
  for (int i = 0; i < wa.sent_count; ++i) {
    if (wa.sent[i].type == KL_TYPE_RREQ) saw_rreq = true;
  }
  CHECK(saw_rreq);

  /* B hears RREQ (hop 0), schedules a rebroadcast via RSSI backoff. */
  kl_packet_t rreq;
  for (int i = 0; i < wa.sent_count; ++i) {
    if (wa.sent[i].type == KL_TYPE_RREQ) rreq = wa.sent[i];
  }
  b.on_packet(&rreq, KL_IFACE_ESPNOW, -80, 2001);
  b.tick(2001 + 200);
  bool relayed = false;
  for (int i = 0; i < wb.sent_count; ++i) {
    if (wb.sent[i].type == KL_TYPE_RREQ) relayed = true;
  }
  CHECK(relayed);

  /* C hears the relayed RREQ, answers with RREP. */
  kl_packet_t relayed_req;
  for (int i = 0; i < wb.sent_count; ++i) {
    if (wb.sent[i].type == KL_TYPE_RREQ) relayed_req = wb.sent[i];
  }
  c.on_packet(&relayed_req, KL_IFACE_ESPNOW, -70, 2020);
  bool rrep = false;
  for (int i = 0; i < wc.sent_count; ++i) {
    if (wc.sent[i].type == KL_TYPE_RREP) rrep = true;
  }
  CHECK(rrep);

  /* B forwards the RREP to A, A learns the route and flushes the pending data. */
  kl_packet_t reply;
  for (int i = 0; i < wc.sent_count; ++i) {
    if (wc.sent[i].type == KL_TYPE_RREP) reply = wc.sent[i];
  }
  b.on_packet(&reply, KL_IFACE_ESPNOW, -70, 2030);
  for (int i = 0; i < wb.sent_count; ++i) {
  }
  for (int i = 0; i < wb.sent_count; ++i) {
    if (wb.sent[i].type == KL_TYPE_RREP) reply = wb.sent[i];
  }
  a.on_packet(&reply, KL_IFACE_ESPNOW, -70, 2040);

  const kl_route_entry_t *route = a.route(13);
  CHECK(route != NULL);
  if (route) {
    CHECK(route->next_hop_id == 12);
    CHECK(route->hops == 2);
  }
  bool data_sent = false;
  kl_packet_t data_from_a;
  for (int i = 0; i < wa.sent_count; ++i) {
    if (wa.sent[i].type == KL_TYPE_DATA && wa.sent[i].dst_id == 13) {
      data_sent = true;
      data_from_a = wa.sent[i];
    }
  }
  CHECK(data_sent);

  /* End-to-end ACK через два прыжка C -> B -> A. Именно для этого нужен
   * last_hop_id: иначе ретранслированный DATA в LoRa не найдёт обратный путь. */
  b.on_packet(&data_from_a, KL_IFACE_ESPNOW, -70, 2050);
  kl_packet_t data_from_b;
  bool b_forwarded = false;
  for (int i = 0; i < wb.sent_count; ++i) {
    if (wb.sent[i].type == KL_TYPE_DATA && wb.sent[i].dst_id == 13) {
      b_forwarded = true;
      data_from_b = wb.sent[i];
    }
  }
  CHECK(b_forwarded);
  c.on_packet(&data_from_b, KL_IFACE_ESPNOW, -72, 2060);
  CHECK(wc.delivered == 1);

  kl_packet_t ack_from_c;
  bool c_acked = false;
  for (int i = 0; i < wc.sent_count; ++i) {
    if (wc.sent[i].type == KL_TYPE_ACK && wc.sent[i].dst_id == 11) {
      c_acked = true;
      ack_from_c = wc.sent[i];
    }
  }
  CHECK(c_acked);
  CHECK(ack_from_c.next_hop_id == 12);
  b.on_packet(&ack_from_c, KL_IFACE_ESPNOW, -70, 2070);
  kl_packet_t ack_from_b;
  bool b_forwarded_ack = false;
  for (int i = 0; i < wb.sent_count; ++i) {
    if (wb.sent[i].type == KL_TYPE_ACK && wb.sent[i].dst_id == 11) {
      b_forwarded_ack = true;
      ack_from_b = wb.sent[i];
    }
  }
  CHECK(b_forwarded_ack);
  CHECK(ack_from_b.next_hop_id == 11);
  a.on_packet(&ack_from_b, KL_IFACE_ESPNOW, -70, 2080);
  CHECK(wa.last_status == KL_STATUS_DELIVERED_TO_PEER);
}

static void test_gateway_gradient(void) {
  kl_config_t gwcfg;
  kl_config_defaults(&gwcfg);
  gwcfg.node_id = 100;
  gwcfg.role = KL_ROLE_GATEWAY;

  FakeWorld wg, wr, wc;
  memset(&wg, 0, sizeof(wg));
  memset(&wr, 0, sizeof(wr));
  memset(&wc, 0, sizeof(wc));
  kl_router_sink_t sg = {&wg, fake_send, fake_deliver, fake_status, fake_archive, NULL, NULL};
  kl_router_sink_t sr = {&wr, fake_send, fake_deliver, fake_status, fake_archive, NULL, NULL};
  kl_router_sink_t sc = {&wc, fake_send, fake_deliver, fake_status, fake_archive, NULL, NULL};
  KlintoRouter g, r, c;
  g.init(&gwcfg, &sg);

  kl_config_t rcfg = gwcfg;
  rcfg.node_id = 50;
  rcfg.role = KL_ROLE_ROUTER;
  r.init(&rcfg, &sr);

  kl_config_t ccfg = gwcfg;
  ccfg.node_id = 7;
  ccfg.role = KL_ROLE_CLIENT;
  c.init(&ccfg, &sc);

  g.emit_gateway_beacon(3000);
  kl_packet_t beacon;
  for (int i = 0; i < wg.sent_count; ++i) {
    if (wg.sent[i].type == KL_TYPE_GW_BEACON) beacon = wg.sent[i];
  }
  r.on_packet(&beacon, KL_IFACE_ESPNOW, -50, 3001);
  CHECK(r.gateway_route()->valid);
  CHECK(r.gateway_route()->hops == 0);
  CHECK(r.gateway_route()->next_hop_id == 100);

  r.tick(3001 + 200);  // RSSI -50 -> long backoff
  kl_packet_t relayed_beacon;
  bool relayed = false;
  for (int i = 0; i < wr.sent_count; ++i) {
    if (wr.sent[i].type == KL_TYPE_GW_BEACON) {
      relayed = true;
      relayed_beacon = wr.sent[i];
    }
  }
  CHECK(relayed);
  CHECK(relayed_beacon.hop_count == 1);

  c.on_packet(&relayed_beacon, KL_IFACE_ESPNOW, -75, 3250);
  CHECK(c.gateway_route()->valid);
  CHECK(c.gateway_route()->hops == 1);
  CHECK(c.gateway_route()->next_hop_id == 50);

  /* Client sends an uplink message; it must go to its gateway next hop. */
  kl_packet_t up;
  kl_packet_init(&up, KL_TYPE_DATA, 0, KL_ANY_GATEWAY_ID, 0,
                 KL_FLAG_TO_INTERNET | KL_FLAG_NEED_ACK | KL_FLAG_NEED_CLOUD_ARCHIVE);
  up.msg_uuid = 0x777;
  kl_packet_set_payload(&up, "up", 2);
  int before = wc.sent_count;
  c.send(&up, 3300);
  CHECK(wc.sent_count > before);
  CHECK(wc.sent_next[before] == 50);
  CHECK(wc.sent[before].dst_id == KL_ANY_GATEWAY_ID);

  /* Gateway archives a message it overhears even when addressed to a peer. */
  kl_packet_t overheard;
  kl_packet_init(&overheard, KL_TYPE_DATA, 7, 8, KL_BROADCAST_ID,
                 KL_FLAG_NEED_CLOUD_ARCHIVE);
  overheard.msg_uuid = 0x888;
  kl_packet_set_payload(&overheard, "x", 1);
  g.on_packet(&overheard, KL_IFACE_ESPNOW, -60, 3400);
  CHECK(wg.archives == 1);
}

/* ------------------------------------------------------- flash queue ----- */

struct MemStorage {
  uint8_t data[40000];
  uint32_t len;
};

static bool mem_read(void *ctx, uint32_t off, void *buf, size_t len) {
  MemStorage *m = (MemStorage *)ctx;
  if (off + len > sizeof(m->data)) return false;
  memcpy(buf, m->data + off, len);
  return true;
}
static bool mem_write(void *ctx, uint32_t off, const void *buf, size_t len) {
  MemStorage *m = (MemStorage *)ctx;
  if (off + len > sizeof(m->data)) return false;
  memcpy(m->data + off, buf, len);
  if (off + len > m->len) m->len = off + (uint32_t)len;
  return true;
}
static bool mem_size(void *ctx, uint32_t *out) {
  *out = ((MemStorage *)ctx)->len;
  return true;
}
static bool mem_truncate(void *ctx, uint32_t size) {
  MemStorage *m = (MemStorage *)ctx;
  if (size > sizeof(m->data)) return false;
  if (size > m->len) memset(m->data + m->len, 0, size - m->len);
  m->len = size;
  return true;
}

static void test_flash_queue(void) {
  static MemStorage storage;
  memset(&storage, 0, sizeof(storage));
  kl_storage_ops_t ops = {&storage, mem_read, mem_write, mem_size, mem_truncate};
  KlintoFlashQueue q;
  CHECK(q.init(&ops));
  CHECK(q.empty());

  for (int i = 0; i < KL_FLASH_SLOTS + 5; ++i) {
    kl_packet_t pkt;
    kl_packet_init(&pkt, KL_TYPE_DATA, 11, 22, KL_BROADCAST_ID, 0);
    pkt.msg_uuid = (uint64_t)(i + 1);
    uint8_t body[4];
    kl_write_le32(body, (uint32_t)i);
    kl_packet_set_payload(&pkt, body, sizeof(body));
    CHECK(q.push(&pkt));
  }
  CHECK(q.count() == KL_FLASH_SLOTS);

  kl_packet_t out;
  CHECK(q.peek(&out));
  /* Oldest surviving record is i = 5. */
  CHECK(kl_read_le32(out.payload) == 5);
  int seen = 0;
  while (q.pop(&out)) {
    if (seen == 0) CHECK(kl_read_le32(out.payload) == 5);
    ++seen;
  }
  CHECK(seen == KL_FLASH_SLOTS);
  CHECK(q.empty());

  /* Re-open: the header must survive. */
  KlintoFlashQueue q2;
  CHECK(q2.init(&ops));
  CHECK(q2.empty());
}

/* ------------------------------------------------------- bridge E2E ------ */

struct FakeLink : public IClientLink {
  uint8_t out[8192];
  size_t out_len;
  bool conn;
  uint16_t m;
  kl_rx_callback_t cb;
  void *cb_ctx;
  FakeLink() : out_len(0), conn(true), m(250), cb(nullptr), cb_ctx(nullptr) {
    memset(out, 0, sizeof(out));
  }
  bool send(const uint8_t *data, size_t len) override {
    if (!conn || out_len + len > sizeof(out)) return false;
    memcpy(out + out_len, data, len);
    out_len += len;
    return true;
  }
  bool connected() const override { return conn; }
  uint16_t mtu() const override { return m; }
  void poll(uint32_t) override {}
  void setReceiveCallback(kl_rx_callback_t c, void *ctx) override {
    cb = c;
    cb_ctx = ctx;
  }
  const char *name() const override { return "TEST"; }
};

struct BridgeCtx {
  KlintoClientBridge *bridge;
  uint8_t last_status;
  uint64_t last_uuid;
  int frames;
};

static size_t build_client_frame(uint8_t *out, uint8_t type, const uint8_t *payload, size_t len) {
  out[0] = KL_CLIENT_MAGIC0;
  out[1] = KL_CLIENT_MAGIC1;
  out[2] = KL_CLIENT_VERSION;
  out[3] = type;
  out[4] = 0;
  kl_write_le16(out + 5, 1);
  kl_write_le16(out + 7, (uint16_t)len);
  memcpy(out + KL_CLIENT_HEADER_SIZE, payload, len);
  const uint16_t crc = kl_crc16(out + 2, KL_CLIENT_HEADER_SIZE - 2 + len, 0xFFFF);
  kl_write_le16(out + KL_CLIENT_HEADER_SIZE + len, crc);
  return KL_CLIENT_HEADER_SIZE + len + 2;
}

struct BridgeWorld {
  FakeWorld world;
  BridgeCtx bridge_ctx;
};

static bool bw_send(void *ctx, const kl_packet_t *pkt, uint8_t iface, uint32_t next_hop) {
  return fake_send(&((BridgeWorld *)ctx)->world, pkt, iface, next_hop);
}
static void bw_deliver(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface) {
  BridgeWorld *w = (BridgeWorld *)ctx;
  fake_deliver(&w->world, pkt, rssi, iface);
  if (w->bridge_ctx.bridge) w->bridge_ctx.bridge->deliver_mesh(pkt);
}
static void bw_status(void *ctx, uint64_t uuid, uint32_t pid, uint8_t status) {
  BridgeWorld *w = (BridgeWorld *)ctx;
  w->bridge_ctx.last_status = status;
  w->bridge_ctx.last_uuid = uuid;
  w->bridge_ctx.frames++;
  if (w->bridge_ctx.bridge) w->bridge_ctx.bridge->status(uuid, pid, status);
}
static void bw_archive(void *ctx, const kl_packet_t *pkt) {
  fake_archive(&((BridgeWorld *)ctx)->world, pkt);
}

static void test_bridge_e2e(void) {
  kl_config_t cfg;
  kl_config_defaults(&cfg);
  cfg.node_id = 11;
  cfg.role = KL_ROLE_CLIENT;
  for (int i = 0; i < 32; ++i) cfg.temp_mesh_key[i] = (uint8_t)(0x40 + i);
  cfg.has_temp_key = true;

  BridgeWorld bwa, bwb;
  memset(&bwa, 0, sizeof(bwa));
  memset(&bwb, 0, sizeof(bwb));
  kl_router_sink_t sa = {&bwa, bw_send, bw_deliver, bw_status, bw_archive, NULL, NULL};
  kl_router_sink_t sb = {&bwb, bw_send, bw_deliver, bw_status, bw_archive, NULL, NULL};

  KlintoRouter ra, rb;
  FakeLink la, lb;
  KlintoFlashQueue qa, qb;
  ra.init(&cfg, &sa);
  ra.seed_route(22, 22, KL_IFACE_ESPNOW, 1, -50, 5000);

  kl_config_t cfg2 = cfg;
  cfg2.node_id = 22;
  rb.init(&cfg2, &sb);

  KlintoClientBridge ba, bb;
  kl_bridge_sink_t sink = {nullptr, nullptr, nullptr};
  ba.init(&ra, &cfg, &la, &qa, &sink);
  bb.init(&rb, &cfg2, &lb, &qb, &sink);
  bwa.bridge_ctx.bridge = &ba;
  bwb.bridge_ctx.bridge = &bb;

  const char *text = "hello from the phone";
  uint8_t rpc[64];
  const size_t rpc_len = kl_codec_encode_text(rpc, sizeof(rpc), 7, text, strlen(text), 0);
  uint8_t up[128];
  kl_write_le32(up, 22);
  up[4] = 0;
  kl_write_le64(up + 5, 0x123456789ULL);
  memcpy(up + KL_CLIENT_UP_HEADER, rpc, rpc_len);
  const size_t up_len = KL_CLIENT_UP_HEADER + rpc_len;

  uint8_t frame[256];
  const size_t frame_len = build_client_frame(frame, KL_CF_RPC_UP, up, up_len);
  ba.on_link_data(frame, frame_len);

  /* Router A should now hold an encrypted DATA frame for node 22. */
  kl_packet_t data;
  bool have = false;
  for (int i = 0; i < bwa.world.sent_count; ++i) {
    if (bwa.world.sent[i].type == KL_TYPE_DATA) {
      data = bwa.world.sent[i];
      have = true;
    }
  }
  CHECK(have);
  CHECK(data.flags & KL_FLAG_TEMP_MESH_KEY);
  CHECK(kl_crypto_is_envelope(data.payload, data.payload_len));

  /* Node 22 decrypts and forwards a transparent RPC to its app. */
  rb.on_packet(&data, KL_IFACE_ESPNOW, -55, 5010);
  CHECK(lb.out_len > 0);
  CHECK(lb.out[3] == KL_CF_RPC_DOWN);
  const uint16_t plen = (uint16_t)(lb.out[7] | ((uint16_t)lb.out[8] << 8));
  kl_packet_t down;
  CHECK(kl_packet_parse(lb.out + KL_CLIENT_HEADER_SIZE, plen, &down));
  CHECK(!(down.flags & KL_FLAG_TEMP_MESH_KEY));
  kl_rpc_text_t rpc_out;
  char decoded[KL_MAX_TEXT + 1];
  CHECK(kl_codec_decode_text(down.payload, down.payload_len, &rpc_out, decoded, sizeof(decoded)));
  CHECK(!strcmp(decoded, text));

  /* Router B emitted an L3 ACK; feed it back to A and expect DELIVERED. */
  CHECK(bwb.world.sent_count >= 1);
  ra.on_packet(&bwb.world.sent[0], KL_IFACE_ESPNOW, -55, 5020);
  CHECK(bwa.bridge_ctx.last_status == KL_STATUS_DELIVERED_TO_PEER);
  CHECK(bwa.bridge_ctx.last_uuid == 0x123456789ULL);
}

/* ---------------------------------------------------------- gateway ----- */

struct FakeTransport : public IGatewayTransport {
  char up[1024];
  size_t up_len;
  uint8_t down[KL_MAX_PACKET_SIZE];
  size_t down_len;
  bool conn;
  FakeTransport() : up_len(0), down_len(0), conn(true) { memset(up, 0, sizeof(up)); }
  bool connect() override {
    conn = true;
    return true;
  }
  void disconnect() override { conn = false; }
  bool connected() const override { return conn; }
  bool publish(const char *topic, const uint8_t *data, size_t len) override {
    (void)topic;
    if (!conn || len >= sizeof(up)) return false;
    memcpy(up, data, len);
    up[len] = '\0';
    up_len = len;
    return true;
  }
  int read(char *topic, size_t tcap, uint8_t *data, size_t dcap) override {
    if (!down_len) return 0;
    if (down_len > dcap || tcap < 8) return -1;
    memcpy(topic, "down", 5);
    memcpy(data, down, down_len);
    const int n = (int)down_len;
    down_len = 0;
    return n;
  }
  void loop() override {}
};

struct GatewayCtx {
  int injected;
  kl_packet_t last;
};

static bool gw_inject(void *ctx, const kl_packet_t *pkt) {
  GatewayCtx *c = (GatewayCtx *)ctx;
  c->last = *pkt;
  c->injected++;
  return true;
}

static void test_gateway(void) {
  kl_config_t cfg;
  kl_config_defaults(&cfg);
  cfg.node_id = 100;
  cfg.role = KL_ROLE_GATEWAY;
  cfg.gateway_id = 100;

  FakeTransport t;
  KlintoFlashQueue q;
  GatewayCtx ctx = {0, {}};
  kl_gateway_sink_t sink = {&ctx, gw_inject, nullptr};
  KlintoGateway gw;
  gw.init(&cfg, &t, &q, &sink);

  kl_packet_t pkt;
  kl_packet_init(&pkt, KL_TYPE_DATA, 7, 8, KL_BROADCAST_ID, KL_FLAG_NEED_CLOUD_ARCHIVE);
  pkt.msg_uuid = 0x0102030405060708ULL;
  kl_packet_set_payload(&pkt, "abc", 3);
  CHECK(gw.publish_archive(&pkt, -70, KL_IFACE_LORA, 6000));
  CHECK(t.up_len > 0);
  CHECK(strstr(t.up, "\"kind\":\"mesh_archive\"") != nullptr);
  CHECK(strstr(t.up, "\"msg_uuid\":\"0102030405060708\"") != nullptr);
  CHECK(strstr(t.up, "\"packet_b64\":\"") != nullptr);

  /* Downlink: server sends a raw MeshPacket on the down topic. */
  kl_packet_t down;
  kl_packet_init(&down, KL_TYPE_DATA, 8, 7, KL_BROADCAST_ID, 0);
  down.msg_uuid = 0x99;
  kl_packet_set_payload(&down, "dl", 3);
  t.down_len = kl_packet_serialize(&down, t.down, sizeof(t.down));
  gw.loop(6100);
  CHECK(ctx.injected == 1);
  CHECK(ctx.last.flags & KL_FLAG_FROM_INTERNET);
  CHECK(ctx.last.msg_uuid == 0x99);
}

/* ------------------------------------------------------ channel plan ----- */

static void test_channel_plan(void) {
  for (uint8_t band = KL_BAND_433; band <= KL_BAND_868; ++band) {
    uint32_t prev = 0;
    for (uint8_t ch = 1; ch <= KL_CHANNEL_COUNT; ++ch) {
      const kl_channel_plan_entry_t *e = kl_channel_plan_entry(ch, band);
      CHECK(e != NULL);
      if (!e) continue;
      CHECK(e->wifi_channel == ch);
      CHECK(e->lora_bw_khz == 125);
      CHECK(e->lora_sync_word == (uint8_t)(0x10 + ch));
      if (prev) CHECK(e->lora_freq_hz - prev >= e->lora_bw_khz * 1000u);
      prev = e->lora_freq_hz;
    }
  }
  for (uint8_t ch = 1; ch <= KL_CHANNEL_COUNT; ++ch) {
    const kl_channel_plan_entry_t *a = kl_channel_plan_entry(ch, KL_BAND_868);
    for (uint8_t other = (uint8_t)(ch + 1); other <= KL_CHANNEL_COUNT; ++other) {
      const kl_channel_plan_entry_t *b = kl_channel_plan_entry(other, KL_BAND_868);
      CHECK(a->lora_freq_hz != b->lora_freq_hz);
      CHECK(a->lora_sync_word != b->lora_sync_word);
    }
  }
  kl_config_t cfg;
  kl_config_defaults(&cfg);
  cfg.lora.freq_mhz = 869.525f;
  CHECK(kl_channel_plan_apply(&cfg, 5));
  CHECK(cfg.wifi_channel == 5);
  CHECK(cfg.lora.freq_mhz > 868.0f);
  CHECK(kl_channel_plan_nearest(cfg.lora.freq_mhz) == 5);
  CHECK(!kl_channel_plan_apply(&cfg, 0));
  CHECK(!kl_channel_plan_apply(&cfg, 14));
}

/* ----------------------------------------------------------- cell -------- */

struct CellHostState {
  uint8_t applied;
  uint8_t locked_channel;
  uint32_t locked_gateway;
  uint8_t offline_channel;
  int locked;
  int offline;
};

static bool cell_apply(void *ctx, uint8_t channel) {
  ((CellHostState *)ctx)->applied = channel;
  return true;
}
static void cell_locked(void *ctx, uint8_t channel, uint32_t gateway_id, int16_t rssi,
                        uint8_t hops, uint8_t reason) {
  (void)rssi;
  (void)hops;
  (void)reason;
  CellHostState *s = (CellHostState *)ctx;
  s->locked_channel = channel;
  s->locked_gateway = gateway_id;
  s->locked++;
}
static void cell_offline(void *ctx, uint8_t channel) {
  CellHostState *s = (CellHostState *)ctx;
  s->offline_channel = channel;
  s->offline++;
}

static void test_cell_manager(void) {
  kl_config_t cfg;
  kl_config_defaults(&cfg);
  cfg.role = KL_ROLE_CLIENT;
  cfg.wifi_channel = 1;
  cfg.lora.freq_mhz = 869.525f;

  CellHostState host;
  memset(&host, 0, sizeof(host));
  kl_cell_host_t callbacks = {&host, cell_apply, cell_locked, cell_offline};
  KlintoCellManager cell;
  cell.init(&cfg, &callbacks);

  cell.start_scan(0, KL_SCAN_BOOT);
  CHECK(cell.scanning());
  CHECK(cell.scan_channel() == 1);

  /* Сканируем 1..13; лучший сигнал — канал 3, восьмой — хуже. */
  for (uint8_t ch = 1; ch <= KL_CHANNEL_COUNT; ++ch) {
    if (ch > 1) cell.tick((uint32_t)(ch - 1) * 450u);
    const int16_t rssi = ch == 3 ? -55 : (ch == 7 ? -80 : -100);
    cell.on_beacon(2000u + ch, 1, rssi, (uint32_t)(ch - 1) * 450u);
  }
  cell.tick(KL_CHANNEL_COUNT * 450u);
  CHECK(cell.state() == KL_CELL_LOCKED);
  CHECK(cell.channel() == 3);
  CHECK(host.locked == 1);
  CHECK(host.locked_channel == 3);
  CHECK(host.locked_gateway == 2003u);

  /* Два слабых маяка подряд запускают хэндовер. */
  cell.on_beacon(2003u, 1, -95, 6000);
  cell.on_beacon(2003u, 1, -96, 6001);
  CHECK(cell.scanning());

  for (uint8_t ch = 1; ch <= KL_CHANNEL_COUNT; ++ch) {
    if (ch > 1) cell.tick(6001u + (uint32_t)(ch - 1) * 450u);
    const int16_t rssi = ch == 7 ? -60 : -100;
    cell.on_beacon(3000u + ch, 1, rssi, 6001u + (uint32_t)(ch - 1) * 450u);
  }
  cell.tick(6001u + KL_CHANNEL_COUNT * 450u);
  CHECK(cell.state() == KL_CELL_LOCKED);
  CHECK(cell.channel() == 7);
  CHECK(host.locked_channel == 7);

  /* Ни одного шлюза: после двух полных циклов — аварийный канал 1. */
  KlintoCellManager offline;
  CellHostState off_host;
  memset(&off_host, 0, sizeof(off_host));
  kl_cell_host_t off_cb = {&off_host, cell_apply, cell_locked, cell_offline};
  offline.init(&cfg, &off_cb);
  offline.start_scan(0, KL_SCAN_BOOT);
  uint32_t now = 0;
  for (int i = 0; i < 2 * KL_CHANNEL_COUNT + 4; ++i) {
    now += 450;
    offline.tick(now);
  }
  CHECK(offline.state() == KL_CELL_OFFLINE);
  CHECK(offline.channel() == KL_FALLBACK_OFFLINE_CHANNEL);
  CHECK(off_host.offline >= 1);
  CHECK(off_host.offline_channel == KL_FALLBACK_OFFLINE_CHANNEL);

  /* Шлюз не сканирует: канал фиксируется по Wi-Fi AP. */
  kl_config_t gw_cfg = cfg;
  gw_cfg.role = KL_ROLE_GATEWAY;
  CellHostState gw_host;
  memset(&gw_host, 0, sizeof(gw_host));
  kl_cell_host_t gw_cb = {&gw_host, cell_apply, cell_locked, cell_offline};
  KlintoCellManager gw;
  gw.init(&gw_cfg, &gw_cb);
  gw.lock_gateway(9, 100);
  gw.tick(999999);
  CHECK(gw.state() == KL_CELL_LOCKED);
  CHECK(gw.channel() == 9);
  CHECK(gw_host.applied == 9);
}

int main(void) {
  setbuf(stdout, NULL);
  printf("Klinto mesh core tests\n");
  test_sha_hmac();
  test_chacha();
  test_packet();
  test_codec();
  test_crypto();
  test_dedup();
  test_router_direct();
  test_router_route_discovery();
  test_gateway_gradient();
  test_flash_queue();
  test_bridge_e2e();
  test_gateway();
  test_channel_plan();
  test_cell_manager();
  printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures ? 1 : 0;
}
