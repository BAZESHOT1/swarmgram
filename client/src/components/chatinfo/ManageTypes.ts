/**
 * Типы и константы управления группой/каналом.
 *
 * Важно: data-слой (client/src/data) обновляется параллельным агентом.
 * Здесь описаны только UI-контракты и безопасные нормализаторы, чтобы
 * экран управления не зависел от момента, когда поля появятся в `Chat`.
 */
import type { Chat } from '../../data/api';

export type ChatVisibility = 'public' | 'closed' | 'private';
export type ChatRole = 'owner' | 'admin' | 'moderator' | 'member';

export interface PermissionSet {
  manageInfo: boolean;
  manageMembers: boolean;
  manageRoles: boolean;
  manageInvites: boolean;
  manageRequests: boolean;
  manageBans: boolean;
  deleteMessages: boolean;
  pinMessages: boolean;
  publish: boolean;
  /** Смена аватара группы/канала (владелец не ограничивается). */
  setAvatar: boolean;
}

export interface ChatPermissions {
  admin: PermissionSet;
  moderator: PermissionSet;
}

export type PermissionKey = keyof PermissionSet;

/** Поля расширения Chat, которые приносит data-слой. Все опциональны. */
export interface ManageChatExtra {
  visibility?: ChatVisibility;
  description?: string;
  permissions?: ChatPermissions | Record<string, unknown> | null;
  myRole?: ChatRole;
  pendingRequests?: number;
}

export type ManageChat = Chat & ManageChatExtra;

/** Права администратора по умолчанию (совпадают с сервером). */
export const DEFAULT_ADMIN_PERMISSIONS: PermissionSet = {
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
};

/** Права модератора по умолчанию (совпадают с сервером). */
export const DEFAULT_MODERATOR_PERMISSIONS: PermissionSet = {
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
};

export const DEFAULT_PERMISSIONS: ChatPermissions = {
  admin: DEFAULT_ADMIN_PERMISSIONS,
  moderator: DEFAULT_MODERATOR_PERMISSIONS,
};

export const PERMISSION_ITEMS: {
  key: PermissionKey;
  label: string;
  hint: string;
  icon: string;
}[] = [
  { key: 'manageInfo', label: 'Информация', hint: 'Название, описание и тип чата', icon: 'create-outline' },
  { key: 'manageMembers', label: 'Участники', hint: 'Добавлять и исключать участников', icon: 'people-outline' },
  { key: 'manageRoles', label: 'Роли', hint: 'Назначать администраторов и модераторов', icon: 'ribbon-outline' },
  { key: 'manageInvites', label: 'Ссылки', hint: 'Создавать и отзывать приглашения', icon: 'link-outline' },
  { key: 'manageRequests', label: 'Заявки', hint: 'Принимать и отклонять заявки', icon: 'mail-unread-outline' },
  { key: 'manageBans', label: 'Блокировки', hint: 'Блокировать и разблокировать', icon: 'ban-outline' },
  { key: 'deleteMessages', label: 'Удаление сообщений', hint: 'Удалять сообщения участников', icon: 'trash-outline' },
  { key: 'pinMessages', label: 'Закрепление', hint: 'Закреплять сообщения', icon: 'pin-outline' },
  { key: 'publish', label: 'Публикация', hint: 'Публиковать посты в канале', icon: 'megaphone-outline' },
  { key: 'setAvatar', label: 'Смена аватара', hint: 'Устанавливать и удалять аватар группы/канала', icon: 'image-outline' },
];

export const ROLE_LABEL: Record<ChatRole, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  moderator: 'Модератор',
  member: 'Участник',
};

/** Понятные подписи типов видимости (с учётом рода: группа/канал). */
export function visibilityLabel(v: ChatVisibility, type: 'group' | 'channel' = 'group'): string {
  if (v === 'public') return type === 'channel' ? 'Публичный' : 'Публичная';
  if (v === 'closed') return type === 'channel' ? 'Закрытый' : 'Закрытая';
  return type === 'channel' ? 'Частный' : 'Частная';
}

export const VISIBILITY_META: Record<
  ChatVisibility,
  { label: string; description: string; icon: 'globe-outline' | 'shield-half-outline' | 'key-outline' }
> = {
  public: {
    label: 'Публичная',
    description: 'Видна в поиске, вступить может каждый',
    icon: 'globe-outline',
  },
  closed: {
    label: 'Закрытая',
    description: 'Видна в поиске, вступление по заявке',
    icon: 'shield-half-outline',
  },
  private: {
    label: 'Частная',
    description: 'Только по приглашению или ссылке',
    icon: 'key-outline',
  },
};

export const VISIBILITY_ORDER: ChatVisibility[] = ['public', 'closed', 'private'];

export function normalizeVisibility(value: unknown, fallback: ChatVisibility = 'public'): ChatVisibility {
  if (value === 'public' || value === 'closed' || value === 'private') return value;
  if (value === true) return 'public';
  if (value === false) return 'private';
  return fallback;
}

export function normalizeRole(value: unknown, fallback: ChatRole = 'member'): ChatRole {
  if (value === 'owner' || value === 'admin' || value === 'moderator' || value === 'member') return value;
  return fallback;
}

/** Эффективные права: сохранённые переопределения поверх дефолтов сервера. */
export function resolvePermissions(chat: ManageChat | null | undefined): ChatPermissions {
  const stored = chat?.permissions;
  const merge = (role: 'admin' | 'moderator'): PermissionSet => {
    const base = { ...DEFAULT_PERMISSIONS[role] };
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
    const src = (stored as Record<string, unknown>)[role];
    if (!src || typeof src !== 'object' || Array.isArray(src)) return base;
    for (const item of PERMISSION_ITEMS) {
      const v = (src as Record<string, unknown>)[item.key];
      if (typeof v === 'boolean') base[item.key] = v;
    }
    return base;
  };
  return { admin: merge('admin'), moderator: merge('moderator') };
}

/** Роль пользователя в чате: серверное myRole важнее списка участников. */
export function roleOf(chat: ManageChat | null | undefined, username: string): ChatRole {
  if (!chat) return 'member';
  if (chat.ownerUsername && chat.ownerUsername === username) return 'owner';
  if (chat.myRole) return normalizeRole(chat.myRole);
  const member = chat.members?.find((m) => m.username === username);
  return normalizeRole(member?.role);
}

/** Есть ли у пользователя конкретное право. Владелец всегда всё. */
export function hasRight(
  chat: ManageChat | null | undefined,
  username: string,
  key: PermissionKey,
): boolean {
  if (!chat) return false;
  if (chat.ownerUsername === username || roleOf(chat, username) === 'owner') return true;
  const role = roleOf(chat, username);
  if (role !== 'admin' && role !== 'moderator') return false;
  return resolvePermissions(chat)[role][key];
}

/** Доступна ли вкладка «Управление»: владелец, либо роль с любым правом. */
export function canOpenManage(chat: ManageChat | null | undefined, username: string): boolean {
  if (!chat || chat.type === 'direct') return false;
  const role = roleOf(chat, username);
  if (role === 'owner') return true;
  if (role !== 'admin' && role !== 'moderator') return false;
  const perms = resolvePermissions(chat)[role];
  return PERMISSION_ITEMS.some((item) => perms[item.key]);
}

export function visibilityOf(chat: ManageChat | null | undefined): ChatVisibility {
  if (!chat) return 'public';
  return normalizeVisibility(chat.visibility, chat.isPublic === false ? 'private' : 'public');
}

/** Человекочитаемая дата без падения на невалидном ISO. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Срок действия приглашения/бана в часах → подпись. */
export function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || hours <= 0) return 'Бессрочно';
  if (hours === 24) return '24 часа';
  if (hours === 168) return '7 дней';
  if (hours === 720) return '30 дней';
  if (hours % 24 === 0) return `${hours / 24} дн.`;
  return `${hours} ч`;
}

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  chat_create: 'создал чат',
  chat_patch: 'изменил информацию',
  chat_update: 'изменил информацию',
  chat_updated: 'изменил информацию',
  permissions_change: 'изменил права',
  permissions_update: 'изменил права',
  permissions_changed: 'изменил права',
  invite_create: 'создал ссылку',
  invite_created: 'создал ссылку',
  invite_revoke: 'отозвал ссылку',
  invite_revoked: 'отозвал ссылку',
  invite_joined: 'вступил по ссылке',
  direct_invite: 'пригласил напрямую',
  member_invited: 'пригласил участника',
  member_join: 'вступил в чат',
  member_leave: 'покинул чат',
  member_remove: 'исключил участника',
  member_removed: 'исключил участника',
  member_add: 'добавил участника',
  member_role_changed: 'изменил роль',
  role_change: 'изменил роль',
  request_approve: 'принял заявку',
  request_approved: 'принял заявку',
  request_reject: 'отклонил заявку',
  request_rejected: 'отклонил заявку',
  member_banned: 'заблокировал участника',
  ban: 'заблокировал участника',
  member_unbanned: 'разблокировал участника',
  unban: 'разблокировал участника',
  ownership_transferred: 'передал владение',
  transfer_ownership: 'передал владение',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? action.replace(/_/g, ' ');
}
