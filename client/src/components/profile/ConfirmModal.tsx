import React from 'react';
import { Text } from 'react-native';
import { useTheme } from '../../theme/useTheme';
import { ModalButtons, ProfileModal } from './ProfileModal';

/** Подтверждение опасного действия в стеклянной модалке. */
export function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel,
  loading,
  danger = true,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  loading?: boolean;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const theme = useTheme();
  return (
    <ProfileModal visible={visible} title={title} onClose={onClose}>
      <Text style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 20 }}>{message}</Text>
      <ModalButtons onCancel={onClose} onConfirm={onConfirm} confirmLabel={confirmLabel} loading={loading} danger={danger} />
    </ProfileModal>
  );
}
