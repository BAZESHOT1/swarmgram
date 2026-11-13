/**
 * Klinto KMesh_v1 — энергонезависимый кольцевой буфер.
 *
 * 100 фиксированных слотов по 260 байт (~26 КБ) в LittleFS.
 * Постоянный размер исключает фрагментацию кучи, а восстановление
 * после сбоя сводится к чтению заголовка и проверке CRC слота.
 */
#ifndef KLINTO_FLASH_QUEUE_H
#define KLINTO_FLASH_QUEUE_H

#include "klinto_util.h"
#include "klinto_packet.h"

#define KL_FLASH_SLOTS 100
#define KL_FLASH_SLOT_DATA 256

struct kl_storage_ops_t {
  void *ctx;
  bool (*read)(void *ctx, uint32_t offset, void *buf, size_t len);
  bool (*write)(void *ctx, uint32_t offset, const void *buf, size_t len);
  bool (*size)(void *ctx, uint32_t *out_size);
  bool (*truncate)(void *ctx, uint32_t size);
};

struct KL_PACKED kl_flash_header_t {
  uint32_t magic;
  uint16_t version;
  uint16_t slots;
  uint32_t seq;   /* total pushes, monotonically increasing */
  uint16_t count; /* valid slots */
  uint16_t head;  /* next write index */
  uint8_t reserved[4];
};

struct KL_PACKED kl_flash_slot_t {
  uint16_t len;
  uint16_t crc;
  uint8_t data[KL_FLASH_SLOT_DATA];
};

class KlintoFlashQueue {
 public:
  KlintoFlashQueue();
  bool init(const kl_storage_ops_t *ops);
  bool push(const kl_packet_t *pkt);
  bool peek(kl_packet_t *out) const;
  bool pop(kl_packet_t *out);
  bool empty() const;
  uint16_t count() const;
  void clear();
  /** One-shot format used when the header magic/version is wrong. */
  bool format();

 private:
  bool read_header();
  bool write_header();
  bool read_slot(uint16_t index, kl_flash_slot_t *slot) const;
  bool write_slot(uint16_t index, const kl_flash_slot_t *slot);

  kl_storage_ops_t ops_;
  kl_flash_header_t header_;
  bool ready_;
  mutable KlintoLock lock_;
};

#endif  // KLINTO_FLASH_QUEUE_H
