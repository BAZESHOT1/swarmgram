-- Настройки push-уведомлений: скрытие отправителя и текста.

ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_hide_content boolean NOT NULL DEFAULT false;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS hide_content boolean NOT NULL DEFAULT false;
