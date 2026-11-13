#include "klinto_flash_queue.h"

#include <string.h>

#define KL_FLASH_MAGIC 0x33515753u  /* "SWQ3" little-endian */
#define KL_FLASH_VERSION 3
#define KL_FLASH_HEADER_OFFSET 0
#define KL_FLASH_DATA_OFFSET sizeof(kl_flash_header_t)

KlintoFlashQueue::KlintoFlashQueue() : ready_(false) {
  memset(&ops_, 0, sizeof(ops_));
  memset(&header_, 0, sizeof(header_));
}

bool KlintoFlashQueue::read_header() {
  return ops_.read(ops_.ctx, KL_FLASH_HEADER_OFFSET, &header_, sizeof(header_));
}

bool KlintoFlashQueue::write_header() {
  return ops_.write(ops_.ctx, KL_FLASH_HEADER_OFFSET, &header_, sizeof(header_));
}

bool KlintoFlashQueue::read_slot(uint16_t index, kl_flash_slot_t *slot) const {
  if (index >= KL_FLASH_SLOTS || !slot) return false;
  const uint32_t off = KL_FLASH_DATA_OFFSET + (uint32_t)index * sizeof(kl_flash_slot_t);
  return ops_.read(ops_.ctx, off, slot, sizeof(*slot));
}

bool KlintoFlashQueue::write_slot(uint16_t index, const kl_flash_slot_t *slot) {
  if (index >= KL_FLASH_SLOTS || !slot) return false;
  const uint32_t off = KL_FLASH_DATA_OFFSET + (uint32_t)index * sizeof(kl_flash_slot_t);
  return ops_.write(ops_.ctx, off, slot, sizeof(*slot));
}

bool KlintoFlashQueue::format() {
  uint32_t size = 0;
  const uint32_t need = KL_FLASH_DATA_OFFSET + KL_FLASH_SLOTS * sizeof(kl_flash_slot_t);
  if (ops_.size && ops_.size(ops_.ctx, &size) && size < need) {
    if (ops_.truncate) ops_.truncate(ops_.ctx, need);
  }
  memset(&header_, 0, sizeof(header_));
  header_.magic = KL_FLASH_MAGIC;
  header_.version = KL_FLASH_VERSION;
  header_.slots = KL_FLASH_SLOTS;
  header_.seq = 0;
  header_.count = 0;
  header_.head = 0;
  if (!write_header()) return false;
  /* Zero the first slot so a torn write is detectable by its crc. */
  kl_flash_slot_t empty;
  memset(&empty, 0, sizeof(empty));
  write_slot(0, &empty);
  return true;
}

bool KlintoFlashQueue::init(const kl_storage_ops_t *ops) {
  if (!ops || !ops->read || !ops->write) return false;
  KlintoGuard guard(lock_);
  ops_ = *ops;
  ready_ = false;
  if (!read_header()) return false;
  if (header_.magic != KL_FLASH_MAGIC || header_.version != KL_FLASH_VERSION ||
      header_.slots != KL_FLASH_SLOTS || header_.head >= KL_FLASH_SLOTS ||
      header_.count > KL_FLASH_SLOTS) {
    if (!format()) return false;
  }
  ready_ = true;
  return true;
}

bool KlintoFlashQueue::push(const kl_packet_t *pkt) {
  if (!pkt || !ready_) return false;
  const size_t wire = kl_packet_wire_size(pkt);
  if (!wire || wire > KL_FLASH_SLOT_DATA) return false;
  KlintoGuard guard(lock_);

  kl_flash_slot_t slot;
  memset(&slot, 0, sizeof(slot));
  slot.len = (uint16_t)wire;
  if (!kl_packet_serialize(pkt, slot.data, sizeof(slot.data))) return false;
  slot.crc = kl_crc16(slot.data, wire, 0xFFFF);

  if (!write_slot(header_.head, &slot)) return false;
  header_.head = (uint16_t)((header_.head + 1) % KL_FLASH_SLOTS);
  if (header_.count < KL_FLASH_SLOTS) header_.count++;
  header_.seq++;
  return write_header();
}

bool KlintoFlashQueue::peek(kl_packet_t *out) const {
  if (!out || !ready_ || header_.count == 0) return false;
  KlintoGuard guard(lock_);
  const uint16_t oldest =
      (uint16_t)((header_.head + KL_FLASH_SLOTS - header_.count) % KL_FLASH_SLOTS);
  kl_flash_slot_t slot;
  if (!read_slot(oldest, &slot)) return false;
  if (slot.len == 0 || slot.len > KL_FLASH_SLOT_DATA) return false;
  if (kl_crc16(slot.data, slot.len, 0xFFFF) != slot.crc) return false;
  return kl_packet_parse(slot.data, slot.len, out);
}

bool KlintoFlashQueue::pop(kl_packet_t *out) {
  if (!ready_ || header_.count == 0) return false;
  KlintoGuard guard(lock_);
  const uint16_t oldest =
      (uint16_t)((header_.head + KL_FLASH_SLOTS - header_.count) % KL_FLASH_SLOTS);
  kl_flash_slot_t slot;
  if (read_slot(oldest, &slot) && slot.len > 0 && slot.len <= KL_FLASH_SLOT_DATA &&
      kl_crc16(slot.data, slot.len, 0xFFFF) == slot.crc) {
    if (out) kl_packet_parse(slot.data, slot.len, out);
  }
  header_.count--;
  return write_header();
}

bool KlintoFlashQueue::empty() const {
  KlintoGuard guard(lock_);
  return header_.count == 0;
}

uint16_t KlintoFlashQueue::count() const {
  KlintoGuard guard(lock_);
  return header_.count;
}

void KlintoFlashQueue::clear() {
  KlintoGuard guard(lock_);
  header_.count = 0;
  header_.head = 0;
  header_.seq = 0;
  write_header();
}
