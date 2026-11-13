#include "klinto_net.h"

#include <string.h>

KlintoRxRing::KlintoRxRing() : head_(0), tail_(0) { memset(frames_, 0, sizeof(frames_)); }

bool KlintoRxRing::push(const uint8_t *data, size_t len, int16_t rssi, uint8_t iface) {
  if (!data || len == 0 || len > KL_MAX_PACKET_SIZE) return false;
  const uint8_t head = head_.load(std::memory_order_relaxed);
  const uint8_t next = (uint8_t)((head + 1) % KL_RX_RING_SLOTS);
  if (next == tail_.load(std::memory_order_acquire)) return false; /* full */
  kl_rx_frame_t &slot = frames_[head];
  slot.len = (uint16_t)len;
  slot.rssi = rssi;
  slot.iface = iface;
  memcpy(slot.data, data, len);
  head_.store(next, std::memory_order_release);
  return true;
}

bool KlintoRxRing::pop(kl_rx_frame_t *out) {
  const uint8_t tail = tail_.load(std::memory_order_relaxed);
  if (!out || head_.load(std::memory_order_acquire) == tail) return false;
  *out = frames_[tail];
  tail_.store((uint8_t)((tail + 1) % KL_RX_RING_SLOTS), std::memory_order_release);
  return true;
}

bool KlintoRxRing::empty() const {
  return head_.load(std::memory_order_acquire) == tail_.load(std::memory_order_acquire);
}

uint16_t KlintoRxRing::peak() {
  const uint8_t head = head_.load(std::memory_order_acquire);
  const uint8_t tail = tail_.load(std::memory_order_acquire);
  return (uint16_t)((head + KL_RX_RING_SLOTS - tail) % KL_RX_RING_SLOTS);
}
