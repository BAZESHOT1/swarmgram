/**
 * Подраздел «Информация»: название, описание и тип видимости.
 * Сохраняется через patchChat. При смене на «Частная» показываем предупреждение.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { Btn } from '../Btn';
import { SettingsInput } from '../settings/SettingsWidgets';
import { useStore } from '../../state/useStore';
import { ManageChoice, ManageSection } from './ManageUI';
import { ManageAvatar } from './ManageAvatar';
import { manageActions, manageError } from './ManageData';
import {
  VISIBILITY_META,
  VISIBILITY_ORDER,
  visibilityLabel,
  visibilityOf,
  type ChatVisibility,
  type ManageChat,
} from './ManageTypes';

export function ManageInfo({
  chat,
  canEdit,
  onChanged,
}: {
  chat: ManageChat;
  canEdit: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const isChannel = chat.type === 'channel';
  const savedVisibility = visibilityOf(chat);
  const [title, setTitle] = React.useState(chat.title ?? '');
  const [description, setDescription] = React.useState(chat.description ?? '');
  const [visibility, setVisibility] = React.useState<ChatVisibility>(savedVisibility);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setTitle(chat.title ?? '');
    setDescription(chat.description ?? '');
    setVisibility(savedVisibility);
  }, [chat.id, chat.title, chat.description, savedVisibility]);

  const dirty =
    title.trim() !== (chat.title ?? '').trim() ||
    description.trim() !== (chat.description ?? '').trim() ||
    visibility !== savedVisibility;

  const privateWarning = visibility === 'private' && savedVisibility !== 'private';

  async function save() {
    if (saving) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      pushToast({ kind: 'error', message: 'Название не может быть пустым' });
      return;
    }
    setSaving(true);
    try {
      await manageActions.patchChat(chat.id, {
        title: nextTitle,
        description: description.trim(),
        visibility,
      });
      pushToast({ kind: 'success', message: 'Информация сохранена' });
      await onChanged();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Аватар доступен владельцу и ролям с правом set_avatar. */}
      <ManageAvatar chat={chat} canEdit={canEdit} onChanged={onChanged} />

      <ManageSection
        icon="create-outline"
        title={isChannel ? 'Информация о канале' : 'Информация о группе'}
        subtitle={canEdit ? 'Название, описание и тип видны участникам' : 'Изменение доступно администраторам'}
      >
      <SettingsInput
        label="Название"
        value={title}
        onChangeText={setTitle}
        editable={canEdit}
        maxLength={64}
        placeholder={isChannel ? 'Название канала' : 'Название группы'}
        accessibilityLabel="Название чата"
      />
      <SettingsInput
        label="Описание"
        value={description}
        onChangeText={setDescription}
        editable={canEdit}
        multiline
        maxLength={500}
        placeholder="О чём этот чат"
        accessibilityLabel="Описание чата"
        style={{ minHeight: 74, textAlignVertical: 'top' }}
      />
      <Text style={{ color: theme.textDisabled, fontSize: 10.5, textAlign: 'right', marginTop: -6, marginBottom: 10 }}>
        {description.length}/500
      </Text>

      <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 6, paddingHorizontal: 2 }}>
        Тип {isChannel ? 'канала' : 'группы'}
      </Text>
      <ManageChoice
        options={VISIBILITY_ORDER.map((v) => ({
          value: v,
          label: visibilityLabel(v, isChannel ? 'channel' : 'group'),
          hint: VISIBILITY_META[v].description,
          icon: VISIBILITY_META[v].icon,
        }))}
        value={visibility}
        onChange={setVisibility}
        disabled={!canEdit}
      />

      {privateWarning ? (
        <View
          style={{
            flexDirection: 'row',
            gap: 7,
            marginTop: 9,
            padding: 9,
            borderRadius: 10,
            backgroundColor: theme.warningSoft,
          }}
        >
          <Ionicons name="warning-outline" size={15} color={theme.warning} />
          <Text style={{ color: theme.warning, fontSize: 11.5, flex: 1, lineHeight: 16 }}>
            Частный чат исчезнет из поиска. Новые участники смогут попасть только по приглашению или ссылке.
          </Text>
        </View>
      ) : null}

      {canEdit ? (
        <View style={{ marginTop: 12 }}>
          <Btn title="Сохранить изменения" loading={saving} disabled={!dirty} onPress={() => void save()} />
        </View>
      ) : (
        <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: 10 }}>
          У вас нет права менять информацию о чате.
        </Text>
      )}
      </ManageSection>
    </>
  );
}
