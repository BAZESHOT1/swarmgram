import React, { useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, Text, TextInput, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '../../src/data/api';
import { useTheme } from '../../src/theme/useTheme';
import { useCreateChat, humanError } from '../../src/data/queries';
import { createAndShareChatKey } from '../../src/data/chatkit';
import { refreshKeyBackup } from '../../src/data/auth';
import { storage, publicJwkOf } from '../../src/crypto/core';
import { Btn } from '../../src/components/Btn';
import { useStore } from '../../src/state/useStore';
import { ManageChoice } from '../../src/components/chatinfo/ManageUI';
import {
  VISIBILITY_META,
  VISIBILITY_ORDER,
  visibilityLabel,
  type ChatVisibility,
} from '../../src/components/chatinfo/ManageTypes';

type Mode = 'direct' | 'group' | 'channel';

export default function ComposeScreen() {
  const router = useRouter();
  const theme = useTheme();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ mode?: string }>();
  const initialMode: Mode = params.mode === 'group' ? 'group' : params.mode === 'channel' ? 'channel' : 'direct';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [peer, setPeer] = useState('');
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState('');
  const [visibility, setVisibility] = useState<ChatVisibility>('public');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const createChat = useCreateChat();

  async function ensureChatKey(devices: { deviceId: string; ecdhPub: string }[], chatId: string, title: string) {
    const keys = await storage.loadKeys();
    if (!keys) return;
    // !! важно: не пересоздаём ключ чата, если он уже на сервере для нашего устройства
    // (иначе теряется история). Ключ создаётся один раз и оборачивается для всех устройств.
    const existing = await api.api.myChatKeys(chatId).catch(() => [] as { deviceId: string; wrappedKey: string }[]);
    const hasForUs = existing.some((row) => row.deviceId === keys.deviceId);
    if (hasForUs) return;
    const missingForPeer = existing.length === 0;
    await createAndShareChatKey(
      chatId,
      [{ deviceId: keys.deviceId, ecdhPub: JSON.stringify(publicJwkOf(keys.ecdhPriv)) }, ...devices],
      keys,
    );
    void refreshKeyBackup();
    if (missingForPeer) {
      useStore.getState().pushToast({ kind: 'info', message: `Ключ чата создан и отправлен устройствам собеседников` });
    }
    void title;
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (mode === 'direct') {
        const bundle = await api.api.getBundle(peer.trim().toLowerCase());
        const chat = await createChat.mutateAsync({ type: 'direct', username: peer.trim().toLowerCase() });
        // обычные чаты используют серверный ключ; E2E-ключи создаём только для секретных
        if (chat.encryption !== 'server') {
          await ensureChatKey(bundle.devices.map((d) => ({ deviceId: d.deviceId, ecdhPub: d.ecdhPub })), chat.id, title.trim());
        }
        useStore.getState().pushToast({ kind: 'success', message: `Чат с @${peer.trim().toLowerCase()} создан` });
        router.replace(`/chat/${chat.id}` as never);
      } else if (mode === 'group') {
        const names = members.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
        const chat = await createChat.mutateAsync({
          type: 'group',
          title: title.trim() || 'Группа',
          members: names,
          // visibility/description ещё не в публичном типе createChat — data-слой обновляется параллельно.
          visibility,
          description: description.trim(),
        } as any);
        if (chat.encryption !== 'server') {
          await ensureChatKey([], chat.id, title.trim());
        }
        useStore.getState().pushToast({ kind: 'success', message: 'Группа создана' });
        router.replace(`/chat/${chat.id}` as never);
      } else {
        // Каналы создаём тем же маршрутом /chats: он принимает visibility/description
        // (см. services/hub/src/routes/chats.ts), в отличие от /channels.
        const channel = await createChat.mutateAsync({
          type: 'channel',
          title: title.trim(),
          visibility,
          description: description.trim(),
        } as any);
        void qc.invalidateQueries({ queryKey: ['channels'] });
        useStore.getState().pushToast({ kind: 'success', message: `Канал «${channel.title}» создан` });
        router.replace(`/chat/${channel.id}` as never);
      }
    } catch (e) {
      const err = humanError(e);
      setError(err);
      useStore.getState().pushToast({ kind: 'error', message: err, actionLabel: 'Повторить', action: () => void submit() });
    } finally {
      setBusy(false);
    }
  }

  const tabs: { key: Mode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: 'direct', label: 'Личный', icon: 'chatbubbles-outline' },
    { key: 'group', label: 'Группа', icon: 'people-outline' },
    { key: 'channel', label: 'Канал', icon: 'megaphone-outline' },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
      <View style={[styles.header, { borderBottomColor: theme.line }]}>
        <Pressable onPress={() => router.back()} accessibilityLabel="Назад" accessibilityRole="button" style={styles.back}>
          <Ionicons name="close" size={22} color={theme.textSecondary} />
        </Pressable>
        <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: theme.fontL }}>Создать</Text>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 120 }}
      >
        <View style={[styles.tabs, { borderColor: theme.line, backgroundColor: theme.surface }]}>
          {tabs.map((t) => (
            <Pressable
              key={t.key}
              onPress={() => setMode(t.key)}
              accessibilityRole="button"
              accessibilityLabel={`Режим ${t.label}`}
              style={({ pressed }) => [styles.tab, mode === t.key && { backgroundColor: theme.accent, borderRadius: 10 }, pressed && { opacity: 0.8 }]}
            >
              <Ionicons name={t.icon} size={15} color={mode === t.key ? theme.onAccent : theme.textSecondary} />
              <Text style={{ color: mode === t.key ? theme.onAccent : theme.textSecondary, fontSize: 13, fontWeight: '600' }}>{t.label}</Text>
            </Pressable>
          ))}
        </View>

        {mode === 'direct' ? (
          <>
            <Text style={{ color: theme.textSecondary, fontSize: 13 }}>Username собеседника</Text>
            <TextInput
              value={peer}
              onChangeText={setPeer}
              autoCapitalize="none"
              accessibilityLabel="Username собеседника"
              placeholder="например, imbirok"
              placeholderTextColor={theme.textDisabled}
              style={[styles.input, { borderColor: theme.line, color: theme.textPrimary, backgroundColor: theme.surface }]}
            />
          </>
        ) : (
          <>
            <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
              {mode === 'group' ? 'Название группы' : 'Название канала'}
            </Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              accessibilityLabel={mode === 'group' ? 'Название группы' : 'Название канала'}
              placeholder={mode === 'group' ? 'Например: Команда' : 'Например: Новости Klinto'}
              placeholderTextColor={theme.textDisabled}
              style={[styles.input, { borderColor: theme.line, color: theme.textPrimary, backgroundColor: theme.surface }]}
            />
            {mode === 'group' ? (
              <>
                <Text style={{ color: theme.textSecondary, fontSize: 13 }}>Участники через запятую</Text>
                <TextInput
                  value={members}
                  onChangeText={setMembers}
                  autoCapitalize="none"
                  accessibilityLabel="Участники группы"
                  placeholder="user1, user2"
                  placeholderTextColor={theme.textDisabled}
                  style={[styles.input, { borderColor: theme.line, color: theme.textPrimary, backgroundColor: theme.surface }]}
                />
              </>
            ) : null}

            <Text style={{ color: theme.textSecondary, fontSize: 13, marginTop: 4 }}>
              Тип {mode === 'group' ? 'группы' : 'канала'}
            </Text>
            <ManageChoice
              options={VISIBILITY_ORDER.map((v) => ({
                value: v,
                label: visibilityLabel(v, mode === 'channel' ? 'channel' : 'group'),
                hint: VISIBILITY_META[v].description,
                icon: VISIBILITY_META[v].icon,
              }))}
              value={visibility}
              onChange={setVisibility}
              compact
              disabled={busy}
            />

            <Text style={{ color: theme.textSecondary, fontSize: 13, marginTop: 4 }}>Описание (необязательно)</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              multiline
              maxLength={500}
              accessibilityLabel="Описание"
              placeholder={mode === 'group' ? 'О чём эта группа' : 'О чём этот канал'}
              placeholderTextColor={theme.textDisabled}
              style={[
                styles.input,
                styles.multiline,
                { borderColor: theme.line, color: theme.textPrimary, backgroundColor: theme.surface },
              ]}
            />
            <Text style={{ color: theme.textDisabled, fontSize: 10.5, textAlign: 'right', marginTop: -4 }}>
              {description.length}/500
            </Text>
          </>
        )}

        {error ? <Text style={{ color: theme.danger, fontSize: 14 }}>{error}</Text> : null}
        <Btn
          title={mode === 'direct' ? 'Создать чат' : mode === 'group' ? 'Создать группу' : 'Создать канал'}
          loading={busy}
          disabled={mode === 'direct' ? !peer.trim() : !title.trim()}
          onPress={() => void submit()}
        />
        <View style={{ height: 90 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 48, paddingHorizontal: 14, paddingBottom: 12, borderBottomWidth: 1, flexDirection: 'row', gap: 12, alignItems: 'center' },
  back: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', gap: 2, borderWidth: 1, borderRadius: 14, padding: 3 },
  tab: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingVertical: 9, borderRadius: 10 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  multiline: { minHeight: 74, textAlignVertical: 'top' },
});
