/** Чаты: создание (direct/group), участники, раздача ключей чата (только шифротексты ключей). */
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { uuid } from '../crypto.js';
import { one, query, tx } from '../db.js';
import { publish, publishMany } from '../realtime.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { ApiError, badRequest, conflict, forbidden, log, notFound, rateLimit, str } from '../util.js';

/** Через сколько дней серверный ключ чата ротируется автоматически. */
const KEY_ROTATION_DAYS = 30;

type ChatEncryption = 'server' | 'e2e';

/* ------------------------------------------------------- видимость/роли --- */

export type ChatVisibility = 'public' | 'closed' | 'private';
export type ChatRole = 'owner' | 'admin' | 'moderator' | 'member';

/** Набор прав одной роли. */
export interface ChatPermissionSet {
  manageInfo: boolean;
  manageMembers: boolean;
  manageRoles: boolean;
  manageInvites: boolean;
  manageRequests: boolean;
  manageBans: boolean;
  deleteMessages: boolean;
  pinMessages: boolean;
  publish: boolean;
  /** Установка/смена/удаление аватара группы или канала. */
  setAvatar: boolean;
}

export interface ChatPermissions {
  admin: ChatPermissionSet;
  moderator: ChatPermissionSet;
}

/** Права, действующие по умолчанию, если чат не переопределил их. */
const DEFAULT_PERMISSIONS: ChatPermissions = {
  admin: {
    manageInfo: true,
    manageMembers: true,
    manageRoles: true,
    manageInvites: true,
    manageRequests: true,
    manageBans: true,
    deleteMessages: true,
    pinMessages: true,
    publish: true,
    setAvatar: true,
  },
  moderator: {
    manageInfo: true,
    manageMembers: false,
    manageRoles: false,
    manageInvites: true,
    manageRequests: true,
    manageBans: true,
    deleteMessages: true,
    pinMessages: true,
    publish: true,
    setAvatar: true,
  },
};

const PERMISSION_KEYS: (keyof ChatPermissionSet)[] = [
  'manageInfo',
  'manageMembers',
  'manageRoles',
  'manageInvites',
  'manageRequests',
  'manageBans',
  'deleteMessages',
  'pinMessages',
  'publish',
  'setAvatar',
];

const ROLE_RANK: Record<ChatRole, number> = { member: 0, moderator: 1, admin: 2, owner: 3 };

const EMPTY_PERMISSIONS: ChatPermissionSet = {
  manageInfo: false,
  manageMembers: false,
  manageRoles: false,
  manageInvites: false,
  manageRequests: false,
  manageBans: false,
  deleteMessages: false,
  pinMessages: false,
  publish: false,
  setAvatar: false,
};

function normRole(raw: unknown): ChatRole {
  return raw === 'owner' || raw === 'admin' || raw === 'moderator' ? raw : 'member';
}

/** Разобрать видимость из тела запроса; null — значение не задано/некорректно. */
export function parseVisibility(v: unknown): ChatVisibility | null {
  return v === 'public' || v === 'closed' || v === 'private' ? v : null;
}

/** Мерджим сохранённые в чате переопределения с дефолтной матрицей прав. */
export function effectivePermissions(chat: { permissions?: unknown } | null): ChatPermissions {
  const stored = chat?.permissions && typeof chat.permissions === 'object' && !Array.isArray(chat.permissions)
    ? (chat.permissions as Record<string, unknown>)
    : {};
  const merge = (role: 'admin' | 'moderator'): ChatPermissionSet => {
    const src = stored[role] && typeof stored[role] === 'object' && !Array.isArray(stored[role])
      ? (stored[role] as Record<string, unknown>)
      : {};
    const out: ChatPermissionSet = { ...DEFAULT_PERMISSIONS[role] };
    for (const key of PERMISSION_KEYS) {
      if (typeof src[key] === 'boolean') out[key] = src[key] as boolean;
    }
    return out;
  };
  return { admin: merge('admin'), moderator: merge('moderator') };
}

/** Права, действующие для конкретной роли (владелец — всегда всё). */
function permissionsForRole(perms: ChatPermissions, role: ChatRole): ChatPermissionSet {
  if (role === 'owner') return { ...DEFAULT_PERMISSIONS.admin };
  if (role === 'admin') return perms.admin;
  if (role === 'moderator') return perms.moderator;
  return { ...EMPTY_PERMISSIONS };
}

/** Участие пользователя в чате + его действующие права. */
export async function getMembership(
  chatId: string,
  userId: string,
): Promise<{ role: ChatRole; permissions: ChatPermissionSet } | null> {
  const row = await one<{ role: string; permissions: unknown; owner_id: string | null }>(
    `SELECT cm.role, c.permissions, c.owner_id
       FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
      WHERE cm.chat_id = $1 AND cm.user_id = $2`,
    [chatId, userId],
  );
  if (!row) return null;
  const role: ChatRole = row.owner_id === userId ? 'owner' : normRole(row.role);
  return { role, permissions: permissionsForRole(effectivePermissions({ permissions: row.permissions }), role) };
}

/** Проверка права в чате: владелец — всегда да, иначе по матрице роли. */
export async function can(chatId: string, userId: string, perm: keyof ChatPermissionSet): Promise<boolean> {
  const m = await getMembership(chatId, userId);
  return Boolean(m && m.permissions[perm]);
}

/** Запись в журнал действий чата. */
export async function audit(
  chatId: string,
  actor: string | null,
  action: string,
  target = '',
  meta: Record<string, unknown> = {},
): Promise<void> {
  await query(
    'INSERT INTO chat_audit (chat_id, actor_id, action, target, meta) VALUES ($1,$2,$3,$4,$5)',
    [chatId, actor, action, target, JSON.stringify(meta)],
  );
}

/** Активная блокировка в чате (until NULL — навсегда). */
async function activeBan(chatId: string, userId: string): Promise<boolean> {
  const row = await one(
    'SELECT 1 FROM chat_bans WHERE chat_id = $1 AND user_id = $2 AND (until IS NULL OR until > now())',
    [chatId, userId],
  );
  return Boolean(row);
}

/** Все участники чата — для рассылки realtime-событий. */
async function memberIds(chatId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  return rows.map((r) => r.user_id);
}

export type SystemMessageEvent = 'member_joined' | 'member_left' | 'member_removed';

/**
 * Служебное сообщение о событии участников группы.
 * Хранится в messages без object_id/шифротекста (kind='system'), текст — в header.
 * Живёт по тем же правилам, что и обычное сообщение: обновляет chats.last_seq и
 * рассылается всем участникам обычным envelope `{type:'message'}`.
 *
 * Для member_joined actor — вступивший, relatedUserId — пригласивший;
 * для member_removed actor — исключивший, relatedUserId — исключённый.
 */
export async function insertSystemMessage(
  chatId: string,
  actorUserId: string,
  event: SystemMessageEvent,
  relatedUserId?: string | null,
): Promise<void> {
  // Служебные сообщения нужны только в группах.
  const chat = await one<{ type: string }>('SELECT type FROM chats WHERE id = $1', [chatId]);
  if (!chat || chat.type !== 'group') return;

  const actor = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [actorUserId]);
  const related = relatedUserId
    ? await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [relatedUserId])
    : null;
  const actorUsername = actor?.username ?? '';
  const targetUsername = related?.username ?? '';

  const systemText =
    event === 'member_left'
      ? `${actorUsername || 'Участник'} вышел из группы`
      : event === 'member_removed'
        ? `${actorUsername || 'Участник'} исключил ${targetUsername || 'участника'} из группы`
        : targetUsername
          ? `${actorUsername || 'Участник'} вступил в группу по приглашению ${targetUsername}`
          : `${actorUsername || 'Участник'} вступил в группу`;

  const header = {
    systemText,
    system: true,
    actorUsername,
    targetUsername,
    event,
  };
  const id = uuid();
  const row = await one<{ seq: number; created_at: string }>(
    `INSERT INTO messages (id, chat_id, sender_user_id, kind, header)
     VALUES ($1,$2,$3,'system',$4) RETURNING seq, created_at`,
    [id, chatId, actorUserId, JSON.stringify(header)],
  );
  if (!row) return;

  await query('UPDATE chats SET last_seq = GREATEST(last_seq, $2), updated_at = now() WHERE id = $1', [
    chatId,
    row.seq,
  ]);

  const envelope = {
    type: 'message',
    chatId,
    message: {
      id,
      seq: row.seq,
      chatId,
      kind: 'system',
      objectId: null,
      nonce: '',
      header,
      replyTo: null,
      asChannel: false,
      senderUserId: actorUserId,
      senderUsername: actorUsername,
      senderDeviceId: null,
      createdAt: row.created_at,
      clientId: null,
    },
  };
  for (const userId of await memberIds(chatId)) publish(userId, envelope);
}

/**
 * Выдать новому участнику доступ к объектам, которые уже есть в чате
 * (сообщения и комментарии). Иначе история будет видна как «зашифровано».
 */
export async function grantChatObjects(chatId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO object_grants (object_id, user_id)
     SELECT m.object_id, $2::uuid FROM messages m WHERE m.chat_id = $1 AND m.object_id IS NOT NULL
     UNION
     SELECT pc.object_id, $2::uuid FROM post_comments pc WHERE pc.chat_id = $1 AND pc.object_id IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [chatId, userId],
  );
}

/** Сырые переопределения прав из jsonb (только известные роли/ключи/boolean). */
function storedOverrides(raw: unknown): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const role of ['admin', 'moderator'] as const) {
    const src = (raw as Record<string, unknown>)[role];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    const dst: Record<string, boolean> = {};
    for (const key of PERMISSION_KEYS) {
      const v = (src as Record<string, unknown>)[key];
      if (typeof v === 'boolean') dst[key] = v;
    }
    out[role] = dst;
  }
  return out;
}

/** Есть ли у двух пользователей общий чат (для приватности приглашений). */
async function hasSharedChat(a: string, b: string): Promise<boolean> {
  const row = await one(
    `SELECT 1 FROM chat_members x JOIN chat_members y ON y.chat_id = x.chat_id
      WHERE x.user_id = $1 AND y.user_id = $2 LIMIT 1`,
    [a, b],
  );
  return Boolean(row);
}

/** Есть ли между пользователями личный чат. */
async function hasDirectChat(a: string, b: string): Promise<boolean> {
  const row = await one(
    `SELECT 1 FROM chat_members x
       JOIN chat_members y ON y.chat_id = x.chat_id
       JOIN chats c ON c.id = x.chat_id
      WHERE x.user_id = $1 AND y.user_id = $2 AND c.type = 'direct' LIMIT 1`,
    [a, b],
  );
  return Boolean(row);
}

/**
 * Создать (или обновить) заявку на вступление и уведомить менеджеров.
 * Используется входом по ссылке и подпиской на закрытый канал.
 */
export async function createJoinRequest(chatId: string, userId: string, requestedRole: ChatRole = 'member'): Promise<void> {
  await query(
    `INSERT INTO chat_join_requests (chat_id, user_id, requested_role) VALUES ($1,$2,$3)
     ON CONFLICT (chat_id, user_id) WHERE status = 'pending'
     DO UPDATE SET requested_role = EXCLUDED.requested_role`,
    [chatId, userId, requestedRole],
  );
  const managers = await query<{ user_id: string }>(
    `SELECT user_id FROM chat_members WHERE chat_id = $1 AND role IN ('owner','admin','moderator')`,
    [chatId],
  );
  publishMany(managers.map((m) => m.user_id), { type: 'join_request', chatId, userId });
}

interface InviteRow {
  id: string;
  chat_id: string;
  role: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  created_by: string | null;
  revoked_at: string | null;
  title: string;
  type: string;
  visibility: string;
  is_public: boolean;
  description: string;
  owner_id: string | null;
  blocked_reason: string | null;
}

/** Ссылка вместе с данными чата. */
async function loadInvite(token: string): Promise<InviteRow | null> {
  return one<InviteRow>(
    `SELECT l.id, l.chat_id, l.role, l.expires_at, l.max_uses, l.uses, l.created_by, l.revoked_at,
            c.title, c.type, c.visibility, c.is_public, c.description, c.owner_id, c.blocked_reason
       FROM chat_invite_links l JOIN chats c ON c.id = l.chat_id
      WHERE l.token = $1`,
    [token],
  );
}

/** Ссылка ещё действует: не отозвана, не истекла, лимит не исчерпан, чат не заблокирован. */
function inviteUsable(invite: InviteRow | null): invite is InviteRow {
  if (!invite || invite.revoked_at || invite.blocked_reason) return false;
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) return false;
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return false;
  return true;
}

async function assertMember(chatId: string, userId: string): Promise<void> {
  const m = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  if (!m) throw forbidden('not_a_member');
}

const chatRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------------- создать -- */
  app.post('/chats', { onRequest: [requireAuth()] }, async (req, reply) => {
    rateLimit(`chat:${req.auth!.userId}`, 30, 60_000);
    const me = req.auth!.userId;
    const body = (req.body ?? {}) as {
      type?: 'direct' | 'group' | 'channel';
      username?: string;
      title?: string;
      isPublic?: boolean;
      visibility?: string;
      description?: string;
      members?: string[];
      keys?: { deviceId: string; wrappedKey: string }[];
      encryption?: ChatEncryption;
    };
    const type = body.type === 'group' ? 'group' : body.type === 'channel' ? 'channel' : 'direct';
    const keys = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [];
    // основной режим — серверный ключ; E2E только если клиент явно попросил
    const encryption: ChatEncryption = type === 'direct' && body.encryption === 'e2e' ? 'e2e' : 'server';

    if (type === 'direct') {
      const peer = str(body.username, 'username').toLowerCase();
      const peerUser = await one<{ id: string }>('SELECT id FROM users WHERE lower(username) = $1 AND status = $2', [
        peer,
        'active',
      ]);
      if (!peerUser) throw notFound('user');
      if (peerUser.id === me) throw badRequest('cannot_chat_with_self');

      const blocked = await one(
        `SELECT 1 FROM user_blocks
          WHERE (blocker_id = $1 AND blocked_id = $2)
             OR (blocker_id = $2 AND blocked_id = $1)
          LIMIT 1`,
        [me, peerUser.id],
      );
      if (blocked) throw forbidden('user_blocked');

      // direct-чат между двумя пользователями существует в единственном экземпляре
      // в пределах режима шифрования: обычный и «секретный» чат сосуществуют
      const existing = await one<{ chat_id: string }>(
        `SELECT c.id AS chat_id FROM chats c
           JOIN chat_members a ON a.chat_id = c.id AND a.user_id = $1
           JOIN chat_members b ON b.chat_id = c.id AND b.user_id = $2
          WHERE c.type = 'direct' AND c.encryption = $3 LIMIT 1`,
        [me, peerUser.id, encryption],
      );
      if (existing) {
        const chat = await chatInfo(existing.chat_id, me);
        return reply.code(200).send(chat);
      }

      const chatId = uuid();
      await tx(async ({ query: q }) => {
        await q(`INSERT INTO chats (id, type, owner_id, encryption) VALUES ($1,'direct',$2,$3)`, [chatId, me, encryption]);
        await q('INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2),($1,$3)', [chatId, me, peerUser.id]);
        for (const k of keys) {
          await q(
            `INSERT INTO chat_keys (chat_id, device_id, wrapped_key) VALUES ($1,$2,$3)
             ON CONFLICT (chat_id, device_id) DO NOTHING`,
            [chatId, k.deviceId, k.wrappedKey],
          );
        }
      });

      publish(peerUser.id, { type: 'chat_added', chatId });

      return reply.code(201).send(await chatInfo(chatId, me));
    }

    const title = str(body.title ?? '', 'title', { max: 64 });
    const memberNames = (body.members ?? []).map((m) => String(m).toLowerCase()).slice(0, 64);
    // Видимость: явное поле важнее устаревшего isPublic (для каналов).
    const visibility: ChatVisibility =
      parseVisibility(body.visibility) ??
      (type === 'channel' && body.isPublic !== undefined ? (body.isPublic ? 'public' : 'private') : 'public');
    const description = body.description === undefined ? '' : str(body.description, 'description', { max: 500 });

    if (type === 'channel') {
      if (!title) throw badRequest('title_required');
      const chatId = uuid();
      await tx(async ({ query: q }) => {
        await q(
          `INSERT INTO chats (id, type, title, owner_id, is_public, encryption, visibility, description)
           VALUES ($1,'channel',$2,$3,$4,'server',$5,$6)`,
          [chatId, title, me, visibility !== 'private', visibility, description],
        );
        await q('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)', [chatId, me, 'owner']);
      });
      publish(me, { type: 'chat_added', chatId });
      return reply.code(201).send(await chatInfo(chatId, me));
    }

    const members = await query<{ id: string }>(
      `SELECT id FROM users WHERE lower(username) = ANY($1::text[]) AND status = 'active'`,
      [memberNames],
    );
    const chatId = uuid();
    await tx(async ({ query: q }) => {
      await q(
        `INSERT INTO chats (id, type, title, owner_id, encryption, visibility, description)
         VALUES ($1,'group',$2,$3,'server',$4,$5)`,
        [chatId, title, me, visibility, description],
      );
      await q('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)', [chatId, me, 'owner']);
      for (const m of members) {
        await q(
          'INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [chatId, m.id],
        );
      }
      for (const k of keys) {
        await q(
          `INSERT INTO chat_keys (chat_id, device_id, wrapped_key) VALUES ($1,$2,$3)
           ON CONFLICT (chat_id, device_id) DO NOTHING`,
          [chatId, k.deviceId, k.wrappedKey],
        );
      }
    });
    publishMany([...members.map((m) => m.id)], { type: 'chat_added', chatId });
    return reply.code(201).send(await chatInfo(chatId, me));
  });

  /* -------------------------------------------------------------- список -- */
  app.get('/chats', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    // ?archived=1 — только архив, по умолчанию — только активные чаты.
    const archived = String((req.query as { archived?: string }).archived ?? '') === '1';
    const rows = await query<{ chat_id: string }>(
      `SELECT cm.chat_id FROM chat_members cm
         JOIN chats c ON c.id = cm.chat_id
        WHERE cm.user_id = $1 AND cm.archived = $2 AND c.type <> 'channel' AND c.blocked_reason IS NULL
          AND NOT (
            c.type = 'direct' AND EXISTS (
              SELECT 1 FROM chat_members pm
                JOIN user_blocks b ON
                  (b.blocker_id = $1 AND b.blocked_id = pm.user_id)
                  OR (b.blocker_id = pm.user_id AND b.blocked_id = $1)
               WHERE pm.chat_id = c.id AND pm.user_id <> $1
            )
          )
          -- Пустой direct-чат видит только инициатор: получатель не должен
          -- обнаруживать диалог, пока ему ничего не написали.
          AND NOT (
            c.type = 'direct' AND c.last_seq = 0 AND c.owner_id IS DISTINCT FROM $1
          )
        ORDER BY (SELECT c2.updated_at FROM chats c2 WHERE c2.id = cm.chat_id) DESC`,
      [me, archived],
    );
    const chats = [];
    for (const r of rows) chats.push(await chatInfo(r.chat_id, me));
    return reply.send(chats);
  });

  /* ------------------------------------------------------------- архив ---- */
  app.post('/chats/:id/archive', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await assertMember(id, me);
    const body = (req.body ?? {}) as { archived?: unknown };
    if (typeof body.archived !== 'boolean') throw badRequest('invalid_archived');
    await query('UPDATE chat_members SET archived = $3 WHERE chat_id = $1 AND user_id = $2', [id, me, body.archived]);
    return reply.send({ ok: true });
  });

  app.get('/chats/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertMember(id, req.auth!.userId);
    return reply.send(await chatInfo(id, req.auth!.userId));
  });

  /* ------------------------------------------------------------ покинуть -- */
  app.post('/chats/:id/leave', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const chat = await one<{ type: string }>('SELECT type FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    await assertMember(id, me);

    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [id]);
    if (chat.type === 'direct') {
      // direct-чат существует только для двоих — удаляем целиком каскадом
      await query('DELETE FROM chats WHERE id = $1', [id]);
    } else {
      await query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, me]);
      if (chat.type === 'group') await insertSystemMessage(id, me, 'member_left');
    }
    publishMany(members.map((m) => m.user_id), { type: 'chat_removed', chatId: id });
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------------- удалить -- */
  app.delete('/chats/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const chat = await one<{ type: string; owner_id: string | null }>('SELECT type, owner_id FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');

    let allowed = chat.owner_id === me;
    if (!allowed && chat.type === 'direct') {
      const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, me]);
      allowed = Boolean(member);
    }
    if (!allowed) throw forbidden('not_chat_owner');

    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [id]);
    await query('DELETE FROM chats WHERE id = $1', [id]);
    publishMany(members.map((m) => m.user_id), { type: 'chat_removed', chatId: id });
    return reply.send({ ok: true });
  });

  /* ----------------------------------------------------------- участники -- */
  app.post('/chats/:id/members', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await assertMember(id, me);
    const body = (req.body ?? {}) as { usernames?: string[]; keys?: { deviceId: string; wrappedKey: string }[] };
    const names = (body.usernames ?? []).map((n) => String(n).toLowerCase()).slice(0, 64);
    if (!names.length) throw badRequest('usernames_required');

    const users = await query<{ id: string }>('SELECT id FROM users WHERE lower(username) = ANY($1::text[])', [names]);
    for (const u of users) {
      // забаненного нельзя вернуть в чат мимо разбана
      if (await activeBan(id, u.id)) continue;
      await query('INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, u.id]);
      await grantChatObjects(id, u.id);
    }
    for (const k of body.keys ?? []) {
      await query(
        `INSERT INTO chat_keys (chat_id, device_id, wrapped_key) VALUES ($1,$2,$3)
         ON CONFLICT (chat_id, device_id) DO NOTHING`,
        [id, k.deviceId, k.wrappedKey],
      );
    }
    publishMany(users.map((u) => u.id), { type: 'chat_added', chatId: id });
    return reply.send({ added: users.length });
  });

  /* ---------------------------------------------------- ключи для меня ---- */
  app.get('/chats/:id/keys', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await assertMember(id, me);
    const rows = await query<{ device_id: string; wrapped_key: string; chat_id: string }>(
      `SELECT ck.device_id, ck.wrapped_key FROM chat_keys ck
         JOIN devices d ON d.id = ck.device_id
        WHERE ck.chat_id = $1 AND d.user_id = $2`,
      [id, me],
    );
    return reply.send(rows.map((r) => ({ deviceId: r.device_id, wrappedKey: r.wrapped_key })));
  });

  /** Устройства участников, у которых ещё нет ключа чата — нужно обернуть и прислать. */
  app.get('/chats/:id/missing-keys', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertMember(id, req.auth!.userId);
    const rows = await query<{ device_id: string; user_id: string; ecdh_pub: string; identity_pub: string }>(
      `SELECT d.id AS device_id, d.user_id, d.ecdh_pub, d.identity_pub
         FROM chat_members cm
         JOIN devices d ON d.user_id = cm.user_id AND d.revoked_at IS NULL AND d.ecdh_pub <> ''
        WHERE cm.chat_id = $1
          AND NOT EXISTS (SELECT 1 FROM chat_keys ck WHERE ck.chat_id = cm.chat_id AND ck.device_id = d.id)`,
      [id],
    );
    return reply.send(rows);
  });

  app.post('/chats/:id/keys', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await assertMember(id, me);
    const body = (req.body ?? {}) as { keys?: { deviceId: string; wrappedKey: string }[] };
    const keys = (body.keys ?? []).slice(0, 200);
    if (!keys.length) throw badRequest('keys_required');

    for (const k of keys) {
      const owner = await one<{ user_id: string }>('SELECT user_id FROM devices WHERE id = $1', [k.deviceId]);
      if (!owner) continue;
      const isMember = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, owner.user_id]);
      if (!isMember) throw conflict('device_not_in_chat');
      await query(
        `INSERT INTO chat_keys (chat_id, device_id, wrapped_key) VALUES ($1,$2,$3)
         ON CONFLICT (chat_id, device_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key`,
        [id, k.deviceId, k.wrappedKey],
      );
      publish(owner.user_id, { type: 'chat_key_added', chatId: id, deviceId: k.deviceId });
    }
    return reply.send({ ok: true });
  });

  /* --------------------------------------------- ключи уровня аккаунта ---- */
  /** Ключ чата, обёрнутый под публичный ключ аккаунта текущего пользователя. */
  app.get('/chats/:id/account-keys', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await assertMember(id, me);
    const row = await one<{ wrapped_key: string }>(
      'SELECT wrapped_key FROM account_chat_keys WHERE chat_id = $1 AND user_id = $2',
      [id, me],
    );
    return reply.send(row ? [{ userId: me, wrappedKey: row.wrapped_key }] : []);
  });

  /** Участники, для которых ещё нет account-обёртки ключа чата (включая себя). */
  app.get('/chats/:id/account-missing', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertMember(id, req.auth!.userId);
    const rows = await query<{ user_id: string; username: string; account_pub: string }>(
      `SELECT u.id AS user_id, u.username, u.account_pub
         FROM chat_members cm
         JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = $1 AND u.account_pub <> ''
          AND NOT EXISTS (
            SELECT 1 FROM account_chat_keys ack
             WHERE ack.chat_id = cm.chat_id AND ack.user_id = cm.user_id
          )`,
      [id],
    );
    return reply.send(rows.map((r) => ({ userId: r.user_id, username: r.username, accountPub: r.account_pub })));
  });

  /** Сохранить обёртки ключа чата под аккаунты участников (только шифротексты). */
  app.post('/chats/:id/account-keys', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await assertMember(id, me);
    const body = (req.body ?? {}) as { keys?: { userId: string; wrappedKey: string }[] };
    const keys = (body.keys ?? []).slice(0, 200);
    if (!keys.length) throw badRequest('keys_required');

    for (const k of keys) {
      if (typeof k.userId !== 'string' || typeof k.wrappedKey !== 'string') continue;
      const isMember = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, k.userId]);
      if (!isMember) continue;
      await query(
        `INSERT INTO account_chat_keys (chat_id, user_id, wrapped_key) VALUES ($1,$2,$3)
         ON CONFLICT (chat_id, user_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key`,
        [id, k.userId, k.wrappedKey],
      );
      publish(k.userId, { type: 'chat_key_added', chatId: id, userId: k.userId });
    }
    return reply.send({ ok: true });
  });

  /* ------------------------------------------- серверный ключ чата ------- */
  /**
   * Ключ чата в режиме 'server'. Без ?version отдаётся текущая версия
   * (при необходимости создаётся v1 или выполняется авто-ротация раз в 30 дней).
   */
  app.get('/chats/:id/key', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await assertMember(id, me);

    const chat = await one<{ encryption: string }>('SELECT encryption FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    if (chat.encryption === 'e2e') throw new ApiError(400, 'e2e_chat', 'e2e_chat');

    const q = req.query as { version?: string };
    const requested = q.version !== undefined ? Number(q.version) : NaN;
    if (Number.isFinite(requested) && requested > 0) {
      const row = await one<KeyVersionRow>(
        'SELECT version, key_enc, created_at FROM chat_key_versions WHERE chat_id = $1 AND version = $2',
        [id, requested],
      );
      if (!row) throw notFound('key_version');
      return reply.send(keyResponse(row));
    }

    let current = await one<KeyVersionRow>(
      'SELECT version, key_enc, created_at FROM chat_key_versions WHERE chat_id = $1 ORDER BY version DESC LIMIT 1',
      [id],
    );
    if (!current) {
      current = await createKeyVersion(id, 1);
    } else if (Date.now() - new Date(current.created_at).getTime() > KEY_ROTATION_DAYS * 24 * 3600 * 1000) {
      current = (await createKeyVersion(id, current.version + 1)) ?? current;
    }
    if (!current) throw new ApiError(500, 'key_unavailable', 'key_unavailable');
    return reply.send(keyResponse(current));
  });

  /* ------------------------------------------------- закрепление -------- */
  app.post('/chats/:id/pin', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await assertMember(id, me);
    const body = (req.body ?? {}) as { messageId?: string | null };
    const messageId = body.messageId ?? null;

    if (messageId !== null) {
      if (typeof messageId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(messageId)) throw badRequest('invalid_message');
      const msg = await one('SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2', [messageId, id]);
      if (!msg) throw notFound('message');
    }

    await query('UPDATE chats SET pinned_message_id = $2 WHERE id = $1', [id, messageId]);
    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [id]);
    publishMany(members.map((m) => m.user_id), { type: 'chat_pin', chatId: id, messageId });
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------- «печатает…» -------- */
  app.post('/chats/:id/typing', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await assertMember(id, me);
    rateLimit(`typing:${me}:${id}`, 30, 60_000);

    const user = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [me]);
    const others = await query<{ user_id: string }>(
      'SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2',
      [id, me],
    );
    publishMany(others.map((o) => o.user_id), {
      type: 'typing',
      chatId: id,
      userId: me,
      username: user?.username ?? '',
    });
    return reply.send({ ok: true });
  });

  /* ---------------------------------------------------------- прочитано --- */
  app.post('/chats/:id/read', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const body = (req.body ?? {}) as { seq?: number };
    const seq = Number(body.seq ?? 0);
    if (Number.isFinite(seq) && seq > 0) {
      // seq — глобальный bigserial; не позволяем записать чужое/будущее значение.
      await query(
        `UPDATE chat_members
            SET last_read_seq = GREATEST(last_read_seq, LEAST($3, (SELECT last_seq FROM chats WHERE id = $1)))
          WHERE chat_id = $1 AND user_id = $2`,
        [id, me, seq],
      );
      // репорт о прочтении ко всем отправителям в чате
      const others = await query<{ user_id: string }>(
        'SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2',
        [id, me],
      );
      for (const o of others) publish(o.user_id, { type: 'message_read', chatId: id, seq, userId: me });
    }
    return reply.send({ ok: true });
  });

  /* ----------------------------------------- изменить чат (инфо/видимость) - */
  app.patch('/chats/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const chat = await one<{ type: string; owner_id: string | null }>('SELECT type, owner_id FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    const member = await getMembership(id, me);
    if (!member) throw forbidden('not_a_member');
    if (member.role !== 'owner' && !member.permissions.manageInfo) throw forbidden('no_permission');

    const body = (req.body ?? {}) as { title?: unknown; description?: unknown; visibility?: unknown };
    const params: unknown[] = [id];
    const sets: string[] = [];
    if (body.title !== undefined) {
      const title = str(body.title, 'title', { max: 64 });
      if (!title) throw badRequest('title_required');
      params.push(title);
      sets.push(`title = $${params.length}`);
    }
    if (body.description !== undefined) {
      params.push(str(body.description, 'description', { max: 500 }));
      sets.push(`description = $${params.length}`);
    }
    let visibility: ChatVisibility | null = null;
    if (body.visibility !== undefined) {
      const v = parseVisibility(body.visibility);
      if (!v) throw badRequest('invalid_visibility');
      visibility = v;
      params.push(v);
      sets.push(`visibility = $${params.length}`);
      // у канала синхронизируем исторический флаг is_public
      if (chat.type === 'channel') {
        params.push(v !== 'private');
        sets.push(`is_public = $${params.length}`);
      }
    }
    if (!sets.length) return reply.send(await chatInfo(id, me));
    sets.push('updated_at = now()');
    await query(`UPDATE chats SET ${sets.join(', ')} WHERE id = $1`, params);
    publishMany(await memberIds(id), { type: 'chat_updated', chatId: id });
    await audit(id, me, 'chat_updated', '', {
      title: body.title ?? null,
      description: body.description ?? null,
      visibility,
    });
    return reply.send(await chatInfo(id, me));
  });

  /* ---------------------------------------------------- аватар чата ------ */
  /**
   * Установить/сменить аватар группы или канала. Файл клиент шифрует и грузит
   * на узлы сам; Hub хранит только objectId, ключ расшифровки и mime.
   * Право: владелец всегда, admin/moderator — по ключу матрицы setAvatar.
   */
  app.post('/chats/:id/avatar', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const chat = await one<{ type: string }>('SELECT type FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    if (chat.type !== 'group' && chat.type !== 'channel') throw badRequest('avatar_not_supported');

    const member = await getMembership(id, me);
    if (!member) throw forbidden('not_a_member');
    if (member.role !== 'owner' && !member.permissions.setAvatar) throw forbidden('no_permission');

    const body = (req.body ?? {}) as { objectId?: unknown; key?: unknown; mime?: unknown };
    const objectId = str(body.objectId, 'objectId', { max: 64 });
    const key = str(body.key, 'key', { min: 1, max: 300 });
    const mime = str(body.mime, 'mime', { min: 1, max: 120 });
    if (!/^image\//i.test(mime)) throw badRequest('invalid_avatar_mime');

    // Объект должен быть загружен и доступен действующему пользователю
    // (владелец объекта или явный grant после загрузки) — как у /me/avatar.
    const obj = await one(
      `SELECT o.id FROM objects o
        WHERE o.id = $1 AND o.state = 'active'
          AND (o.owner_id = $2
               OR EXISTS (SELECT 1 FROM object_grants g WHERE g.object_id = o.id AND g.user_id = $2))`,
      [objectId, me],
    );
    if (!obj) throw notFound('object');

    await query(
      `UPDATE chats
          SET avatar_object_id = $2, avatar_key = $3, avatar_mime = $4,
              avatar_updated_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, objectId, key, mime],
    );
    publishMany(await memberIds(id), { type: 'chat_updated', chatId: id });
    await audit(id, me, 'avatar_updated', objectId, { mime });
    return reply.send(await chatInfo(id, me));
  });

  app.delete('/chats/:id/avatar', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const chat = await one<{ type: string }>('SELECT type FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    if (chat.type !== 'group' && chat.type !== 'channel') throw badRequest('avatar_not_supported');

    const member = await getMembership(id, me);
    if (!member) throw forbidden('not_a_member');
    if (member.role !== 'owner' && !member.permissions.setAvatar) throw forbidden('no_permission');

    await query(
      `UPDATE chats
          SET avatar_object_id = NULL, avatar_key = '', avatar_mime = '',
              avatar_updated_at = now(), updated_at = now()
        WHERE id = $1`,
      [id],
    );
    publishMany(await memberIds(id), { type: 'chat_updated', chatId: id });
    await audit(id, me, 'avatar_removed');
    return reply.send(await chatInfo(id, me));
  });

  /* -------------------------------------------------- матрица прав -------- */
  app.get('/chats/:id/permissions', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const member = await getMembership(id, me);
    if (!member) throw forbidden('not_a_member');
    const chat = await one<{ permissions: unknown }>('SELECT permissions FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    return reply.send({ ...effectivePermissions(chat), myRole: member.role });
  });

  app.patch('/chats/:id/permissions', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const chat = await one<{ owner_id: string | null; permissions: unknown }>(
      'SELECT owner_id, permissions FROM chats WHERE id = $1',
      [id],
    );
    if (!chat) throw notFound('chat');
    if (chat.owner_id !== me) throw forbidden('not_chat_owner');

    const body = (req.body ?? {}) as { admin?: unknown; moderator?: unknown };
    const stored = storedOverrides(chat.permissions);
    for (const role of ['admin', 'moderator'] as const) {
      const src = body[role];
      if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
      const dst = (stored[role] ??= {});
      for (const key of PERMISSION_KEYS) {
        if (typeof (src as Record<string, unknown>)[key] === 'boolean') {
          dst[key] = (src as Record<string, boolean>)[key];
        }
      }
    }
    await query('UPDATE chats SET permissions = $2, updated_at = now() WHERE id = $1', [
      id,
      JSON.stringify(stored),
    ]);
    publishMany(await memberIds(id), { type: 'chat_updated', chatId: id });
    await audit(id, me, 'permissions_changed', '', stored);
    return reply.send({ ...effectivePermissions({ permissions: stored }), myRole: 'owner' as ChatRole });
  });

  /* ------------------------------------------------ пригласительные ссылки - */
  app.get('/chats/:id/invites', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    if (!(await can(id, me, 'manageInvites'))) throw forbidden('no_permission');
    const rows = await query<{
      id: string;
      token: string;
      role: string;
      expires_at: string | null;
      max_uses: number | null;
      uses: number;
      created_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, token, role, expires_at, max_uses, uses, created_at, revoked_at
         FROM chat_invite_links WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id],
    );
    return reply.send(
      rows.map((r) => ({
        id: r.id,
        token: r.token,
        role: normRole(r.role),
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        maxUses: r.max_uses,
        uses: r.uses,
        createdAt: new Date(r.created_at).toISOString(),
        revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
      })),
    );
  });

  app.post('/chats/:id/invites', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const member = await getMembership(id, me);
    if (!member) throw forbidden('not_a_member');
    if (!member.permissions.manageInvites) throw forbidden('no_permission');

    const body = (req.body ?? {}) as { role?: unknown; expiresInHours?: unknown; maxUses?: unknown };
    let role: ChatRole = 'member';
    if (body.role !== undefined) {
      if (body.role !== 'member' && body.role !== 'moderator' && body.role !== 'admin') {
        throw badRequest('invalid_role');
      }
      role = body.role;
    }
    if (role === 'admin' && member.role !== 'owner') throw forbidden('admin_role_requires_owner');

    let expiresInHours: number | null = null;
    if (body.expiresInHours !== undefined && body.expiresInHours !== null) {
      expiresInHours = Number(body.expiresInHours);
      if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) {
        throw badRequest('invalid_expires');
      }
    }
    let maxUses: number | null = null;
    if (body.maxUses !== undefined && body.maxUses !== null) {
      maxUses = Number(body.maxUses);
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000) throw badRequest('invalid_max_uses');
    }

    const inviteId = uuid();
    const token = randomBytes(18).toString('base64url');
    const row = await one<{ id: string; token: string; role: string; expires_at: string | null; max_uses: number | null; uses: number }>(
      `INSERT INTO chat_invite_links (id, chat_id, token, role, expires_at, max_uses, created_by)
       VALUES ($1,$2,$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int * interval '1 hour') END, $6, $7)
       RETURNING id, token, role, expires_at, max_uses, uses`,
      [inviteId, id, token, role, expiresInHours, maxUses, me],
    );
    await audit(id, me, 'invite_created', inviteId, { role, expiresInHours, maxUses });
    return reply.code(201).send({
      id: row!.id,
      token: row!.token,
      role: normRole(row!.role),
      expiresAt: row!.expires_at ? new Date(row!.expires_at).toISOString() : null,
      maxUses: row!.max_uses,
      uses: row!.uses,
    });
  });

  app.delete('/chats/:id/invites/:inviteId', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id, inviteId } = req.params as { id: string; inviteId: string };
    const me = req.auth!.userId;
    if (!(await can(id, me, 'manageInvites'))) throw forbidden('no_permission');
    const row = await one('SELECT 1 FROM chat_invite_links WHERE id = $1 AND chat_id = $2', [inviteId, id]);
    if (!row) throw notFound('invite');
    await query('UPDATE chat_invite_links SET revoked_at = now() WHERE id = $1', [inviteId]);
    await audit(id, me, 'invite_revoked', inviteId);
    return reply.send({ ok: true });
  });

  /* ------------------------------------------- предпросмотр и вход по ссылке */
  app.get('/invites/:token', { onRequest: [requireAuth({ optional: true })] }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const me = req.auth?.userId ?? null;
    const invite = await loadInvite(token);
    if (!invite || !inviteUsable(invite)) throw notFound('invite');

    const membersCount = await one<{ c: number }>(
      'SELECT count(*)::int AS c FROM chat_members WHERE chat_id = $1',
      [invite.chat_id],
    );
    const alreadyMember = me
      ? Boolean(await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [invite.chat_id, me]))
      : false;
    return reply.send({
      chatId: invite.chat_id,
      title: invite.title,
      type: invite.type,
      visibility: parseVisibility(invite.visibility) ?? 'public',
      description: invite.description,
      membersCount: membersCount?.c ?? 0,
      requiresApproval: invite.visibility === 'closed',
      alreadyMember,
      banned: me ? await activeBan(invite.chat_id, me) : false,
      valid: true,
    });
  });

  app.post('/invites/:token/join', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const me = req.auth!.userId;
    const invite = await loadInvite(token);
    if (!invite || !inviteUsable(invite)) throw notFound('invite');
    if (await activeBan(invite.chat_id, me)) throw forbidden('banned');

    const existing = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [invite.chat_id, me]);
    if (existing) return reply.send({ status: 'joined', chatId: invite.chat_id });

    // Ссылку с ролью admin мог создать только владелец; подстрахуемся.
    let role: ChatRole = normRole(invite.role);
    if (role === 'admin' && invite.created_by !== invite.owner_id) role = 'moderator';

    if (invite.visibility === 'closed') {
      await createJoinRequest(invite.chat_id, me, role);
      return reply.send({ status: 'requested', chatId: invite.chat_id });
    }

    await query('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
      invite.chat_id,
      me,
      role,
    ]);
    await grantChatObjects(invite.chat_id, me);
    await query('UPDATE chat_invite_links SET uses = uses + 1 WHERE id = $1', [invite.id]);
    publish(me, { type: 'chat_added', chatId: invite.chat_id });
    publishMany(await memberIds(invite.chat_id), { type: 'chat_updated', chatId: invite.chat_id });
    await insertSystemMessage(invite.chat_id, me, 'member_joined', invite.created_by ?? invite.owner_id);
    await audit(invite.chat_id, me, 'invite_joined', invite.id, { role });
    return reply.send({ status: 'joined', chatId: invite.chat_id });
  });

  /* ------------------------------------------------ вступление без ссылки -- */
  /** Прямое вступление из поиска: public — сразу, closed — заявка, private — запрещено. */
  app.post('/chats/:id/join', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const chat = await one<{ id: string; type: string; visibility: string; owner_id: string | null }>(
      'SELECT id, type, visibility, owner_id FROM chats WHERE id = $1',
      [id],
    );
    if (!chat) throw notFound('chat');
    if (await activeBan(id, me)) throw forbidden('banned');

    const existing = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, me]);
    if (existing) return reply.send({ status: 'joined', chatId: id });

    if (chat.visibility === 'private') throw forbidden('invite_required');
    if (chat.visibility === 'closed') {
      await createJoinRequest(id, me, 'member');
      const managers = await query<{ user_id: string }>(
        "SELECT user_id FROM chat_members WHERE chat_id = $1 AND role IN ('owner','admin','moderator')",
        [id],
      );
      if (managers.length) publishMany(managers.map((m) => m.user_id), { type: 'join_request', chatId: id });
      return reply.send({ status: 'requested', chatId: id });
    }

    await query("INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING", [id, me]);
    await grantChatObjects(id, me);
    publish(me, { type: 'chat_added', chatId: id });
    publishMany(await memberIds(id), { type: 'chat_updated', chatId: id });
    await insertSystemMessage(id, me, 'member_joined', chat.owner_id);
    await audit(id, me, 'joined', me, {});
    return reply.send({ status: 'joined', chatId: id });
  });

  /* ------------------------------------------------------- заявки --------- */
  app.get('/chats/:id/requests', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    if (!(await can(id, me, 'manageRequests'))) throw forbidden('no_permission');
    const status = String((req.query as { status?: string }).status ?? 'pending');
    const all = status === 'all';
    const rows = await query<{
      user_id: string;
      username: string;
      display_name: string;
      requested_role: string;
      created_at: string;
      status: string;
    }>(
      `SELECT r.user_id, u.username, u.display_name, r.requested_role, r.created_at, r.status
         FROM chat_join_requests r JOIN users u ON u.id = r.user_id
        WHERE r.chat_id = $1 ${all ? '' : "AND r.status = 'pending'"}
        ORDER BY r.created_at DESC LIMIT 200`,
      [id],
    );
    return reply.send(
      rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        requestedRole: normRole(r.requested_role),
        createdAt: new Date(r.created_at).toISOString(),
        status: r.status,
      })),
    );
  });

  /* approve/reject одной заявки */
  for (const action of ['approve', 'reject'] as const) {
    app.post(`/chats/:id/requests/:userId/${action}`, { onRequest: [requireAuth()] }, async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const me = req.auth!.userId;
      if (!(await can(id, me, 'manageRequests'))) throw forbidden('no_permission');

      const chat = await one<{ owner_id: string | null }>('SELECT owner_id FROM chats WHERE id = $1', [id]);
      if (!chat) throw notFound('chat');
      const request = await one<{ id: number; requested_role: string }>(
        "SELECT id, requested_role FROM chat_join_requests WHERE chat_id = $1 AND user_id = $2 AND status = 'pending'",
        [id, userId],
      );
      if (!request) throw notFound('request');

      if (action === 'approve') {
        if (await activeBan(id, userId)) throw forbidden('banned');
        let role = normRole(request.requested_role);
        if (role === 'admin' && chat.owner_id !== me) role = 'moderator';
        await query('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (chat_id, user_id) DO UPDATE SET role = EXCLUDED.role', [
          id,
          userId,
          role,
        ]);
        await grantChatObjects(id, userId);
        publish(userId, { type: 'chat_added', chatId: id });
        await audit(id, me, 'request_approved', userId, { role });
      } else {
        await audit(id, me, 'request_rejected', userId);
      }
      await query(
        "UPDATE chat_join_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1",
        [request.id, action === 'approve' ? 'approved' : 'rejected', me],
      );
      publish(userId, { type: 'request_decided', chatId: id, status: action === 'approve' ? 'approved' : 'rejected' });
      return reply.send({ ok: true, status: action === 'approve' ? 'approved' : 'rejected' });
    });
  }

  /* --------------------------------------------- прямое приглашение -------- */
  app.post('/chats/:id/invite', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    if (!(await can(id, me, 'manageInvites'))) throw forbidden('no_permission');

    const body = (req.body ?? {}) as { username?: unknown };
    const username = str(body.username, 'username').toLowerCase();
    const target = await one<{ id: string; invite_privacy: string }>(
      'SELECT id, invite_privacy FROM users WHERE lower(username) = $1 AND status = $2',
      [username, 'active'],
    );
    if (!target) throw notFound('user');
    if (target.id === me) throw badRequest('cannot_invite_self');
    if (await activeBan(id, target.id)) throw forbidden('banned');

    const already = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, target.id]);
    if (already) return reply.send({ ok: true, chatId: id, added: false });

    const privacy = target.invite_privacy === 'shared' || target.invite_privacy === 'chat' || target.invite_privacy === 'nobody'
      ? target.invite_privacy
      : 'everyone';
    if (privacy === 'nobody') throw forbidden('invite_forbidden');
    if (privacy === 'shared' && !(await hasSharedChat(me, target.id))) throw forbidden('invite_forbidden');
    if (privacy === 'chat' && !(await hasDirectChat(me, target.id))) throw forbidden('invite_forbidden');

    await query("INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING", [
      id,
      target.id,
    ]);
    await grantChatObjects(id, target.id);
    publish(target.id, { type: 'chat_added', chatId: id });
    publishMany(await memberIds(id), { type: 'chat_updated', chatId: id });
    await audit(id, me, 'member_invited', target.id, { username });
    return reply.send({ ok: true, chatId: id, added: true });
  });

  /* --------------------------------------------------- роли участников ---- */
  app.post('/chats/:id/members/:userId/role', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const me = req.auth!.userId;
    const actor = await getMembership(id, me);
    if (!actor) throw forbidden('not_a_member');
    if (!actor.permissions.manageRoles) throw forbidden('no_permission');

    const chat = await one<{ owner_id: string | null }>('SELECT owner_id FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    if (userId === chat.owner_id) throw forbidden('cannot_change_owner');

    const body = (req.body ?? {}) as { role?: unknown };
    const role: ChatRole | null = body.role === 'admin' || body.role === 'moderator' || body.role === 'member'
      ? body.role
      : null;
    if (!role) throw badRequest('invalid_role');
    // Назначать admin может только владелец.
    if (role === 'admin' && actor.role !== 'owner') throw forbidden('admin_role_requires_owner');

    const target = await one<{ role: string }>('SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, userId]);
    if (!target) throw notFound('member');
    // Нельзя менять равного или более высокого по рангу.
    if (ROLE_RANK[actor.role] <= ROLE_RANK[normRole(target.role)] && actor.role !== 'owner') {
      throw forbidden('insufficient_role');
    }

    await query('UPDATE chat_members SET role = $3 WHERE chat_id = $1 AND user_id = $2', [id, userId, role]);
    publishMany(await memberIds(id), { type: 'chat_member_role', chatId: id, userId, role });
    await audit(id, me, 'member_role_changed', userId, { role });
    return reply.send({ ok: true, role });
  });

  app.delete('/chats/:id/members/:userId', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const me = req.auth!.userId;
    if (!(await can(id, me, 'manageMembers'))) throw forbidden('no_permission');
    const chat = await one<{ owner_id: string | null; type: string }>(
      'SELECT owner_id, type FROM chats WHERE id = $1',
      [id],
    );
    if (!chat) throw notFound('chat');
    if (userId === chat.owner_id) throw forbidden('cannot_remove_owner');
    const target = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, userId]);
    if (!target) throw notFound('member');

    const members = await memberIds(id);
    await query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, userId]);
    publish(userId, { type: 'chat_removed', chatId: id });
    publishMany(members, { type: 'chat_updated', chatId: id });
    if (chat.type === 'group') await insertSystemMessage(id, me, 'member_removed', userId);
    await audit(id, me, 'member_removed', userId);
    return reply.send({ ok: true });
  });

  /* ---------------------------------------------------- блокировки -------- */
  app.get('/chats/:id/bans', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    if (!(await can(id, me, 'manageBans'))) throw forbidden('no_permission');
    const rows = await query<{
      user_id: string;
      username: string;
      display_name: string;
      reason: string;
      until: string | null;
      created_at: string;
    }>(
      `SELECT b.user_id, u.username, u.display_name, b.reason, b.until, b.created_at
         FROM chat_bans b JOIN users u ON u.id = b.user_id
        WHERE b.chat_id = $1 ORDER BY b.created_at DESC LIMIT 200`,
      [id],
    );
    return reply.send(
      rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        reason: r.reason,
        until: r.until ? new Date(r.until).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    );
  });

  app.post('/chats/:id/bans', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    if (!(await can(id, me, 'manageBans'))) throw forbidden('no_permission');

    const body = (req.body ?? {}) as { userId?: unknown; reason?: unknown; durationHours?: unknown };
    const userId = String(body.userId ?? '');
    if (!/^[0-9a-fA-F-]{36}$/.test(userId)) throw badRequest('user_required');
    if (userId === me) throw badRequest('cannot_ban_self');
    const chat = await one<{ owner_id: string | null }>('SELECT owner_id FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    if (userId === chat.owner_id) throw forbidden('cannot_ban_owner');
    const target = await one('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!target) throw notFound('user');

    const reason = body.reason === undefined ? '' : str(body.reason, 'reason', { max: 300 });
    let until: string | null = null;
    if (body.durationHours !== undefined && body.durationHours !== null) {
      const hours = Number(body.durationHours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) throw badRequest('invalid_duration');
      until = new Date(Date.now() + hours * 3600_000).toISOString();
    }

    await query(
      `INSERT INTO chat_bans (chat_id, user_id, banned_by, reason, until) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (chat_id, user_id) DO UPDATE
         SET banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason, until = EXCLUDED.until, created_at = now()`,
      [id, userId, me, reason, until],
    );
    const members = await memberIds(id);
    await query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, userId]);
    await query("UPDATE chat_join_requests SET status = 'rejected', decided_by = $3, decided_at = now() WHERE chat_id = $1 AND user_id = $2 AND status = 'pending'", [id, userId, me]);
    publish(userId, { type: 'chat_removed', chatId: id });
    publishMany(members, { type: 'chat_updated', chatId: id });
    await audit(id, me, 'member_banned', userId, { reason, until });
    return reply.send({ ok: true });
  });

  app.delete('/chats/:id/bans/:userId', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const me = req.auth!.userId;
    if (!(await can(id, me, 'manageBans'))) throw forbidden('no_permission');
    await query('DELETE FROM chat_bans WHERE chat_id = $1 AND user_id = $2', [id, userId]);
    await audit(id, me, 'member_unbanned', userId);
    return reply.send({ ok: true });
  });

  /* ---------------------------------------------- передача владения ------ */
  app.post('/chats/:id/transfer', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const chat = await one<{ owner_id: string | null }>('SELECT owner_id FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    if (chat.owner_id !== me) throw forbidden('not_chat_owner');

    const body = (req.body ?? {}) as { userId?: unknown };
    const userId = String(body.userId ?? '');
    if (!/^[0-9a-fA-F-]{36}$/.test(userId)) throw badRequest('user_required');
    if (userId === me) throw badRequest('cannot_transfer_to_self');
    const target = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, userId]);
    if (!target) throw notFound('member');

    await tx(async ({ query: q }) => {
      await q('UPDATE chats SET owner_id = $2, updated_at = now() WHERE id = $1', [id, userId]);
      await q("UPDATE chat_members SET role = 'admin' WHERE chat_id = $1 AND user_id = $2", [id, me]);
      await q("UPDATE chat_members SET role = 'owner' WHERE chat_id = $1 AND user_id = $2", [id, userId]);
    });
    publishMany(await memberIds(id), { type: 'chat_updated', chatId: id });
    await audit(id, me, 'ownership_transferred', userId);
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------- журнал -------- */
  app.get('/chats/:id/audit', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const member = await getMembership(id, me);
    if (!member) throw forbidden('not_a_member');
    if (!member.permissions.manageInfo && !member.permissions.manageBans) throw forbidden('no_permission');
    const rows = await query<{
      id: number;
      actor_id: string | null;
      actor_username: string | null;
      action: string;
      target: string;
      meta: unknown;
      created_at: string;
    }>(
      `SELECT a.id, a.actor_id, u.username AS actor_username, a.action, a.target, a.meta, a.created_at
         FROM chat_audit a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.chat_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
      [id],
    );
    return reply.send(
      rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        actorUsername: r.actor_username,
        action: r.action,
        target: r.target,
        meta: r.meta,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    );
  });
};

/* ------------------------------------------------------------- helpers ---- */

interface KeyVersionRow {
  version: number;
  key_enc: string;
  created_at: string;
}

function keyResponse(row: KeyVersionRow) {
  try {
    return {
      key: decryptSecret(row.key_enc),
      version: row.version,
      rotatedAt: new Date(row.created_at).toISOString(),
    };
  } catch (e) {
    // Никогда не отдаём 500 без причины: ключ есть, но master-секрет не тот.
    log('error', 'chat_key_decrypt_failed', {
      version: row.version,
      error: e instanceof Error ? e.message : String(e),
    });
    throw new ApiError(503, 'key_unavailable', 'key_unavailable');
  }
}

/** Создать новую версию серверного ключа (32 случайных байта, base64). */
async function createKeyVersion(chatId: string, version: number): Promise<KeyVersionRow | null> {
  const raw = randomBytes(32);
  const keyEnc = encryptSecret(raw.toString('base64'));
  const inserted = await one<KeyVersionRow>(
    `INSERT INTO chat_key_versions (chat_id, version, key_enc) VALUES ($1,$2,$3)
     ON CONFLICT (chat_id, version) DO NOTHING
     RETURNING version, key_enc, created_at`,
    [chatId, version, keyEnc],
  );
  if (inserted) return inserted;
  // параллельный запрос уже создал эту версию
  return one<KeyVersionRow>(
    'SELECT version, key_enc, created_at FROM chat_key_versions WHERE chat_id = $1 AND version = $2',
    [chatId, version],
  );
}

export async function chatInfo(chatId: string, viewerId: string) {
  const chat = await one<{ id: string; type: string; title: string; is_public: boolean; encryption: string; created_at: string; updated_at: string; last_seq: number; owner_id: string | null; owner_username: string | null; pinned_message_id: string | null; visibility: string; description: string; permissions: unknown; avatar_object_id: string | null; avatar_key: string; avatar_mime: string }>(
    `SELECT c.id, c.type, c.title, c.is_public, c.encryption, c.created_at, c.updated_at,
            c.last_seq, c.owner_id, u.username AS owner_username, c.pinned_message_id,
            c.visibility, c.description, c.permissions,
            c.avatar_object_id, c.avatar_key, c.avatar_mime
       FROM chats c LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.id = $1`,
    [chatId],
  );
  if (!chat) throw notFound('chat');

  const members = await query<{
    user_id: string;
    username: string;
    display_name: string;
    role: string;
    last_read_seq: number;
    archived: boolean;
    node_online: boolean;
    module_online: boolean;
    avatar_object_id: string | null;
    avatar_key: string;
    avatar_mime: string;
  }>(
    `SELECT cm.user_id, u.username, u.display_name, cm.role, cm.last_read_seq, cm.archived,
            u.avatar_object_id, u.avatar_key, u.avatar_mime,
            EXISTS (SELECT 1 FROM nodes n WHERE n.owner_id = cm.user_id AND n.status = 'online') AS node_online,
            EXISTS (SELECT 1 FROM modules md WHERE md.owner_id = cm.user_id AND md.status = 'online') AS module_online
       FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chat_id = $1 ORDER BY u.username`,
    [chatId],
  );

  let title = chat.title;
  if (chat.type === 'direct') {
    const peer = members.find((m) => m.user_id !== viewerId);
    title = peer ? peer.display_name || peer.username : 'Диалог';
  }

  const last = await one<{ id: string; seq: number; kind: string; created_at: string; sender_user_id: string; sender_username: string }>(
    `SELECT m.id, m.seq, m.kind, m.created_at, m.sender_user_id, u.username AS sender_username
       FROM messages m JOIN users u ON u.id = m.sender_user_id
      WHERE m.chat_id = $1 ORDER BY m.seq DESC LIMIT 1`,
    [chatId],
  );

  const my = members.find((m) => m.user_id === viewerId);
  // Непрочитанные считаем реальным количеством сообщений после last_read_seq,
  // не включая собственные. seq — глобальный bigserial, поэтому разность
  // last_seq - last_read_seq давала абсурдные числа.
  const unreadRow = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM messages
      WHERE chat_id = $1 AND seq > $2 AND sender_user_id <> $3`,
    [chatId, my?.last_read_seq ?? 0, viewerId],
  );
  const perms = effectivePermissions({ permissions: chat.permissions });
  const myRole: ChatRole = chat.owner_id === viewerId ? 'owner' : normRole(my?.role);

  // Заявки на вступление видят только те, кто может их рассматривать.
  let pendingRequests: number | undefined;
  if (permissionsForRole(perms, myRole).manageRequests) {
    const row = await one<{ c: number }>(
      "SELECT count(*)::int AS c FROM chat_join_requests WHERE chat_id = $1 AND status = 'pending'",
      [chatId],
    );
    pendingRequests = row?.c ?? 0;
  }

  // Текст закреплённого сообщения хранится только на узлах — клиент берёт его
  // из своего кэша, Hub отдаёт лишь метаданные.
  const pinned = chat.pinned_message_id
    ? await one<{ id: string; kind: string; created_at: string; sender_username: string }>(
        `SELECT m.id, m.kind, m.created_at, u.username AS sender_username
           FROM messages m JOIN users u ON u.id = m.sender_user_id
          WHERE m.id = $1 AND m.chat_id = $2`,
        [chat.pinned_message_id, chatId],
      )
    : null;

  return {
    id: chat.id,
    type: chat.type,
    title,
    isPublic: chat.is_public,
    visibility: parseVisibility(chat.visibility) ?? 'public',
    description: chat.description ?? '',
    permissions: perms,
    myRole,
    /** Может ли зритель публиковать в канал (для переключателя «от имени канала»). */
    canPublish: permissionsForRole(perms, myRole).publish,
    /** Может ли зритель менять аватар (владелец — всегда, иначе право set_avatar). */
    canSetAvatar: myRole === 'owner' || permissionsForRole(perms, myRole).setAvatar,
    /** Аватар группы/канала — тот же зашифрованный контракт, что у профиля. */
    avatar:
      chat.avatar_object_id && chat.avatar_key && chat.avatar_mime
        ? { objectId: chat.avatar_object_id, key: chat.avatar_key, mime: chat.avatar_mime }
        : null,
    ...(pendingRequests === undefined ? {} : { pendingRequests }),
    encryption: chat.encryption === 'e2e' ? 'e2e' : 'server',
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
    lastSeq: chat.last_seq,
    lastReadSeq: my?.last_read_seq ?? 0,
    membersCount: members.length,
    ownerUsername: chat.owner_username,
    unread: Math.max(0, unreadRow?.c ?? 0),
    /** Архив — персональный флаг зрителя. */
    archived: Boolean(my?.archived),
    pinnedMessageId: chat.pinned_message_id,
    pinnedMessage: pinned
      ? {
          id: pinned.id,
          senderUsername: pinned.sender_username,
          kind: pinned.kind,
          createdAt: pinned.created_at,
        }
      : null,
    members: members.map((m) => ({
      userId: m.user_id,
      username: m.username,
      displayName: m.display_name,
      // Аватар — расшифровываемый клиентом объект (objectId + ключ + mime).
      avatar:
        m.avatar_object_id && m.avatar_key && m.avatar_mime
          ? { objectId: m.avatar_object_id, key: m.avatar_key, mime: m.avatar_mime }
          : null,
      role: m.role,
      nodeOnline: Boolean(m.node_online),
      moduleOnline: Boolean(m.module_online),
    })),
    lastMessage: last
      ? { id: last.id, seq: last.seq, kind: last.kind, createdAt: last.created_at, senderUserId: last.sender_user_id, senderUsername: last.sender_username }
      : null,
  };
}

export default chatRoutes;
