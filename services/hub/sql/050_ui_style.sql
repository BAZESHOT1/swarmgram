-- Стиль интерфейса: glass (по умолчанию) или flat (монотонный, без полупрозрачности).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_style text NOT NULL DEFAULT 'glass';
-- Постоянная ссылка-приглашение публичной группы/канала (одна на чат, без срока и лимита).
ALTER TABLE chat_invite_links ADD COLUMN IF NOT EXISTS permanent boolean NOT NULL DEFAULT false;
