-- ============================================================
--  016: «сеть аккаунта» — единая скрытая Wi-Fi mesh-сеть
--  для всех модулей пользователя.
--
--  SSID и пароль генерирует Hub (crypto.randomBytes), клиент
--  и прошивка получают их только на чтение. Ротация увеличивает
--  revision: по нему прошивка/клиент понимают, что пароль устарел.
--
--  Пароль хранится в открытом виде осознанно: это общий PSK
--  mesh-сети, а не пользовательский секрет. Доступ к таблице —
--  только через requireAuth-маршруты /v1/modules/network*.
-- ============================================================
CREATE TABLE IF NOT EXISTS module_networks (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  network_id text NOT NULL,
  ssid text NOT NULL UNIQUE,
  password text NOT NULL,
  revision int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

-- network_id ищется модулями/логами при диагностике mesh.
CREATE INDEX IF NOT EXISTS module_networks_network_id_idx ON module_networks (network_id);
