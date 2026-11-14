/**
 * Klinto KMesh_v1 — мост к клиенту (BLE GATT / USB-Serial / WebSocket).
 *
 * Телефон говорит по компактному бинарному протоколу. Кадры длиннее
 * текущего ATT MTU фрагментируются здесь; приложение видит только
 * целые сообщения.
 */
#ifndef KLINTO_BRIDGE_H
#define KLINTO_BRIDGE_H

#include "klinto_config.h"
#include "klinto_packet.h"
#include "klinto_flash_queue.h"
#include "klinto_router.h"
#include "klinto_net.h"

#define KL_CLIENT_MAGIC0 0x53  /* 'S' */
#define KL_CLIENT_MAGIC1 0x47  /* 'G' */
#define KL_CLIENT_VERSION 3
#define KL_CLIENT_HEADER_SIZE 9
#define KL_CLIENT_MAX_FRAME 2048

enum kl_client_frame_t : uint8_t {
  KL_CF_HELLO = 1,
  KL_CF_INFO = 2,
  KL_CF_RPC_UP = 3,
  KL_CF_RPC_DOWN = 4,
  KL_CF_STATUS = 5,
  KL_CF_CONFIG = 6,
  KL_CF_PING = 7,
  KL_CF_PONG = 8,
  KL_CF_LOG = 9,
  KL_CF_SYNC_ACK = 10,
  KL_CF_PROXY_UP = 11,
  KL_CF_PROXY_DOWN = 12,
  KL_CF_INET_STATUS = 13,
  KL_CF_SET_OWNER = 14
};

enum kl_client_flags_t : uint8_t {
  KL_CF_FLAG_FRAGMENT = 0x01,
  KL_CF_FLAG_URGENT = 0x02
};

/** RPC_UP: [dst_id u32][flags u8][msg_uuid u64][RPC bytes]. */
#define KL_CLIENT_UP_HEADER 13

class IClientLink {
 public:
  virtual ~IClientLink() {}
  virtual bool send(const uint8_t *data, size_t len) = 0;
  virtual bool connected() const = 0;
  /** ATT MTU (including the 3-byte header) or serial chunk size. */
  virtual uint16_t mtu() const = 0;
  virtual void poll(uint32_t now_ms) = 0;
  virtual void setReceiveCallback(kl_rx_callback_t cb, void *ctx) = 0;
  /** Human-readable transport name ("BLE", "USB", "WS"). */
  virtual const char *name() const = 0;
};

struct kl_bridge_sink_t {
  void *ctx;
  /** JSON config blob received from the app (Wi-Fi provisioning). */
  void (*config)(void *ctx, const char *json, size_t len);
  /** Log line for the app's serial/BLE console (may be null). */
  void (*log)(void *ctx, const char *text);
  /** Приложение сообщило статус интернета: мобильный шлюз вкл/выкл. */
  void (*inet_status)(void *ctx, bool has_internet, uint16_t rtt_ms, bool allow_relay);
  /** Проверка подписи Hub для смены владельца (ECDSA P-256). */
  bool (*verify_owner_claim)(void *ctx, const uint8_t digest[32], const uint8_t *sig,
                             size_t sig_len);
  /** Владелец подтверждён и сохранён: обновить BLE-имя и NODE_PRESENCE. */
  void (*owner_changed)(void *ctx, const char *prefix, uint32_t net_id, uint32_t epoch);
};

class KlintoClientBridge {
 public:
  KlintoClientBridge();
  void init(KlintoRouter *router, const kl_config_t *cfg, IClientLink *link,
            KlintoFlashQueue *outbox, const kl_bridge_sink_t *sink);

  /** Called by the runtime for every client frame received from the link. */
  void on_link_data(const uint8_t *data, size_t len);
  /** Called by the runtime for every packet delivered to this node. */
  void deliver_mesh(const kl_packet_t *pkt);
  /** Delivery state from the router/gateway. */
  void status(uint64_t msg_uuid, uint32_t packet_id, uint8_t status);
  /** Server confirmed permanent history (MSG_SYNCED). */
  void synced(uint64_t msg_uuid, uint32_t server_seq);

  void loop(uint32_t now_ms);
  bool send_info();
  /** Мобильный шлюз: отправить перехваченный пакет в приложение для отправки на Hub. */
  bool proxy_uplink(const kl_packet_t *pkt);
  uint16_t pending_outbox() const { return outbox_ ? outbox_->count() : 0; }

  static uint16_t crc16(const uint8_t *data, size_t len);

 private:
  void handle_frame(uint8_t type, uint8_t flags, const uint8_t *payload, size_t len);
  void handle_rpc_up(const uint8_t *payload, size_t len);
  void handle_config(const uint8_t *payload, size_t len);
  void handle_proxy_down(const uint8_t *payload, size_t len);
  void handle_inet_status(const uint8_t *payload, size_t len);
  void handle_set_owner(const uint8_t *payload, size_t len);
  bool send_frame(uint8_t type, const uint8_t *payload, size_t len, uint8_t flags = 0);
  /** Совместимость с текущим приложением: старый кадр A5 5A / JSON INFO. */
  bool send_legacy_frame(uint8_t type, const char *json, size_t len);
  void handle_legacy_frame(uint8_t type, const uint8_t *payload, size_t len);
  void flush_outbox();
  void log_line(const char *fmt, ...);

  struct FragSlot {
    bool used;
    uint8_t type;
    uint16_t total;
    uint16_t covered;
    uint32_t started_ms;
    uint8_t data[KL_CLIENT_MAX_FRAME];
  };

  struct StatusEvt {
    uint64_t msg_uuid;
    uint32_t packet_id;
    uint8_t status;
    uint8_t kind; /* 0 = status, 1 = sync_ack */
    uint32_t server_seq;
  };

  KlintoRouter *router_;
  kl_config_t cfg_;
  IClientLink *link_;
  KlintoFlashQueue *outbox_;
  kl_bridge_sink_t sink_;
  uint16_t seq_;
  FragSlot frags_[2];
  uint8_t rx_buf_[KL_CLIENT_MAX_FRAME];
  size_t rx_len_;
  uint32_t last_flush_ms_;
  StatusEvt statuses_[16];
  uint8_t status_head_;
  uint8_t status_tail_;
  KlintoLock tx_lock_;
  KlintoLock status_lock_;
  void queue_status(const StatusEvt &evt);
  void flush_statuses();
};

#endif  // KLINTO_BRIDGE_H
