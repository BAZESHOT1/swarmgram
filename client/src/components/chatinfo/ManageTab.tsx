/**
 * Вкладка «Управление»: подразделы видимости, прав, ссылок, заявок,
 * блокировок, журнала и опасных действий. Набор подразделов зависит от роли
 * и матрицы прав (владельцу доступно всё).
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../theme/useTheme';
import { useChatPermissionsSafe, useJoinRequestsSafe } from './ManageData';
import { ManageChips } from './ManageUI';
import { ManageInfo } from './ManageInfo';
import { ManagePermissions } from './ManagePermissions';
import { ManageInvites } from './ManageInvites';
import { ManageRequests } from './ManageRequests';
import { ManageBans } from './ManageBans';
import { ManageAudit } from './ManageAudit';
import { ManageDanger } from './ManageDanger';
import {
  hasRight,
  resolvePermissions,
  roleOf,
  type ManageChat,
} from './ManageTypes';

export function ManageTab({
  chat,
  myUsername,
  onChanged,
  onDelete,
}: {
  chat: ManageChat;
  myUsername: string;
  onChanged: () => Promise<void> | void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const role = roleOf(chat, myUsername);
  const isOwner = role === 'owner';
  const canInfo = hasRight(chat, myUsername, 'manageInfo');
  const canInvites = hasRight(chat, myUsername, 'manageInvites');
  const canRequests = hasRight(chat, myUsername, 'manageRequests');
  const canBans = hasRight(chat, myUsername, 'manageBans');
  const canAudit = isOwner || role === 'admin';

  const requests = useJoinRequestsSafe(chat.id);
  const pendingCount = requests.data.length || chat.pendingRequests || 0;
  const fallbackPerms = React.useMemo(
    () => resolvePermissions(chat),
    [chat.id, chat.permissions, chat.ownerUsername, chat.myRole],
  );
  const perms = useChatPermissionsSafe(chat.id, fallbackPerms);
  const qc = useQueryClient();

  // Действия ниже дергают api напрямую; принудительно обновляем список чатов,
  // чтобы бейдж заявок и роли в списке не отставали.
  const refresh = React.useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['chats'] });
    await qc.invalidateQueries({ queryKey: ['requests', chat.id] });
    await qc.invalidateQueries({ queryKey: ['invites', chat.id] });
    await qc.invalidateQueries({ queryKey: ['bans', chat.id] });
    await qc.invalidateQueries({ queryKey: ['audit', chat.id] });
    await onChanged();
  }, [qc, chat.id, onChanged]);

  const items = React.useMemo(() => {
    const list: { key: string; label: string; badge?: number }[] = [{ key: 'info', label: 'Информация' }];
    if (isOwner) list.push({ key: 'rights', label: 'Права' });
    if (canInvites) list.push({ key: 'links', label: 'Ссылки' });
    if (canRequests) list.push({ key: 'requests', label: 'Заявки', badge: pendingCount });
    if (canBans) list.push({ key: 'bans', label: 'Блокировки' });
    if (canAudit) list.push({ key: 'audit', label: 'Журнал' });
    if (isOwner) list.push({ key: 'danger', label: 'Опасное' });
    return list;
  }, [isOwner, canInvites, canRequests, canBans, canAudit, pendingCount]);

  const [tab, setTab] = React.useState(canRequests && pendingCount > 0 ? 'requests' : 'info');

  // После смены роли/прав активный подраздел может исчезнуть — возвращаемся к «Информации».
  React.useEffect(() => {
    if (!items.some((item) => item.key === tab)) setTab('info');
  }, [items, tab]);

  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 4,
          marginBottom: 9,
        }}
      >
        <View style={{ width: 27, height: 27, borderRadius: 9, backgroundColor: theme.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="settings-outline" size={15} color={theme.accent} />
        </View>
        <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '800' }}>Управление</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 11.5, flex: 1 }} numberOfLines={1}>
          {isOwner ? 'Владелец' : role === 'admin' ? 'Администратор' : role === 'moderator' ? 'Модератор' : 'Участник'}
        </Text>
      </View>

      <ManageChips items={items} value={tab} onChange={setTab} />

      <View style={{ marginTop: 10 }}>
        {tab === 'info' ? <ManageInfo chat={chat} canEdit={canInfo} onChanged={refresh} /> : null}

        {tab === 'rights' && isOwner ? (
          <ManagePermissions
            chatId={chat.id}
            permissions={perms.permissions}
            loading={perms.loading}
            onSaved={async () => {
              await perms.refetch();
              await refresh();
            }}
          />
        ) : null}

        {tab === 'links' ? <ManageInvites chatId={chat.id} chatTitle={chat.title} onChanged={refresh} /> : null}

        {tab === 'requests' ? <ManageRequests chatId={chat.id} onChanged={refresh} /> : null}

        {tab === 'bans' ? <ManageBans chat={chat} onChanged={refresh} /> : null}

        {tab === 'audit' ? <ManageAudit chat={chat} /> : null}

        {tab === 'danger' && isOwner ? <ManageDanger chat={chat} onChanged={refresh} onDelete={onDelete} /> : null}
      </View>
    </View>
  );
}
