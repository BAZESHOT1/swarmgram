import React from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../theme/useTheme';
import { ModalButtons, ProfileModal } from './ProfileModal';

/** Inline-редактирование своего профиля: имя, username и bio. */
export function ProfileEditModal({
  visible,
  initialDisplayName,
  initialBio,
  initialUsername,
  usernamePolicy,
  loading,
  onClose,
  onSave,
}: {
  visible: boolean;
  initialDisplayName: string;
  initialBio: string;
  initialUsername: string;
  usernamePolicy?: { canChange: boolean; canChangeAt: string; cooldownDays: number };
  loading?: boolean;
  onClose: () => void;
  onSave: (input: { displayName: string; bio: string; username: string }) => void;
}) {
  const theme = useTheme();
  const [displayName, setDisplayName] = React.useState(initialDisplayName);
  const [bio, setBio] = React.useState(initialBio);
  const [username, setUsername] = React.useState(initialUsername);

  React.useEffect(() => {
    if (visible) {
      setDisplayName(initialDisplayName);
      setBio(initialBio);
      setUsername(initialUsername);
    }
  }, [visible, initialDisplayName, initialBio, initialUsername]);

  const inputStyle = {
    backgroundColor: theme.dark ? 'rgba(10,14,20,0.55)' : 'rgba(255,255,255,0.85)',
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.textPrimary,
    fontSize: 15,
  } as const;

  const userCanChange = usernamePolicy?.canChange !== false;
  const usernameChanged = username.trim().toLowerCase() !== initialUsername.toLowerCase();
  const usernameValid = /^[a-z0-9_]{3,32}$/.test(username.trim().toLowerCase());
  const disabled = !displayName.trim() || (usernameChanged && (!usernameValid || !userCanChange));

  const cooldownDays = usernamePolicy?.cooldownDays ?? 90;
  const canChangeAtLabel = usernamePolicy?.canChangeAt
    ? new Date(usernamePolicy.canChangeAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  return (
    <ProfileModal visible={visible} title="Редактировать профиль" subtitle="Имя, username и описание видны другим пользователям" onClose={onClose}>
      <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 6 }}>Отображаемое имя</Text>
      <TextInput
        value={displayName}
        onChangeText={setDisplayName}
        maxLength={64}
        accessibilityLabel="Отображаемое имя"
        placeholder="Как вас называть"
        placeholderTextColor={theme.textDisabled}
        style={inputStyle}
      />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, marginBottom: 6 }}>
        <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Username</Text>
        {usernameChanged && !usernameValid ? (
          <Text style={{ color: theme.danger, fontSize: 11 }}>3–32: a-z, 0-9, «_»</Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        <Text style={{ color: theme.textDisabled, fontSize: 15, paddingRight: 1 }}>@</Text>
        <TextInput
          value={username}
          onChangeText={(v) => setUsername(v.toLowerCase().replace(/\s/g, ''))}
          maxLength={32}
          autoCapitalize="none"
          autoCorrect={false}
          editable={userCanChange}
          accessibilityLabel="Username"
          placeholder="username"
          placeholderTextColor={theme.textDisabled}
          style={[inputStyle, { flex: 1 }, !userCanChange && { opacity: 0.55 }]}
        />
      </View>
      {!userCanChange ? (
        <Text style={{ color: theme.warning, fontSize: 11, marginTop: 4 }}>
          Смена доступна с {canChangeAtLabel || 'позже'}
        </Text>
      ) : (
        <Text style={{ color: theme.textDisabled, fontSize: 11, marginTop: 4 }}>
          Смена username — не чаще одного раза в {cooldownDays} дней.
        </Text>
      )}

      <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 12, marginBottom: 6 }}>О себе</Text>
      <TextInput
        value={bio}
        onChangeText={setBio}
        maxLength={280}
        multiline
        accessibilityLabel="Описание профиля"
        placeholder="Пара слов о себе"
        placeholderTextColor={theme.textDisabled}
        style={[inputStyle, { minHeight: 92, textAlignVertical: 'top' as never, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) } as any]}
      />
      <Text style={{ color: theme.textDisabled, fontSize: 11, marginTop: 4, textAlign: 'right' }}>{bio.length}/280</Text>
      <ModalButtons
        onCancel={onClose}
        onConfirm={() => onSave({ displayName: displayName.trim(), bio: bio.trim(), username: username.trim().toLowerCase() })}
        confirmLabel="Сохранить"
        loading={loading}
        disabled={disabled}
      />
    </ProfileModal>
  );
}
