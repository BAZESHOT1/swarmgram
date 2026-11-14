#include "klinto_ota_patcher.h"
#include "klinto_util.h"

#include <string.h>

namespace {

struct PatchReader {
  const uint8_t *mem;
  size_t mem_len;
  kl_patch_read_patch_t cb;
  void *ctx;
  uint32_t pos;
};

bool pr_read(PatchReader *r, uint8_t *out, size_t len) {
  if (!r || !out) return false;
  if (r->mem) {
    if ((size_t)r->pos + len > r->mem_len) return false;
    memcpy(out, r->mem + r->pos, len);
  } else if (r->cb) {
    if (!r->cb(r->ctx, r->pos, out, len)) return false;
  } else {
    return false;
  }
  r->pos += (uint32_t)len;
  return true;
}

bool pr_u8(PatchReader *r, uint8_t *v) { return pr_read(r, v, 1); }

bool pr_u16(PatchReader *r, uint16_t *v) {
  uint8_t b[2];
  if (!pr_read(r, b, sizeof(b))) return false;
  *v = (uint16_t)(b[0] | ((uint16_t)b[1] << 8));
  return true;
}

bool pr_u32(PatchReader *r, uint32_t *v) { return pr_read(r, (uint8_t *)v, 4); }

struct MemoryTarget {
  uint8_t *out;
  size_t cap;
  size_t pos;
};

bool mem_write(void *ctx, const uint8_t *data, size_t len) {
  MemoryTarget *t = (MemoryTarget *)ctx;
  if (!t || !data) return false;
  if (t->pos + len > t->cap) return false;
  memcpy(t->out + t->pos, data, len);
  t->pos += len;
  return true;
}

struct MemoryBase {
  const uint8_t *base;
  size_t len;
};

bool mem_read(void *ctx, uint32_t offset, uint8_t *out, size_t len) {
  MemoryBase *b = (MemoryBase *)ctx;
  if (!b || !b->base || (size_t)offset + len > b->len) return false;
  memcpy(out, b->base + offset, len);
  return true;
}

}  // namespace

bool kl_patch_parse_header(const uint8_t *patch, size_t len, kl_patch_header_t *out) {
  if (!patch || !out || len < KL_PATCH_HEADER_SIZE) return false;
  uint32_t magic = 0;
  memcpy(&magic, patch, 4);
  if (magic != KL_PATCH_MAGIC) return false;
  if (patch[4] != KL_PATCH_VERSION) return false;
  memcpy(&out->base_size, patch + 5, 4);
  memcpy(&out->target_size, patch + 9, 4);
  memcpy(out->target_sha256, patch + 13, 32);
  return out->target_size > 0 && out->target_size <= (64u * 1024u * 1024u);
}

bool kl_patch_apply_stream(const uint8_t *patch, size_t patch_len,
                           kl_patch_read_base_t read_base, void *base_ctx,
                           kl_patch_write_target_t write_target, void *target_ctx,
                           kl_patch_read_patch_t read_patch, void *patch_ctx,
                           uint8_t out_sha[32]) {
  if (!read_base || !write_target || (!patch && !read_patch)) return false;
  if (patch && patch_len < KL_PATCH_HEADER_SIZE) return false;

  PatchReader reader;
  memset(&reader, 0, sizeof(reader));
  reader.mem = patch;
  reader.mem_len = patch_len;
  reader.cb = read_patch;
  reader.ctx = patch_ctx;

  uint8_t header[KL_PATCH_HEADER_SIZE];
  if (!pr_read(&reader, header, sizeof(header))) return false;
  kl_patch_header_t hdr;
  if (!kl_patch_parse_header(header, sizeof(header), &hdr)) return false;

  KlintoSha256 sha;
  kl_sha256_init(&sha);
  uint32_t written = 0;
  uint8_t buf[KL_PATCH_BUFFER];
  bool ok = true;

  while (ok) {
    uint8_t op = 0;
    if (!pr_u8(&reader, &op)) {
      ok = false;
      break;
    }
    if (op == KL_PATCH_OP_END) break;
    if (op == KL_PATCH_OP_COPY) {
      uint32_t offset = 0;
      uint32_t length = 0;
      if (!pr_u32(&reader, &offset) || !pr_u32(&reader, &length)) {
        ok = false;
        break;
      }
      if (length == 0 || (uint64_t)offset + length > hdr.base_size ||
          (uint64_t)written + length > hdr.target_size) {
        ok = false;
        break;
      }
      uint32_t left = length;
      while (left && ok) {
        const uint32_t take = left > sizeof(buf) ? (uint32_t)sizeof(buf) : left;
        if (!read_base(base_ctx, offset, buf, take)) {
          ok = false;
          break;
        }
        if (!write_target(target_ctx, buf, take)) {
          ok = false;
          break;
        }
        kl_sha256_update(&sha, buf, take);
        offset += take;
        written += take;
        left -= take;
      }
    } else if (op == KL_PATCH_OP_ADD) {
      uint16_t length = 0;
      if (!pr_u16(&reader, &length) || length == 0 ||
          (uint64_t)written + length > hdr.target_size) {
        ok = false;
        break;
      }
      uint32_t left = length;
      while (left && ok) {
        const uint32_t take = left > sizeof(buf) ? (uint32_t)sizeof(buf) : left;
        if (!pr_read(&reader, buf, take)) {
          ok = false;
          break;
        }
        if (!write_target(target_ctx, buf, take)) {
          ok = false;
          break;
        }
        kl_sha256_update(&sha, buf, take);
        written += take;
        left -= take;
      }
    } else {
      ok = false;
    }
  }

  if (!ok || written != hdr.target_size) return false;
  uint8_t digest[32];
  kl_sha256_final(&sha, digest);
  uint8_t diff = 0;
  for (uint8_t i = 0; i < 32; ++i) diff |= (uint8_t)(digest[i] ^ hdr.target_sha256[i]);
  if (diff != 0) return false;
  if (out_sha) memcpy(out_sha, digest, 32);
  return true;
}

bool kl_patch_apply_memory(const uint8_t *base, size_t base_len, const uint8_t *patch,
                           size_t patch_len, uint8_t *out, size_t out_cap, size_t *out_len,
                           uint8_t out_sha[32]) {
  if (!base || !patch || !out) return false;
  MemoryBase b = {base, base_len};
  MemoryTarget t = {out, out_cap, 0};
  const bool ok = kl_patch_apply_stream(patch, patch_len, mem_read, &b, mem_write, &t, nullptr,
                                        nullptr, out_sha);
  if (ok && out_len) *out_len = t.pos;
  return ok;
}
