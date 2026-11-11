/**
 * История сборок прошивки: статус, версия, дата, размер и действия.
 * Загрузка идёт через useEffect, удаление — с подтверждением.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { GlassCard } from '../settings/SettingsUI';
import {
  formatBytes,
  formatDateTime,
  SettingsConfirm,
  StatusBadge,
} from '../settings/SettingsWidgets';
import { CardsSkeleton } from '../skeletons/PageSkeletons';
import { EmptyState } from '../EmptyState';
import { Note } from './FirmwareUI';
import {
  deleteFirmwareBuild,
  firmwareBuilds,
  isReadyStatus,
  statusLabel,
  statusTone,
  type FirmwareBuild,
} from './types';

export function HistorySection({
  refreshToken = 0,
  onReflash,
  onDownload,
}: {
  refreshToken?: number;
  onReflash: (build: FirmwareBuild) => void;
  onDownload: (build: FirmwareBuild) => void;
}) {
  const theme = useTheme();
  const [items, setItems] = React.useState<FirmwareBuild[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<FirmwareBuild | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    firmwareBuilds()
      .then((list) => {
        if (cancelled) return;
        setItems(list.slice().sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken, reload]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteFirmwareBuild(deleteTarget.id);
      setItems((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 4 }}>
        <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '700', letterSpacing: 0.6 }}>
          ИСТОРИЯ СБОРОК
        </Text>
        <Text
          onPress={() => setReload((value) => value + 1)}
          accessibilityRole="button"
          accessibilityLabel="Обновить историю сборок"
          style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }}
        >
          Обновить
        </Text>
      </View>

      {loading ? (
        <CardsSkeleton count={3} />
      ) : error ? (
        <View>
          <Note icon="cloud-offline-outline" tone="danger">
            Не удалось загрузить историю: {error}
          </Note>
          <Btn title="Повторить" size="s" variant="ghost" onPress={() => setReload((value) => value + 1)} />
        </View>
      ) : items.length === 0 ? (
        <EmptyState
          icon="file-tray-outline"
          title="Сборок пока нет"
          subtitle="Соберите прошивку на шаге «Проверка» — она появится здесь вместе с версией и SHA-256."
        />
      ) : (
        items.map((build) => {
          const ready = isReadyStatus(build.status);
          const failed = build.status === 'failed';
          return (
            <GlassCard key={build.id} style={{ marginBottom: 8 }}>
              <View style={{ padding: 11, gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                  <View
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: ready ? theme.successSoft : failed ? theme.dangerSoft : theme.accentSoft,
                    }}
                  >
                    <Ionicons
                      name={ready ? 'checkmark-circle-outline' : failed ? 'alert-circle-outline' : 'build-outline'}
                      size={17}
                      color={ready ? theme.success : failed ? theme.danger : theme.accent}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
                      {build.version ? `Версия ${build.version}` : `Сборка ${build.id.slice(0, 8)}…`}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 2 }} numberOfLines={1}>
                      {formatDateTime(build.createdAt)} · {formatBytes(build.sizeBytes)}
                    </Text>
                  </View>
                  <StatusBadge text={statusLabel(build.status)} tone={statusTone(build.status)} />
                </View>

                {build.sha256 ? (
                  <Text style={{ color: theme.textDisabled, fontSize: 10.5 }} numberOfLines={1}>
                    SHA-256: {build.sha256}
                  </Text>
                ) : null}

                {failed && build.log ? (
                  <Text style={{ color: theme.danger, fontSize: 11, lineHeight: 16 }} numberOfLines={2}>
                    {build.log.split('\n').filter(Boolean).slice(-2).join(' · ')}
                  </Text>
                ) : null}

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Btn title="Скачать" size="s" variant="ghost" disabled={!ready} onPress={() => onDownload(build)} />
                  <Btn title="Прошить снова" size="s" variant="ghost" disabled={!ready} onPress={() => onReflash(build)} />
                  <Btn title="Удалить" size="s" variant="danger" onPress={() => setDeleteTarget(build)} />
                </View>
              </View>
            </GlassCard>
          );
        })
      )}

      <SettingsConfirm
        visible={deleteTarget !== null}
        title="Удалить сборку?"
        message="Файл .bin и запись в истории исчезнут с Hub. Уже прошитые модули продолжат работать."
        confirmLabel="Удалить"
        loading={deleting}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </View>
  );
}
