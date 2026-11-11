import React from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { ModalButtons, ProfileModal } from './ProfileModal';

/** Причины жалобы: значения уходят на Hub как есть. */
export const REPORT_REASONS: { value: string; label: string }[] = [
  { value: 'spam', label: 'Спам или реклама' },
  { value: 'abuse', label: 'Оскорбления и травля' },
  { value: 'scam', label: 'Мошенничество' },
  { value: 'impersonation', label: 'Выдаёт себя за другого' },
  { value: 'other', label: 'Другое' },
];

export function ReportModal({
  visible,
  loading,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  loading?: boolean;
  onClose: () => void;
  onSubmit: (reason: string, note: string) => void;
}) {
  const theme = useTheme();
  const [reason, setReason] = React.useState('spam');
  const [note, setNote] = React.useState('');

  React.useEffect(() => {
    if (visible) {
      setReason('spam');
      setNote('');
    }
  }, [visible]);

  return (
    <ProfileModal visible={visible} title="Пожаловаться" subtitle="Жалоба уйдёт модераторам Hub" onClose={onClose}>
      <View style={{ gap: 6 }}>
        {REPORT_REASONS.map((r) => {
          const active = reason === r.value;
          return (
            <Pressable
              key={r.value}
              onPress={() => setReason(r.value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              accessibilityLabel={r.label}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingHorizontal: 11,
                  paddingVertical: 9,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: active ? theme.accent : theme.line,
                  backgroundColor: active ? theme.accentSoft : pressed ? theme.surfacePressed : 'transparent',
                },
              ]}
            >
              <Ionicons name={active ? 'radio-button-on' : 'radio-button-off'} size={16} color={active ? theme.accent : theme.textDisabled} />
              <Text style={{ color: active ? theme.accent : theme.textPrimary, fontSize: 13.5, fontWeight: active ? '600' : '400' }}>{r.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 12, marginBottom: 6 }}>Комментарий (необязательно)</Text>
      <TextInput
        value={note}
        onChangeText={setNote}
        maxLength={500}
        multiline
        accessibilityLabel="Комментарий к жалобе"
        placeholder="Что случилось?"
        placeholderTextColor={theme.textDisabled}
        style={
          {
            backgroundColor: theme.dark ? 'rgba(10,14,20,0.55)' : 'rgba(255,255,255,0.85)',
            borderColor: theme.line,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 10,
            color: theme.textPrimary,
            fontSize: 14,
            minHeight: 76,
            textAlignVertical: 'top',
            ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
          } as any
        }
      />
      <ModalButtons
        onCancel={onClose}
        onConfirm={() => onSubmit(reason, note.trim())}
        confirmLabel="Отправить жалобу"
        loading={loading}
        danger
      />
    </ProfileModal>
  );
}
