/**
 * Подраздел «Опасное»: передача владения и удаление чата.
 * Доступен только владельцу.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { Btn } from '../Btn';
import { SettingsConfirm } from '../settings/SettingsWidgets';
import { useStore } from '../../state/useStore';
import { ManageChoice, ManageEmpty, ManageSection } from './ManageUI';
import { manageActions, manageError } from './ManageData';
import { ROLE_LABEL, type ManageChat } from './ManageTypes';

export function ManageDanger({
  chat,
  onChanged,
  onDelete,
}: {
  chat: ManageChat;
  onChanged: () => Promise<void> | void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const candidates = React.useMemo(
    () => (chat.members ?? []).filter((m) => m.role !== 'owner' && m.username !== chat.ownerUsername),
    [chat.members, chat.ownerUsername],
  );
  const [nextOwner, setNextOwner] = React.useState('');
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    if (nextOwner && !candidates.some((m) => m.userId === nextOwner)) setNextOwner('');
  }, [candidates, nextOwner]);

  async function transfer() {
    const member = candidates.find((m) => m.userId === nextOwner);
    if (!member || deleting) return;
    setDeleting(true);
    try {
      await manageActions.transferOwnership(chat.id, member.userId);
      pushToast({ kind: 'success', message: `Владение передано @${member.username}` });
      setConfirmOpen(false);
      setNextOwner('');
      await onChanged();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <ManageSection
        icon="ribbon-outline"
        title="Передать владение"
        subtitle="Новый владелец получит полные права. Вы останетесь администратором."
      >
        {candidates.length === 0 ? (
          <ManageEmpty icon="people-outline" text="В чате нет других участников, кому можно передать владение." />
        ) : (
          <>
            <ManageChoice
              options={candidates.map((m) => ({
                value: m.userId,
                label: m.displayName || m.username,
                hint: `@${m.username} · ${ROLE_LABEL[(m.role as keyof typeof ROLE_LABEL) ?? 'member'] ?? m.role}`,
              }))}
              value={nextOwner}
              onChange={setNextOwner}
              compact
            />
            <View style={{ marginTop: 10 }}>
              <Btn
                title="Передать владение"
                variant="danger"
                disabled={!nextOwner}
                onPress={() => setConfirmOpen(true)}
              />
            </View>
          </>
        )}
      </ManageSection>

      <ManageSection
        icon="warning-outline"
        title="Удалить чат"
        subtitle="Чат и его история будут удалены для всех участников. Действие необратимо."
      >
        <View style={{ flexDirection: 'row', gap: 7, alignItems: 'flex-start', marginBottom: 10 }}>
          <Ionicons name="alert-circle-outline" size={15} color={theme.danger} />
          <Text style={{ color: theme.danger, fontSize: 11.5, flex: 1, lineHeight: 16 }}>
            Перед удалением убедитесь, что история не нужна участникам. Восстановить чат нельзя.
          </Text>
        </View>
        <Btn title="Удалить чат" variant="danger" onPress={onDelete} />
      </ManageSection>

      <SettingsConfirm
        visible={confirmOpen}
        title="Передать владение?"
        message={
          nextOwner
            ? `Вы передадите чат @${candidates.find((m) => m.userId === nextOwner)?.username ?? ''}. Это действие нельзя отменить.`
            : 'Выберите нового владельца.'
        }
        confirmLabel="Передать"
        loading={deleting}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void transfer()}
      />
    </>
  );
}
