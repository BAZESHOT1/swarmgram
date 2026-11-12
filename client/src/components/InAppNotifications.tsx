/**
 * In-app уведомления: плавающие карточки о новых сообщениях и системных
 * событиях. Не показываются, если соответствующий чат уже открыт.
 *
 * - тап — открыть чат и проскроллить к сообщению;
 * - долгое нажатие — быстрый ответ прямо из уведомления (с клавиатурой),
 *   ответ уходит реплаем на это сообщение;
 * - свайп вверх — принудительно скрыть.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/useTheme';
import { useStore, type InAppNotice } from '../state/useStore';
import { sendMessage } from '../data/messaging';
import { useSounds } from './useSounds';
import { useHaptics } from './useHaptics';

const AUTO_DISMISS_MS = 6500;
const SWIPE_UP = -34;

function NoticeCard({
  notice,
  onPress,
  onReply,
  onDismiss,
}: {
  notice: InAppNotice;
  onPress: () => void;
  onReply: () => void;
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const dismissed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    clearTimer();
    Animated.parallel([
      Animated.timing(translateY, { toValue: -44, duration: 150, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }),
    ]).start(() => onDismiss());
  }, [clearTimer, onDismiss, opacity, translateY]);

  const schedule = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(dismiss, AUTO_DISMISS_MS);
  }, [clearTimer, dismiss]);

  useEffect(() => {
    schedule();
    return clearTimer;
  }, [schedule, clearTimer]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy < -8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.4,
      onPanResponderGrant: () => {
        clearTimer();
        translateY.stopAnimation();
      },
      onPanResponderMove: (_e, g) => {
        if (g.dy < 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy < SWIPE_UP || g.vy < -0.5) {
          dismiss();
          return;
        }
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 18, stiffness: 220 }).start();
        schedule();
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
        schedule();
      },
    }),
  ).current;

  return (
    <Animated.View
      style={[
        styles.card,
        {
          backgroundColor: theme.surface,
          borderColor: theme.glassBorder,
          transform: [{ translateY }],
          opacity,
        },
      ]}
      {...pan.panHandlers}
    >
      <Pressable
        onPress={() => {
          clearTimer();
          onPress();
        }}
        onLongPress={() => {
          clearTimer();
          onReply();
        }}
        onPressIn={clearTimer}
        onPressOut={schedule}
        delayLongPress={360}
        accessibilityRole="button"
        accessibilityLabel={`${notice.title}: ${notice.body}. Удерживайте для быстрого ответа`}
        style={styles.row}
      >
        <View style={[styles.icon, { backgroundColor: theme.accentSoft }]}>
          <Ionicons
            name={notice.kind === 'message' ? 'chatbubble-ellipses' : 'information-circle'}
            size={18}
            color={theme.accent}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700' }}>
            {notice.title}
          </Text>
          <Text numberOfLines={2} style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 17 }}>
            {notice.body}
          </Text>
          {notice.kind === 'message' ? (
            <Text style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 2 }}>
              Удерживайте, чтобы ответить
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={dismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Скрыть уведомление"
          style={styles.close}
        >
          <Ionicons name="close" size={15} color={theme.textDisabled} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

export function InAppNotifications() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const notices = useStore((s) => s.inApp);
  const dismiss = useStore((s) => s.dismissInApp);
  const pushToast = useStore((s) => s.pushToast);
  const session = useStore((s) => s.session);
  const sounds = useSounds();
  const haptics = useHaptics();

  const [replyTo, setReplyTo] = useState<InAppNotice | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const openNotice = useCallback(
    (notice: InAppNotice) => {
      dismiss(notice.id);
      if (!notice.chatId) return;
      const suffix = notice.messageId ? `?msg=${encodeURIComponent(notice.messageId)}` : '';
      router.push(`/chat/${notice.chatId}${suffix}` as never);
    },
    [dismiss, router],
  );

  const openReply = useCallback((notice: InAppNotice) => {
    if (!notice.chatId) return;
    setReplyText('');
    setReplyTo(notice);
  }, []);

  useEffect(() => {
    if (!replyTo) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, [replyTo]);

  const closeReply = useCallback(() => {
    if (sending) return;
    setReplyTo(null);
    setReplyText('');
  }, [sending]);

  const submitReply = useCallback(async () => {
    if (!replyTo?.chatId || !replyText.trim() || sending) return;
    if (!session?.username) return;
    setSending(true);
    try {
      await sendMessage(
        replyTo.chatId,
        { text: replyText.trim() },
        'text',
        session.username,
        replyTo.messageId ? { replyTo: replyTo.messageId } : {},
      );
      sounds.send();
      haptics.send();
      dismiss(replyTo.id);
      pushToast({ kind: 'success', message: 'Ответ отправлен' });
      setReplyTo(null);
      setReplyText('');
    } catch {
      sounds.error();
      haptics.error();
      pushToast({ kind: 'error', message: 'Не удалось отправить ответ' });
    } finally {
      setSending(false);
    }
  }, [dismiss, haptics, pushToast, replyText, replyTo, sending, session?.username, sounds]);

  if (!notices.length && !replyTo) return null;

  return (
    <>
      <View pointerEvents="box-none" style={[styles.host, { top: Math.max(10, insets.top + 6) }]}>
        {notices.map((notice) => (
          <NoticeCard
            key={notice.id}
            notice={notice}
            onPress={() => openNotice(notice)}
            onReply={() => openReply(notice)}
            onDismiss={() => dismiss(notice.id)}
          />
        ))}
      </View>

      <Modal visible={Boolean(replyTo)} transparent animationType="fade" onRequestClose={closeReply} statusBarTranslucent>
        <Pressable style={styles.backdrop} onPress={closeReply} accessibilityRole="button" accessibilityLabel="Закрыть ответ">
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.replyWrap}
          >
            <Pressable
              onPress={(event) => event.stopPropagation?.()}
              style={[styles.replyCard, { backgroundColor: theme.surface, borderColor: theme.glassBorder }]}
            >
              <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700', marginBottom: 4 }}>
                Ответить {replyTo?.title ? `· ${replyTo.title}` : ''}
              </Text>
              <Text numberOfLines={2} style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 10 }}>
                {replyTo?.body}
              </Text>
              <TextInput
                ref={inputRef}
                value={replyText}
                onChangeText={setReplyText}
                placeholder="Быстрый ответ…"
                placeholderTextColor={theme.textDisabled}
                multiline
                autoFocus
                style={[
                  styles.input,
                  { color: theme.textPrimary, backgroundColor: theme.surfacePressed, borderColor: theme.glassBorder },
                ]}
                onSubmitEditing={() => void submitReply()}
                blurOnSubmit={false}
              />
              <View style={styles.replyActions}>
                <Pressable onPress={closeReply} hitSlop={8} style={styles.cancelBtn}>
                  <Text style={{ color: theme.textSecondary, fontWeight: '600', fontSize: 13 }}>Отмена</Text>
                </Pressable>
                <Pressable
                  onPress={() => void submitReply()}
                  disabled={!replyText.trim() || sending}
                  style={[
                    styles.sendBtn,
                    { backgroundColor: replyText.trim() && !sending ? theme.accent : theme.surfacePressed },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Отправить ответ"
                >
                  <Ionicons
                    name={sending ? 'hourglass-outline' : 'send'}
                    size={16}
                    color={replyText.trim() && !sending ? theme.background : theme.textDisabled}
                  />
                  <Text
                    style={{
                      color: replyText.trim() && !sending ? theme.background : theme.textDisabled,
                      fontWeight: '700',
                      fontSize: 13,
                    }}
                  >
                    Отправить
                  </Text>
                </Pressable>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 320,
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
  },
  card: {
    width: '100%',
    maxWidth: 430,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 8,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  close: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  replyWrap: {
    width: '100%',
    maxWidth: 460,
    alignSelf: 'center',
  },
  replyCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    padding: 14,
  },
  input: {
    minHeight: 44,
    maxHeight: 140,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  replyActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 14,
    marginTop: 10,
  },
  cancelBtn: { paddingVertical: 8, paddingHorizontal: 6 },
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 11,
  },
});
