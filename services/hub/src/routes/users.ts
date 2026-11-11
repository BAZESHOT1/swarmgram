/** Профиль, username (смена раз в 90 дней), поиск пользователей, квоты. */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { one, query, tx } from '../db.js';
import { verifyPassword } from '../crypto.js';
import { ensureKdfSalt } from './keys.js';
import { ApiError, badRequest, conflict, log, notFound, str, USERNAME_RE } from '../util.js';


/**
 * Личная квота не зависит от узлов: узел — добровольный вклад в общую
 * ёмкость сети (место для медиа и сообщений всех пользователей), а не
 * личное хранилище и не бонус к квоте.
 */
export async function effectiveQuota(_userId: string, baseQuota: number): Promise<number> {
  return baseQuota;
}

/** Поля аватара из строки users → публичный объект (или null). */
function avatarFrom(row: {
  avatar_object_id: string | null;
  avatar_key: string;
  avatar_mime: string;
}): { objectId: string; key: string; mime: string } | null {
  // Без ключа аватар бесполезен: показываем его только когда заданы все три поля.
  if (!row.avatar_object_id || !row.avatar_key || !row.avatar_mime) return null;
  return { objectId: row.avatar_object_id, key: row.avatar_key, mime: row.avatar_mime };
}

/** ISO-дата рождения: YYYY-MM-DD или null. */
function parseBirthday(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest('invalid_birthday');
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw badRequest('invalid_birthday');
  return value;
}

/** Ссылки профиля: не больше трёх, только http(s). */
function parseLinks(value: unknown): { label: string; url: string }[] {
  if (!Array.isArray(value)) throw badRequest('invalid_links');
  if (value.length > 3) throw badRequest('too_many_links');
  return value.map((item) => {
    const row = (item ?? {}) as { label?: unknown; url?: unknown };
    const label = str(row.label ?? '', 'link_label', { max: 40 });
    const url = str(row.url, 'link_url', { max: 200 });
    if (!/^https?:\/\//i.test(url)) throw badRequest('invalid_link_url');
    return { label, url };
  });
}

/** Типы элементов истории поиска. */
const SEARCH_HISTORY_TYPES = ['user', 'chat', 'group', 'channel', 'message'] as const;
type SearchHistoryType = (typeof SEARCH_HISTORY_TYPES)[number];

/** Аватар внутри элемента истории: те же поля и ограничения, что у /me/avatar. */
function parseSearchAvatar(value: unknown): { objectId: string; key: string; mime: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('invalid_search_avatar');
  const row = value as { objectId?: unknown; key?: unknown; mime?: unknown };
  const objectId = str(row.objectId, 'objectId', { max: 64 });
  const key = str(row.key, 'key', { min: 1, max: 300 });
  const mime = str(row.mime, 'mime', { min: 1, max: 120 });
  if (!/^image\//i.test(mime)) throw badRequest('invalid_avatar_mime');
  return { objectId, key, mime };
}

/**
 * История поиска: массив элементов. Лишние (сверх 20) отбрасываются,
 * неверные типы/поля — ошибка badRequest.
 */
function parseSearchHistory(value: unknown): {
  type: SearchHistoryType;
  id: string;
  title: string;
  subtitle?: string;
  username?: string;
  avatar: { objectId: string; key: string; mime: string } | null;
  at: string;
}[] {
  if (!Array.isArray(value)) throw badRequest('invalid_search_history');
  return value.slice(0, 20).map((item) => {
    const row = (item ?? {}) as {
      type?: unknown;
      id?: unknown;
      title?: unknown;
      subtitle?: unknown;
      username?: unknown;
      avatar?: unknown;
      at?: unknown;
    };
    if (typeof row.type !== 'string' || !(SEARCH_HISTORY_TYPES as readonly string[]).includes(row.type)) {
      throw badRequest('invalid_search_history_type');
    }
    const id = str(row.id, 'search_id', { min: 1, max: 200 });
    const title = str(row.title, 'title', { min: 1, max: 120 });
    // Необязательные строки: пустые значения просто не сохраняем.
    const subtitle =
      row.subtitle === undefined || row.subtitle === null || row.subtitle === ''
        ? ''
        : str(row.subtitle, 'subtitle', { max: 160 });
    const username =
      row.username === undefined || row.username === null || row.username === ''
        ? ''
        : str(row.username, 'username', { max: 64 });
    if (typeof row.at !== 'string' || Number.isNaN(Date.parse(row.at))) {
      throw badRequest('invalid_search_history_at');
    }
    const entry: {
      type: SearchHistoryType;
      id: string;
      title: string;
      subtitle?: string;
      username?: string;
      avatar: { objectId: string; key: string; mime: string } | null;
      at: string;
    } = {
      type: row.type as SearchHistoryType,
      id,
      title,
      avatar: parseSearchAvatar(row.avatar),
      at: new Date(row.at).toISOString(),
    };
    if (subtitle) entry.subtitle = subtitle;
    if (username) entry.username = username;
    return entry;
  });
}

const meRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------------------ me -- */
  app.get('/me', { onRequest: [requireAuth()] }, async (req, reply) => {
    const userId = req.auth!.userId;
    const user = await one<{
      id: string;
      email: string;
      username: string;
      display_name: string;
      plan: string;
      role: string;
      /** Статус аккаунта: active / disabled (не путать с profile_status). */
      status: string;
      /** Пользовательский статус из профиля (короткая строка). */
      profile_status: string;
      email_verified: boolean;
      quota_bytes: number;
      used_bytes: number;
      username_changed_at: string;
      created_at: string;
      account_pub: string;
      invite_privacy: string;
      node_online: boolean;
      module_online: boolean;
      avatar_object_id: string | null;
      avatar_key: string;
      avatar_mime: string;
      banner: string;
      links: unknown;
      location: string;
      birthday: string | null;
      last_seen_visibility: string;
      bio_visibility: string;
      theme_name: string;
      accent_name: string;
      locale: string;
      muted_chats: unknown;
      search_history: unknown;
    }>(
      // Обводки «онлайн»: есть ли у пользователя активный узел/ESP32-модуль.
      `SELECT id, email, username, display_name, plan, role, status, profile_status, email_verified,
              quota_bytes, used_bytes, username_changed_at, created_at, account_pub, invite_privacy,
              avatar_object_id, avatar_key, avatar_mime, banner, links, location,
              to_char(birthday, 'YYYY-MM-DD') AS birthday,
              last_seen_visibility, bio_visibility, theme_name, accent_name, locale, muted_chats,
              search_history,
              EXISTS (SELECT 1 FROM nodes n WHERE n.owner_id = users.id AND n.status = 'online') AS node_online,
              EXISTS (SELECT 1 FROM modules m WHERE m.owner_id = users.id AND m.status = 'online') AS module_online
         FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw notFound('user');

    const nextChangeAt = new Date(
      new Date(user.username_changed_at).getTime() + config.usernameChangeCooldownDays * 24 * 3600 * 1000,
    );

    const nodes = await query<{ id: string; name: string; status: string; free_bytes: number; capacity_bytes: number; reputation: number }>(
      `SELECT id, name, status, free_bytes, capacity_bytes, reputation FROM nodes WHERE owner_id = $1 ORDER BY registered_at DESC`,
      [userId],
    );
    const credits = await one<{ total: number }>(
      `SELECT COALESCE(SUM(amount),0) AS total FROM ledger WHERE user_id = $1`,
      [userId],
    );

    void reply.send({
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.display_name,
      plan: user.plan,
      role: user.role,
      // Публично показываем именно пользовательский статус; статус аккаунта
      // остаётся доступен отдельным полем для админ-логики и отладки.
      status: user.profile_status,
      accountStatus: user.status,
      emailVerified: user.email_verified,
      kdfSalt: await ensureKdfSalt(user.id),
      accountPub: user.account_pub,
      invitePrivacy: user.invite_privacy,
      // Расширенный профиль и синхронизируемые настройки.
      avatar: avatarFrom(user),
      banner: user.banner,
      links: Array.isArray(user.links) ? user.links : [],
      location: user.location,
      birthday: user.birthday,
      lastSeenVisibility: user.last_seen_visibility,
      bioVisibility: user.bio_visibility,
      themeName: user.theme_name,
      accentName: user.accent_name,
      locale: user.locale,
      mutedChats: Array.isArray(user.muted_chats) ? user.muted_chats : [],
      // История поиска синхронизируется между устройствами (последние 20).
      searchHistory: Array.isArray(user.search_history) ? user.search_history : [],
      createdAt: user.created_at,
      quotaBytes: await effectiveQuota(userId, user.quota_bytes),
      baseQuotaBytes: user.quota_bytes,
      nodeOnline: Boolean(user.node_online),
      moduleOnline: Boolean(user.module_online),
      usedBytes: user.used_bytes,
      credits: Number(credits?.total ?? 0),
      usernamePolicy: {
        value: user.username,
        canChangeAt: nextChangeAt.toISOString(),
        canChange: nextChangeAt.getTime() <= Date.now(),
        cooldownDays: config.usernameChangeCooldownDays,
      },
      nodes,
    });
  });

  /* ------------------------------------------------------- обновление ----- */
  app.patch('/me', { onRequest: [requireAuth()] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      displayName?: unknown;
      bio?: unknown;
      /** Короткий статус профиля: trim, максимум 80 символов. */
      status?: unknown;
      invitePrivacy?: unknown;
      links?: unknown;
      location?: unknown;
      birthday?: unknown;
      banner?: unknown;
      lastSeenVisibility?: unknown;
      bioVisibility?: unknown;
      themeName?: unknown;
      accentName?: unknown;
      locale?: unknown;
      mutedChats?: unknown;
      searchHistory?: unknown;
    };
    const sets: string[] = [];
    const params: unknown[] = [req.auth!.userId];

    // Обновляем только явно переданные поля.
    if (body.displayName !== undefined) {
      const displayName = str(body.displayName, 'displayName', { max: 64 });
      params.push(displayName);
      sets.push(`display_name = $${params.length}`);
    }
    if (body.bio !== undefined) {
      const bio = str(body.bio, 'bio', { max: 280 });
      params.push(bio);
      sets.push(`bio = $${params.length}`);
    }
    if (body.status !== undefined) {
      // Пустая строка допустима — это сброс статуса.
      const status = str(body.status, 'status', { max: 80 });
      params.push(status);
      sets.push(`profile_status = $${params.length}`);
    }
    // Кто может приглашать меня напрямую: everyone | shared | chat | nobody.
    if (body.invitePrivacy !== undefined) {
      const v = body.invitePrivacy;
      if (v !== 'everyone' && v !== 'shared' && v !== 'chat' && v !== 'nobody') throw badRequest('invalid_invite_privacy');
      params.push(v);
      sets.push(`invite_privacy = $${params.length}`);
    }
    if (body.links !== undefined) {
      params.push(JSON.stringify(parseLinks(body.links)));
      sets.push(`links = $${params.length}::jsonb`);
    }
    if (body.location !== undefined) {
      params.push(str(body.location, 'location', { max: 64 }));
      sets.push(`location = $${params.length}`);
    }
    if (body.birthday !== undefined) {
      params.push(parseBirthday(body.birthday));
      sets.push(`birthday = $${params.length}`);
    }
    if (body.banner !== undefined) {
      params.push(str(body.banner, 'banner', { max: 32 }));
      sets.push(`banner = $${params.length}`);
    }
    if (body.lastSeenVisibility !== undefined) {
      const v = body.lastSeenVisibility;
      if (v !== 'everyone' && v !== 'shared' && v !== 'nobody') throw badRequest('invalid_last_seen_visibility');
      params.push(v);
      sets.push(`last_seen_visibility = $${params.length}`);
    }
    if (body.bioVisibility !== undefined) {
      const v = body.bioVisibility;
      if (v !== 'everyone' && v !== 'chat') throw badRequest('invalid_bio_visibility');
      params.push(v);
      sets.push(`bio_visibility = $${params.length}`);
    }
    if (body.themeName !== undefined) {
      params.push(str(body.themeName, 'themeName', { max: 32 }));
      sets.push(`theme_name = $${params.length}`);
    }
    if (body.accentName !== undefined) {
      params.push(str(body.accentName, 'accentName', { max: 32 }));
      sets.push(`accent_name = $${params.length}`);
    }
    if (body.locale !== undefined) {
      params.push(str(body.locale, 'locale', { max: 16 }));
      sets.push(`locale = $${params.length}`);
    }
    if (body.mutedChats !== undefined) {
      if (!Array.isArray(body.mutedChats)) throw badRequest('invalid_muted_chats');
      const ids = body.mutedChats
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
        .slice(0, 200);
      params.push(JSON.stringify(ids));
      sets.push(`muted_chats = $${params.length}::jsonb`);
    }
    if (body.searchHistory !== undefined) {
      // Сохраняем как есть: ограничение в 20 элементов уже применил парсер.
      params.push(JSON.stringify(parseSearchHistory(body.searchHistory)));
      sets.push(`search_history = $${params.length}::jsonb`);
    }

    if (sets.length) {
      sets.push('updated_at = now()');
      await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
    }
    void reply.send({ ok: true });
  });

  /* ---------------------------------------------------- аватар профиля ---- */
  // Клиент шифрует файл (iv+ciphertext) и грузит его на узлы сам. Hub хранит
  // только objectId, ключ расшифровки (base64url) и mime — сам файл не видит.
  app.put('/me/avatar', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const body = (req.body ?? {}) as { objectId?: unknown; key?: unknown; mime?: unknown };
    const objectId = str(body.objectId, 'objectId', { max: 64 });
    const key = str(body.key, 'key', { min: 1, max: 300 });
    const mime = str(body.mime, 'mime', { min: 1, max: 120 });
    if (!/^image\//i.test(mime)) throw badRequest('invalid_avatar_mime');

    // Объект должен быть уже загружен (state='active') и принадлежать мне.
    const obj = await one<{ id: string }>(
      "SELECT id FROM objects WHERE id = $1 AND owner_id = $2 AND state = 'active'",
      [objectId, me],
    );
    if (!obj) throw notFound('object');

    await query(
      `UPDATE users
          SET avatar_object_id = $2, avatar_key = $3, avatar_mime = $4,
              avatar_updated_at = now(), updated_at = now()
        WHERE id = $1`,
      [me, objectId, key, mime],
    );
    log('info', 'avatar_updated', { userId: me, objectId });
    return reply.send({ avatar: { objectId, key, mime } });
  });

  app.delete('/me/avatar', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    await query(
      `UPDATE users
          SET avatar_object_id = NULL, avatar_key = '', avatar_mime = '',
              avatar_updated_at = now(), updated_at = now()
        WHERE id = $1`,
      [me],
    );
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------- удаление аккаунта ---- */
  app.delete('/me', { onRequest: [requireAuth()] }, async (req, reply) => {
    const userId = req.auth!.userId;
    const body = (req.body ?? {}) as { password?: unknown };
    // Пароль обязателен: удаление аккаунта — необратимая операция.
    const password = str(body.password, 'password', { min: 1, max: 200 });

    const user = await one<{ password_hash: string; username: string }>(
      'SELECT password_hash, username FROM users WHERE id = $1',
      [userId],
    );
    if (!user) throw notFound('user');
    if (!(await verifyPassword(password, user.password_hash))) {
      throw new ApiError(401, 'invalid_password', 'invalid_password');
    }

    await tx(async ({ query: q }) => {
      // Помечаем объекты удалёнными. Физическую очистку реплик с узлов делает
      // монитор по state='deleted'. Важно: objects.owner_id имеет ON DELETE CASCADE,
      // поэтому при удалении пользователя строки objects/fragments всё равно
      // исчезнут из БД (монитор их уже не увидит) — помечаем их best-effort.
      await q(
        `UPDATE objects SET state = 'deleted', deleted_at = now()
          WHERE owner_id = $1 AND state <> 'deleted'`,
        [userId],
      );
      await q(
        `UPDATE fragments f SET state = 'deleted'
           FROM objects o
          WHERE f.object_id = o.id AND o.owner_id = $1`,
        [userId],
      );

      // Журналируем до удаления: в audit_log нет FK на users, поэтому actor_id
      // сохранится как есть (даже если пользователь будет удалён).
      await q(
        'INSERT INTO audit_log (actor_id, action, target, meta) VALUES ($1,$2,$3,$4)',
        [userId, 'account_deleted', user.username, JSON.stringify({ username: user.username })],
      );

      // Каскад удалит devices, refresh_tokens, chat_members, messages, receipts,
      // objects, ledger и т.п. Чаты и узлы останутся с owner_id = NULL.
      await q('DELETE FROM users WHERE id = $1', [userId]);
    });

    log('info', 'account_deleted', { userId, username: user.username });
    return reply.send({ ok: true });
  });

  /* ---------------------------------------------------- смена username ---- */
  app.post('/me/username', { onRequest: [requireAuth()] }, async (req, reply) => {
    const userId = req.auth!.userId;
    const body = (req.body ?? {}) as { username?: string };
    const username = str(body.username, 'username').toLowerCase();
    if (!USERNAME_RE.test(username)) throw badRequest('invalid_username');

    const user = await one<{ username: string; username_changed_at: string }>(
      'SELECT username, username_changed_at FROM users WHERE id = $1',
      [userId],
    );
    if (!user) throw notFound('user');

    const changedAt = new Date(user.username_changed_at).getTime();
    const nextAt = changedAt + config.usernameChangeCooldownDays * 24 * 3600 * 1000;
    if (Date.now() < nextAt) {
      throw new (await import('../util.js')).ApiError(429, 'username_cooldown', 'username_can_be_changed_once_per_90_days', {
        nextChangeAt: new Date(nextAt).toISOString(),
      });
    }

    const taken = await one('SELECT 1 FROM users WHERE lower(username) = $1 AND id <> $2', [username, userId]);
    if (taken) throw conflict('username_taken');
    const reserved = await one(
      `SELECT 1 FROM username_history WHERE username = $1 AND changed_at > now() - interval '12 months' AND user_id <> $2`,
      [username, userId],
    );
    if (reserved) throw conflict('username_reserved');

    await query('UPDATE users SET username = $2, username_changed_at = now(), updated_at = now() WHERE id = $1', [
      userId,
      username,
    ]);
    await query('INSERT INTO username_history (user_id, username) VALUES ($1,$2)', [userId, username]);
    await query('INSERT INTO audit_log (actor_id, action, target) VALUES ($1,$2,$3)', [
      userId,
      'username_changed',
      username,
    ]);
    log('info', 'username_changed', { userId, from: user.username, to: username });
    void reply.send({ username, canChangeAt: new Date(Date.now() + config.usernameChangeCooldownDays * 24 * 3600 * 1000).toISOString() });
  });

  /* ------------------------------------------------------ поиск по имени -- */
  app.get('/users/search', { onRequest: [requireAuth()] }, async (req, reply) => {
    const q = String((req.query as { q?: string }).q ?? '').trim().toLowerCase();
    if (q.length < 2) return reply.send([]);
    const rows = await query<{
      id: string;
      username: string;
      display_name: string;
      node_online: boolean;
      module_online: boolean;
      avatar_object_id: string | null;
      avatar_key: string;
      avatar_mime: string;
    }>(
      `SELECT u.id, u.username, u.display_name,
              u.avatar_object_id, u.avatar_key, u.avatar_mime,
              EXISTS (SELECT 1 FROM nodes n WHERE n.owner_id = u.id AND n.status = 'online') AS node_online,
              EXISTS (SELECT 1 FROM modules m WHERE m.owner_id = u.id AND m.status = 'online') AS module_online
         FROM users u
        WHERE u.status = 'active' AND (u.username ILIKE $1 OR u.display_name ILIKE $1)
        ORDER BY u.username LIMIT 20`,
      [`${q}%`],
    );
    return reply.send(
      rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        avatar: avatarFrom(r),
        nodeOnline: Boolean(r.node_online),
        moduleOnline: Boolean(r.module_online),
      })),
    );
  });

  /* -------------------------------------------------- публичный профиль -- */
  app.get('/users/:username/profile', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { username } = req.params as { username: string };

    const target = await one<{
      id: string;
      username: string;
      display_name: string;
      /** Пользовательский статус — всегда публичный. */
      profile_status: string;
      bio: string;
      created_at: string;
      last_seen_at: string;
      device_online: boolean;
      node_online: boolean;
      module_online: boolean;
      avatar_object_id: string | null;
      avatar_key: string;
      avatar_mime: string;
      banner: string;
      links: unknown;
      location: string;
      birthday: string | null;
      last_seen_visibility: string;
      bio_visibility: string;
    }>(
      `SELECT u.id, u.username, u.display_name, u.profile_status, u.bio, u.created_at, u.last_seen_at,
              u.avatar_object_id, u.avatar_key, u.avatar_mime, u.banner, u.links, u.location,
              to_char(u.birthday, 'YYYY-MM-DD') AS birthday,
              u.last_seen_visibility, u.bio_visibility,
              EXISTS(
                SELECT 1 FROM devices d
                 WHERE d.user_id = u.id AND d.revoked_at IS NULL
                   AND d.last_seen_at > now() - interval '2 minutes'
              ) AS device_online,
              EXISTS (SELECT 1 FROM nodes n WHERE n.owner_id = u.id AND n.status = 'online') AS node_online,
              EXISTS (SELECT 1 FROM modules m WHERE m.owner_id = u.id AND m.status = 'online') AS module_online
         FROM users u
        WHERE lower(u.username) = lower($1)`,
      [username],
    );
    if (!target) throw notFound('user');

    const isSelf = target.id === me;

    const blockRows = await query<{ blocker_id: string }>(
      `SELECT blocker_id FROM user_blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)`,
      [me, target.id],
    );
    const blockedByMe = blockRows.some((r) => r.blocker_id === me);
    const blockedMe = blockRows.some((r) => r.blocker_id === target.id);

    // Общие чаты: для себя — все чаты, для другого — пересечение участников.
    const chats = await query<{ id: string; type: string; title: string; updated_at: string; members_count: number }>(
      `SELECT c.id, c.type, c.title, c.updated_at,
              (SELECT count(*) FROM chat_members m WHERE m.chat_id = c.id)::int AS members_count
         FROM chats c
         JOIN chat_members mine ON mine.chat_id = c.id AND mine.user_id = $1
        WHERE c.type IN ('direct','group','channel')
          AND c.blocked_reason IS NULL
          ${isSelf ? '' : 'AND EXISTS (SELECT 1 FROM chat_members other WHERE other.chat_id = c.id AND other.user_id = $2)'}
        ORDER BY c.updated_at DESC
        LIMIT 20`,
      isSelf ? [target.id] : [target.id, me],
    );

    // Для direct-чатов заголовок — имя собеседника.
    const directIds = chats.filter((c) => c.type === 'direct').map((c) => c.id);
    const peerNames = new Map<string, string>();
    if (directIds.length) {
      const peers = await query<{ chat_id: string; display_name: string; username: string }>(
        `SELECT cm.chat_id, u.display_name, u.username
           FROM chat_members cm JOIN users u ON u.id = cm.user_id
          WHERE cm.chat_id = ANY($1::uuid[]) AND cm.user_id <> $2`,
        [directIds, me],
      );
      for (const p of peers) peerNames.set(p.chat_id, p.display_name || p.username);
    }

    // Общий чат даёт доступ к «закрытому» био и времени последней активности.
    const hasSharedChat = isSelf || chats.length > 0;
    const bioVisibility = target.bio_visibility === 'chat' ? 'chat' : 'everyone';
    const showBio = isSelf || bioVisibility === 'everyone' || hasSharedChat;

    // Видимость «был(а) в сети»: online показываем как раньше, lastSeen — по правилам.
    const lastSeenVisibility =
      target.last_seen_visibility === 'shared' || target.last_seen_visibility === 'nobody'
        ? target.last_seen_visibility
        : 'everyone';
    const lastSeenAt =
      isSelf || lastSeenVisibility === 'everyone' || (lastSeenVisibility === 'shared' && hasSharedChat)
        ? new Date(target.last_seen_at).toISOString()
        : null;
    const online =
      Boolean(target.device_online) || new Date(target.last_seen_at).getTime() > Date.now() - 2 * 60 * 1000;

    return reply.send({
      userId: target.id,
      username: target.username,
      displayName: target.display_name,
      avatar: avatarFrom(target),
      banner: target.banner,
      // Статус — публичная информация и не зависит от настроек видимости био.
      status: target.profile_status,
      // Скрытые поля не раскрываем даже частично.
      bio: showBio ? target.bio : '',
      links: showBio && Array.isArray(target.links) ? target.links : [],
      location: showBio ? target.location : '',
      birthday: showBio ? target.birthday : null,
      bioVisibility,
      lastSeenVisibility,
      createdAt: new Date(target.created_at).toISOString(),
      online,
      nodeOnline: Boolean(target.node_online),
      moduleOnline: Boolean(target.module_online),
      lastSeenAt,
      isSelf,
      blockedByMe,
      blockedMe,
      sharedChats: chats.map((c) => ({
        id: c.id,
        type: c.type,
        title: c.type === 'direct' ? peerNames.get(c.id) ?? 'Диалог' : c.title,
        membersCount: c.members_count,
      })),
    });
  });

  /* ------------------------------------------------ блокировка (toggle) -- */
  app.post('/users/:username/block', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { username } = req.params as { username: string };
    const target = await one<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
    if (!target) throw notFound('user');
    if (target.id === me) throw badRequest('cannot_block_self');

    const existing = await one('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [me, target.id]);
    if (existing) {
      await query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [me, target.id]);
      return reply.send({ blocked: false });
    }
    await query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [me, target.id]);
    return reply.send({ blocked: true });
  });

  app.delete('/users/:username/block', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { username } = req.params as { username: string };
    const target = await one<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
    if (!target) throw notFound('user');
    await query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [me, target.id]);
    return reply.send({ blocked: false });
  });

  /* -------------------------------------------------------- жалоба ------- */
  app.post('/users/:username/report', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { username } = req.params as { username: string };
    const body = (req.body ?? {}) as { reason?: unknown; note?: unknown };
    const reason = str(body.reason, 'reason', { min: 1, max: 64 });
    const note = body.note === undefined ? '' : str(body.note, 'note', { max: 500 });

    const target = await one<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
    if (!target) throw notFound('user');
    if (target.id === me) throw badRequest('cannot_report_self');

    await query(
      'INSERT INTO user_reports (reporter_id, target_id, reason, note) VALUES ($1,$2,$3,$4)',
      [me, target.id, reason, note],
    );
    return reply.send({ ok: true });
  });

  /* -------------------------------------------------- заблокированные ----- */
  app.get('/me/blocked', { onRequest: [requireAuth()] }, async (req, reply) => {
    const rows = await query<{ user_id: string; username: string; display_name: string; blocked_at: string }>(
      `SELECT u.id AS user_id, u.username, u.display_name, b.created_at AS blocked_at
         FROM user_blocks b
         JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1
        ORDER BY b.created_at DESC`,
      [req.auth!.userId],
    );
    return reply.send(
      rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        blockedAt: new Date(r.blocked_at).toISOString(),
      })),
    );
  });

  /* ------------------------------------------------------ устройствы ------ */
  app.get('/me/devices', { onRequest: [requireAuth()] }, async (req, reply) => {
    const rows = await query<{ id: string; name: string; platform: string; created_at: string; last_seen_at: string }>(
      'SELECT id, name, platform, created_at, last_seen_at FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
      [req.auth!.userId],
    );
    return reply.send(rows);
  });

  app.delete('/me/devices/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND user_id = $2', [id, req.auth!.userId]);
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE device_id = $1', [id]);
    return reply.send({ ok: true });
  });
};

export default meRoutes;
