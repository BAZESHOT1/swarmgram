/**
 * Платформенный рандом: web — crypto.getRandomValues; нативные платформы —
 * тот же интерфейс после полифилла react-native-get-random-values,
 * который импортируется в нативной точке входа (index.native.tsx).
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(out);
    return out;
  }
  // запасной вариант (на практике срабатывать не должен)
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}
