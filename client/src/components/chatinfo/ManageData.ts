/**
 * Безопасные обёртки над data-слоем для управления группами.
 *
 * Data-слой обновляется параллельно: методов и хуков может ещё не быть.
 * Поэтому:
 *  - хуки вызываются через namespace-объект (`as any`) и, если хук ещё не
 *    появился, возвращают undefined вместо падения приложения;
 *  - действия вызывают `api.<method>` через `as any` и дают понятную ошибку,
 *    если метод отсутствует;
 *  - нормализаторы терпимы к разным именам полей ответа сервера.
 *
 * TODO(data): когда параллельный агент добавит типы, убрать `as any` и
 * заменить локальные интерфейсы на импорт из `src/data/api`.
 */
import React from 'react';
import * as api from '../../data/api';
import * as queries from '../../data/queries';
import { humanError } from '../../data/queries';
import {
  auditActionLabel,
  normalizeRole,
  normalizeVisibility,
  type ChatPermissions,
  type ChatRole,
  type ChatVisibility,
} from './ManageTypes';

/* --------------------------------------------------------------- фичефлаги -- */

const queryBag = queries as unknown as Record<string, ((...args: any[]) => any) | undefined>;
const apiBag = (api.api as unknown) as Record<string, ((...args: any[]) => any) | undefined>;

/** Вызов необязательного хука: если его ещё нет — undefined (без падения). */
export function useOptionalHook<T = any>(name: string, ...args: any[]): T | undefined {
  const fn = queryBag[name];
  return typeof fn === 'function' ? (fn(...args) as T) : undefined;
}

function pickArray(...values: unknown[]): any[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Достаём массив из типового ответа query/mutation. */
export function toArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    return pickArray(obj.items, obj.results, obj.list, obj.rows, obj.data) as T[];
  }
  return [];
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function firstStr(obj: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v) return v;
  }
  return fallback;
}

/* ------------------------------------------------------------------- модели -- */

export interface InviteLink {
  id: string;
  token: string;
  role: ChatRole;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  createdAt: string;
  revokedAt: string | null;
  createdBy?: string;
}

export interface JoinRequestItem {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  role: ChatRole;
  note: string;
  createdAt: string;
}

export interface ChatBanItem {
  userId: string;
  username: string;
  displayName: string;
  reason: string;
  until: string | null;
  createdAt: string;
}

export interface AuditItem {
  id: string;
  actorUsername: string;
  action: string;
  target: string;
  createdAt: string;
  meta: Record<string, unknown>;
}

export interface GroupSearchItem {
  id: string;
  title: string;
  type: 'group' | 'channel';
  visibility: ChatVisibility;
  description: string;
  membersCount: number;
  joined: boolean;
}

export interface InvitePreviewData {
  chatId: string;
  title: string;
  type: 'group' | 'channel';
  visibility: ChatVisibility;
  description: string;
  membersCount: number;
  isMember: boolean;
  banned: boolean;
  expired: boolean;
  invalid: boolean;
  pending: boolean;
  alreadyRequested: boolean;
}

/* ------------------------------------------------------------- нормализаторы -- */

export function normalizeInvite(row: any): InviteLink {
  const src = (row ?? {}) as Record<string, unknown>;
  return {
    id: firstStr(src, ['id', 'inviteId', 'invite_id']),
    token: firstStr(src, ['token', 'code', 'inviteToken', 'invite_token', 'key']),
    role: normalizeRole(src.role, 'member'),
    expiresAt: (firstStr(src, ['expiresAt', 'expires_at'], '') || null) as string | null,
    maxUses:
      typeof src.maxUses === 'number'
        ? src.maxUses
        : typeof src.max_uses === 'number'
          ? src.max_uses
          : null,
    uses: num(src.uses ?? src.useCount ?? src.use_count, 0),
    createdAt: firstStr(src, ['createdAt', 'created_at']),
    revokedAt: (firstStr(src, ['revokedAt', 'revoked_at'], '') || null) as string | null,
    createdBy: firstStr(src, ['createdBy', 'created_by', 'createdByUsername']) || undefined,
  };
}

export function normalizeRequest(row: any): JoinRequestItem {
  const src = (row ?? {}) as Record<string, unknown>;
  const user = (src.user ?? {}) as Record<string, unknown>;
  return {
    id: firstStr(src, ['id', 'requestId', 'request_id']) || `${firstStr(src, ['userId', 'user_id'])}-${firstStr(src, ['createdAt', 'created_at'])}`,
    userId: firstStr(src, ['userId', 'user_id'], firstStr(user, ['id', 'userId', 'user_id'])),
    username: firstStr(src, ['username', 'userName'], firstStr(user, ['username', 'userName'])),
    displayName: firstStr(src, ['displayName', 'display_name'], firstStr(user, ['displayName', 'display_name'])),
    role: normalizeRole(src.requestedRole ?? src.requested_role ?? src.role, 'member'),
    note: str(src.note),
    createdAt: firstStr(src, ['createdAt', 'created_at', 'requestedAt']),
  };
}

export function normalizeBan(row: any): ChatBanItem {
  const src = (row ?? {}) as Record<string, unknown>;
  const user = (src.user ?? {}) as Record<string, unknown>;
  return {
    userId: firstStr(src, ['userId', 'user_id'], firstStr(user, ['id', 'userId', 'user_id'])),
    username: firstStr(src, ['username', 'userName'], firstStr(user, ['username', 'userName'])),
    displayName: firstStr(src, ['displayName', 'display_name'], firstStr(user, ['displayName', 'display_name'])),
    reason: str(src.reason),
    until: (firstStr(src, ['until', 'untilAt', 'bannedUntil', 'expiresAt'], '') || null) as string | null,
    createdAt: firstStr(src, ['createdAt', 'created_at', 'bannedAt']),
  };
}

export function normalizeAudit(row: any): AuditItem {
  const src = (row ?? {}) as Record<string, unknown>;
  const rawId = src.id ?? src.auditId ?? src.audit_id;
  return {
    id:
      rawId !== undefined && rawId !== null
        ? String(rawId)
        : `${firstStr(src, ['createdAt', 'created_at'])}-${firstStr(src, ['action'])}`,
    actorUsername: firstStr(src, ['actorUsername', 'actor_username', 'actor', 'username']),
    action: firstStr(src, ['action', 'kind', 'type'], 'action'),
    target: firstStr(src, ['target', 'targetUsername', 'target_username']),
    createdAt: firstStr(src, ['createdAt', 'created_at', 'at', 'time']),
    meta: (src.meta && typeof src.meta === 'object' ? (src.meta as Record<string, unknown>) : {}),
  };
}

export function normalizeGroup(row: any): GroupSearchItem {
  const src = (row ?? {}) as Record<string, unknown>;
  return {
    id: firstStr(src, ['id', 'chatId', 'chat_id']),
    title: firstStr(src, ['title', 'name']),
    type: src.type === 'channel' ? 'channel' : 'group',
    visibility: normalizeVisibility(src.visibility, src.isPublic === false ? 'private' : 'public'),
    description: str(src.description),
    membersCount: num(src.membersCount ?? src.members_count ?? src.subscribers ?? src.members, 0),
    joined: bool(src.joined ?? src.isMember ?? src.subscribed ?? src.is_member, false),
  };
}

export function normalizePreview(row: any): InvitePreviewData {
  const root = (row ?? {}) as Record<string, unknown>;
  const chat = (root.chat ?? {}) as Record<string, unknown>;
  const src = { ...chat, ...root } as Record<string, unknown>;
  const state = firstStr(src, ['state', 'status']).toLowerCase();
  const validField = src.valid;
  return {
    chatId: firstStr(src, ['chatId', 'chat_id', 'id'], firstStr(chat, ['id', 'chatId'])),
    title: firstStr(src, ['title', 'name']),
    type: src.type === 'channel' ? 'channel' : 'group',
    visibility: normalizeVisibility(src.visibility, src.isPublic === false ? 'private' : 'public'),
    description: str(src.description),
    membersCount: num(src.membersCount ?? src.members_count ?? src.subscribers, 0),
    isMember: bool(src.isMember ?? src.joined ?? src.alreadyMember ?? src.subscribed, state === 'member' || state === 'joined'),
    banned: bool(src.banned ?? src.isBanned ?? src.blocked, state === 'banned' || state === 'blocked'),
    expired: bool(src.expired ?? src.isExpired, state === 'expired'),
    invalid:
      (typeof validField === 'boolean' ? !validField : bool(src.invalid ?? src.isInvalid, false)) ||
      state === 'invalid' ||
      state === 'not_found',
    pending: bool(src.pending ?? src.requested, state === 'pending' || state === 'requested'),
    alreadyRequested: bool(src.alreadyRequested ?? src.hasPendingRequest, state === 'pending' || state === 'requested'),
  };
}

/* ---------------------------------------------------------------- query-хуки -- */

interface ListHook<T> {
  data: T[];
  loading: boolean;
  error: string;
  available: boolean;
  refetch: () => Promise<void>;
}

function useListHook<T>(hookName: string, chatId: string, normalize: (row: any) => T): ListHook<T> {
  const res = useOptionalHook<any>(hookName, chatId);
  const raw = res?.data;
  const data = React.useMemo(() => toArray<any>(raw).map(normalize), [raw]);
  const refetch = React.useCallback(async () => {
    try {
      await res?.refetch?.();
    } catch {
      /* ошибку покажет пользовательский обработчик */
    }
  }, [res]);
  const error = res?.error ? manageError(res.error) : '';
  return {
    data,
    loading: Boolean(res?.isLoading ?? res?.isPending ?? (res && raw === undefined)),
    error,
    available: Boolean(res),
    refetch,
  };
}

export function useInvitesSafe(chatId: string) {
  return useListHook<InviteLink>('useInvites', chatId, normalizeInvite);
}

export function useJoinRequestsSafe(chatId: string) {
  return useListHook<JoinRequestItem>('useJoinRequests', chatId, normalizeRequest);
}

export function useChatBansSafe(chatId: string) {
  return useListHook<ChatBanItem>('useChatBans', chatId, normalizeBan);
}

export function useChatAuditSafe(chatId: string) {
  return useListHook<AuditItem>('useChatAudit', chatId, normalizeAudit);
}

export function useChatPermissionsSafe(chatId: string, fallback: ChatPermissions): {
  permissions: ChatPermissions;
  loading: boolean;
  available: boolean;
  refetch: () => Promise<void>;
} {
  const res = useOptionalHook<any>('useChatPermissionsQuery', chatId);
  const raw = res?.data;
  const permissions = React.useMemo<ChatPermissions>(() => {
    const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const src2 = src?.permissions && typeof src.permissions === 'object' ? (src.permissions as Record<string, unknown>) : src;
    if (!src2) return fallback;
    const merge = (role: 'admin' | 'moderator') => {
      const base = { ...fallback[role] };
      const stored = src2[role];
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
      for (const key of Object.keys(base) as (keyof typeof base)[]) {
        const v = (stored as Record<string, unknown>)[key];
        if (typeof v === 'boolean') base[key] = v;
      }
      return base;
    };
    return { admin: merge('admin'), moderator: merge('moderator') };
  }, [raw, fallback]);
  const refetch = React.useCallback(async () => {
    try {
      await res?.refetch?.();
    } catch {
      /* noop */
    }
  }, [res]);
  return { permissions, loading: Boolean(res?.isLoading), available: Boolean(res), refetch };
}

export function useSearchGroupsSafe(query: string): { groups: GroupSearchItem[]; loading: boolean } {
  const res = useOptionalHook<any>('useSearchGroups', query.trim());
  const data = res?.data;
  const groups = React.useMemo(() => toArray<any>(data).map(normalizeGroup), [data]);
  return { groups, loading: Boolean(res?.isLoading) };
}

/** Превью приглашения для страницы /join/[token]. */
export function useInvitePreviewSafe(token: string) {
  const res = useOptionalHook<any>('useInvitePreview', token);
  const raw = res?.data;
  const preview = React.useMemo(() => normalizePreview(raw), [raw]);
  return {
    preview,
    hasData: raw != null,
    loading: Boolean(res?.isLoading),
    error: res?.error ? manageError(res.error) : '',
    available: Boolean(res),
    refetch: React.useCallback(async () => {
      try {
        await res?.refetch?.();
      } catch {
        /* noop */
      }
    }, [res]),
  };
}

/* ----------------------------------------------------------------- действия -- */

export async function callManageApi<T = any>(name: string, ...args: any[]): Promise<T> {
  const fn = apiBag[name];
  if (typeof fn !== 'function') {
    throw new Error(`Серверная функция «${name}» пока недоступна. Обновите приложение.`);
  }
  return (await fn(...args)) as T;
}

/** Человекочитаемая ошибка; отдельно объясняем запрет приглашений. */
export function manageError(e: unknown): string {
  if (e instanceof api.ApiError) {
    switch (e.code) {
      case 'invite_forbidden':
        return 'Пользователь запретил приглашения в личных настройках приватности.';
      case 'already_member':
        return 'Пользователь уже состоит в этом чате.';
      case 'already_pending':
        return 'Заявка уже отправлена и ожидает решения.';
      case 'invite_expired':
      case 'link_expired':
        return 'Срок действия ссылки истёк.';
      case 'invite_revoked':
        return 'Ссылка была отозвана.';
      case 'invite_invalid':
      case 'invalid_invite':
        return 'Ссылка недействительна.';
      case 'banned':
      case 'user_banned':
        return 'Доступ запрещён: пользователь заблокирован в этом чате.';
      case 'cannot_remove_owner':
        return 'Нельзя исключить владельца чата.';
      case 'owner_required':
        return 'Действие доступно только владельцу.';
      default:
        break;
    }
  }
  if (e instanceof Error && e.message) return e.message;
  return humanError(e);
}

export const manageActions = {
  createInvite: (chatId: string, input: { role?: ChatRole; expiresInHours?: number | null; maxUses?: number | null }) =>
    callManageApi('createInvite', chatId, input),
  revokeInvite: (chatId: string, inviteId: string) => callManageApi('revokeInvite', chatId, inviteId),
  directInvite: (chatId: string, username: string) => callManageApi('directInvite', chatId, username),
  approveRequest: (chatId: string, userId: string) => callManageApi('approveRequest', chatId, userId),
  rejectRequest: (chatId: string, userId: string) => callManageApi('rejectRequest', chatId, userId),
  setMemberRole: (chatId: string, userId: string, role: ChatRole) =>
    callManageApi('setMemberRole', chatId, userId, role),
  removeMember: (chatId: string, userId: string) => callManageApi('removeMember', chatId, userId),
  banMember: (chatId: string, userId: string, input: { reason?: string; durationHours?: number | null }) =>
    callManageApi('banMember', chatId, {
      userId,
      reason: input.reason ?? '',
      ...(typeof input.durationHours === 'number' && input.durationHours > 0
        ? { durationHours: input.durationHours }
        : {}),
    }),
  unbanMember: (chatId: string, userId: string) => callManageApi('unbanMember', chatId, userId),
  transferOwnership: (chatId: string, userId: string) => callManageApi('transferOwnership', chatId, userId),
  patchChat: (chatId: string, patch: { title?: string; description?: string; visibility?: ChatVisibility }) =>
    callManageApi('patchChat', chatId, patch),
  setChatPermissions: (chatId: string, permissions: ChatPermissions) =>
    callManageApi('setChatPermissions', chatId, permissions),
  /** Сохранить аватар чата (файл уже загружен на узлы). */
  setChatAvatar: (chatId: string, input: { objectId: string; key: string; mime: string }) =>
    callManageApi('setChatAvatar', chatId, input),
  deleteChatAvatar: (chatId: string) => callManageApi('deleteChatAvatar', chatId),
  previewInvite: (token: string) => callManageApi('invitePreview', token),
  joinInvite: (token: string) => callManageApi('joinInvite', token),
};

export interface JoinOutcome {
  chatId: string;
  status: 'joined' | 'pending';
}

/** Вступление по ссылке; понимает разные формы ответа сервера. */
export async function joinByInvite(token: string): Promise<JoinOutcome> {
  const raw: any = await callManageApi('joinInvite', token);
  const src = (raw ?? {}) as Record<string, any>;
  const inner = src.chat && typeof src.chat === 'object' ? src.chat : src;
  const status = String(src.status ?? src.state ?? '').toLowerCase();
  const pending = status === 'pending' || status === 'requested' || Boolean(src.pending ?? src.requested);
  return {
    chatId: String(src.chatId ?? src.chat_id ?? inner.id ?? ''),
    status: pending ? 'pending' : 'joined',
  };
}

/**
 * Вступление/заявка в найденную в поиске группу (без invite-токена).
 * Если data/API ещё не умеет самостоятельное вступление по id — объясняем,
 * что нужна пригласительная ссылка (не подменяем это фейковым успехом).
 */
export async function joinByChatId(chatId: string): Promise<JoinOutcome> {
  for (const name of ['joinChat', 'requestJoin']) {
    if (typeof apiBag[name] === 'function') {
      const raw: any = await apiBag[name]!(chatId);
      const src = (raw ?? {}) as Record<string, any>;
      const status = String(src.status ?? src.state ?? '').toLowerCase();
      const pending = name === 'requestJoin' || status === 'pending' || status === 'requested' || Boolean(src.pending);
      return { chatId: String(src.chatId ?? src.chat_id ?? src.chat?.id ?? chatId), status: pending ? 'pending' : 'joined' };
    }
  }
  throw new Error('Вступление по поиску пока недоступно. Попросите пригласительную ссылку у администратора.');
}

/* --------------------------------------------------------- ссылки и буфер -- */

/** Origin для полной ссылки приглашения. */
export function originOf(): string {
  const loc = (globalThis as any)?.location;
  if (loc && typeof loc.origin === 'string' && loc.origin) return loc.origin;
  return '';
}

export function inviteUrl(token: string): string {
  const origin = originOf();
  return `${origin || 'https://klinto.app'}/join/${encodeURIComponent(token)}`;
}

export async function copyText(text: string): Promise<boolean> {
  const nav = (globalThis as any)?.navigator;
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* ниже — запасной путь */
  }
  try {
    if (typeof document !== 'undefined') {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export async function shareText(title: string, text: string): Promise<boolean> {
  const nav = (globalThis as any)?.navigator;
  if (nav?.share) {
    try {
      await nav.share({ title, text });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export { auditActionLabel };
