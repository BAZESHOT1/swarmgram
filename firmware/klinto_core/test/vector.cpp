#include <stdio.h>
#include <string.h>
#include "klinto_crypto.h"
#include "klinto_util.h"

int main() {
  uint8_t key[32];
  for (int i = 0; i < 32; ++i) key[i] = (uint8_t)(i + 1);
  kl_crypto_aad_t aad;
  memset(&aad, 0, sizeof(aad));
  aad.packet_id = 0x01020304;
  aad.msg_uuid = 0x1122334455667788ULL;
  aad.src_id = 0x0000000b;
  aad.dst_id = 0x00000016;
  aad.type = 1;
  aad.flags = 0x29;
  aad.payload_len = 2 + 13 + 4;
  const uint8_t plain[] = "hello mesh v3";
  uint8_t out[128];
  size_t out_len = 0;
  kl_crypto_seal(key, &aad, plain, sizeof(plain) - 1, KL_TEMP_TAG_LEN, out, sizeof(out), &out_len);
  char hex[257];
  kl_hex_encode(out, out_len, hex, sizeof(hex), false);
  printf("SEALED=%s\n", hex);
  uint8_t digest[32];
  kl_crypto_perm_digest(aad.msg_uuid, aad.src_id, aad.dst_id, 1700000000000ULL, plain,
                        sizeof(plain) - 1, digest);
  kl_hex_encode(digest, 32, hex, sizeof(hex), false);
  printf("DIGEST=%s\n", hex);
  return 0;
}
