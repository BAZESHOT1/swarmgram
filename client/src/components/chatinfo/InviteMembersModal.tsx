/**
 * «Добавить участников»: список собеседников по личным чатам и поиск по всем пользователям.
 * Пользователей, которых нельзя пригласить по их настройкам приватности, показываем
 * неактивными с подписью; уже состоящих — с отметкой «уже в чате».
 */
import React from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as api from '../../data/api';
import { useStore } from '../../state/useStore';
import { useTheme } from '../../theme/useTheme';
import { Avatar } from '../Avatar';
import { manageError } from './ManageData';

type Candidate = Awaited<ReturnType<typeof api.api.inviteCandidates>>[number];

export function InviteMembersModal({ visible, chatId, title, onClose }: { visible: boolean; chatId: string; title: string; onClose: () => void }) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const [q, setQ] = React.useState('');
  const [items, setItems] = React.useState<Candidate[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [added, setAdded] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      setLoading(true);
      api.api
        .inviteCandidates(chatId, q.trim().length >= 2 ? q.trim() : '')
        .then((rows) => alive && setItems(rows))
        .catch((e) => alive && pushToast({ kind: 'error', message: manageError(e) }))
        .finally(() => alive && setLoading(false));
    }, q ? 300 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [visible, chatId, q, pushToast]);

  React.useEffect(() => {
    if (!visible) {
      setQ('');
      setAdded(new Set());
    }
  }, [visible]);

  async function invite(c: Candidate) {
    if (!c.invitable) {
      pushToast({
        kind: 'info',
        message: c.reason === 'already_member' ? `@${c.username} уже в чате` : `@${c.username} запретил приглашать себя в группы и каналы`,
      });
      return;
    }
    setBusy(c.userId);
    try {
      await api.api.directInvite(chatId, c.username);
      setAdded((prev) => new Set(prev).add(c.userId));
      pushToast({ kind: 'success', message: `@${c.username} добавлен в «${title}»` });
    } catch (e) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 16 }} onPress={onClose}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{ width: '100%', maxWidth: 480, maxHeight: '82%', alignSelf: 'center', borderRadius: 24, padding: 16, gap: 12, backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.line }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ color: theme.textPrimary, fontSize: 18, fontWeight: '800', flex: 1 }}>Добавить участников</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть" hitSlop={10}>
              <Ionicons name="close" size={22} color={theme.textSecondary} />
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: theme.line, backgroundColor: theme.surface }}>
            <Ionicons name="search" size={16} color={theme.textDisabled} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Поиск по имени или @username"
              placeholderTextColor={theme.textDisabled}
              autoCapitalize="none"
              style={{ flex: 1, color: theme.textPrimary, paddingVertical: 11, fontSize: 15 }}
            />
            {loading ? <ActivityIndicator size="small" color={theme.accent} /> : null}
          </View>
          <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
            {q.trim().length >= 2 ? 'Результаты поиска' : 'Люди, с которыми у вас есть чат'}
          </Text>
          <FlatList
            data={items}
            keyExtractor={(c) => c.userId}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              loading ? null : (
                <Text style={{ color: theme.textDisabled, textAlign: 'center', paddingVertical: 20 }}>
                  {q.trim().length >= 2 ? 'Никого не нашли' : 'Найдите пользователя через поиск'}
                </Text>
              )
            }
            renderItem={({ item: c }) => {
              const done = added.has(c.userId) || c.reason === 'already_member';
              const blocked = !c.invitable && !done;
              return (
                <Pressable
                  onPress={() => void invite(c)}
                  disabled={done || busy === c.userId}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: blocked || done }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 9,
                    opacity: blocked ? 0.45 : pressed ? 0.75 : 1,
                  })}
                >
                  <Avatar name={c.displayName || c.username} size={42} avatar={c.avatar} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                      {c.displayName || c.username}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 12.5 }} numberOfLines={1}>
                      @{c.username}
                      {blocked ? ' · запретил приглашения' : done ? ' · уже в чате' : ''}
                    </Text>
                  </View>
                  {busy === c.userId ? (
                    <ActivityIndicator size="small" color={theme.accent} />
                  ) : done ? (
                    <Ionicons name="checkmark-circle" size={22} color={theme.success} />
                  ) : blocked ? (
                    <Ionicons name="lock-closed-outline" size={18} color={theme.textDisabled} />
                  ) : (
                    <Ionicons name="add-circle" size={24} color={theme.accent} />
                  )}
                </Pressable>
              );
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
