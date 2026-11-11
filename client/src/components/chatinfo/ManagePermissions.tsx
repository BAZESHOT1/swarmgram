/**
 * Подраздел «Права»: матрица из 10 прав для ролей «Администратор» и
 * «Модератор». Владелец всегда имеет все права и не редактируется.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { Btn } from '../Btn';
import { useStore } from '../../state/useStore';
import { ManageChips, ManageSection, ManageToggle } from './ManageUI';
import { manageActions, manageError } from './ManageData';
import {
  PERMISSION_ITEMS,
  ROLE_LABEL,
  type ChatPermissions,
  type PermissionSet,
} from './ManageTypes';

type EditableRole = 'admin' | 'moderator';

export function ManagePermissions({
  chatId,
  permissions,
  loading,
  onSaved,
}: {
  chatId: string;
  permissions: ChatPermissions;
  loading?: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const [role, setRole] = React.useState<EditableRole>('admin');
  const [draft, setDraft] = React.useState<ChatPermissions>(permissions);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setDraft(permissions);
  }, [permissions]);

  const set = (key: keyof PermissionSet, value: boolean) => {
    setDraft((prev) => ({ ...prev, [role]: { ...prev[role], [key]: value } }));
  };

  const dirty = React.useMemo(() => {
    const same = (a: PermissionSet, b: PermissionSet) =>
      PERMISSION_ITEMS.every((item) => a[item.key] === b[item.key]);
    return !same(draft.admin, permissions.admin) || !same(draft.moderator, permissions.moderator);
  }, [draft, permissions]);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await manageActions.setChatPermissions(chatId, draft);
      pushToast({ kind: 'success', message: 'Права обновлены' });
      await onSaved();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <ManageSection
      icon="shield-checkmark-outline"
      title="Матрица прав"
      subtitle="Что могут делать администраторы и модераторы. Владелец всегда имеет все права."
    >
      <ManageChips
        items={[
          { key: 'admin', label: ROLE_LABEL.admin },
          { key: 'moderator', label: ROLE_LABEL.moderator },
        ]}
        value={role}
        onChange={(key) => setRole(key as EditableRole)}
      />

      <View style={{ marginTop: 8 }}>
        {PERMISSION_ITEMS.map((item) => (
          <ManageToggle
            key={item.key}
            label={item.label}
            hint={item.hint}
            icon={item.icon as keyof typeof Ionicons.glyphMap}
            value={draft[role][item.key]}
            onValueChange={(v) => set(item.key, v)}
            disabled={loading || saving}
          />
        ))}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8, paddingHorizontal: 2 }}>
        <Ionicons name="lock-closed-outline" size={13} color={theme.textDisabled} />
        <Text style={{ color: theme.textDisabled, fontSize: 11, flex: 1 }}>
          Владелец не ограничен матрицей. Изменения вступят в силу сразу.
        </Text>
      </View>

      <View style={{ marginTop: 12 }}>
        <Btn title="Сохранить права" loading={saving} disabled={!dirty || loading} onPress={() => void save()} />
      </View>
    </ManageSection>
  );
}
