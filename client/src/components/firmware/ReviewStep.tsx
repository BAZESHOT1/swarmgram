/**
 * Шаг проверки: сводка конфигурации, запуск сборки на Hub и прогресс.
 */
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { GlassCard } from '../settings/SettingsUI';
import { formatBytes, ProgressBar, StatusBadge } from '../settings/SettingsWidgets';
import { ErrorText, MonoLog, Note, StepCard, SummaryRow } from './FirmwareUI';
import type { FirmwareBuilderStatus } from '../../data/api';
import {
  boardPreset,
  firmwareBuilderStatus,
  getModuleNetwork,
  isReadyStatus,
  isTerminalStatus,
  statusLabel,
  statusTone,
  type FirmwareBuild,
  type FirmwareConfig,
  type ModuleNetwork,
} from './types';

const ROLE_LABEL: Record<FirmwareConfig['role'], string> = {
  gateway: 'Шлюз',
  repeater: 'Ретранслятор',
  wearable: 'Носимый модуль',
};

export function ReviewStep({
  config,
  build,
  building,
  buildError,
  buildStartedAt,
  onEditStep,
  onBuild,
  onGoFlash,
  onDownload,
}: {
  config: FirmwareConfig;
  build: FirmwareBuild | null;
  building: boolean;
  buildError: string;
  buildStartedAt: number | null;
  onEditStep: (step: number) => void;
  onBuild: () => void;
  onGoFlash: () => void;
  onDownload: () => void;
}) {
  const theme = useTheme();
  const preset = boardPreset(config.board);
  const ready = isReadyStatus(build?.status);
  const terminal = isTerminalStatus(build?.status);

  // Заранее узнаём, готов ли сборщик: честная плашка лучше ошибки после клика.
  const [builder, setBuilder] = useState<FirmwareBuilderStatus | null>(null);
  // Сеть модулей нужна только для строки сводки — ошибку молча скрываем.
  const [network, setNetwork] = useState<ModuleNetwork | null>(null);
  useEffect(() => {
    let alive = true;
    firmwareBuilderStatus()
      .then((status) => {
        if (alive) setBuilder(status);
      })
      .catch(() => {
        if (alive) setBuilder(null);
      });
    getModuleNetwork()
      .then((value) => {
        if (alive) setNetwork(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const elapsed = buildStartedAt ? Math.max(0, Math.floor((Date.now() - buildStartedAt) / 1000)) : 0;

  return (
    <View>
      <GlassCard>
        <SummaryRow label="Плата" value={preset.title} onPress={() => onEditStep(1)} />
        <SummaryRow label="Роль" value={ROLE_LABEL[config.role]} onPress={() => onEditStep(2)} />
        <SummaryRow
          label="Связь"
          value={config.connectivity === 'wifi_lora' ? 'Wi-Fi mesh + LoRa mesh' : 'Только Wi-Fi mesh'}
          onPress={() => onEditStep(3)}
        />
        {config.connectivity === 'wifi_lora' && config.lora ? (
          <SummaryRow
            label="LoRa"
            value={`${config.lora.chip.toUpperCase()} · ${config.lora.frequencyMhz} МГц · SF${config.lora.spreadingFactor} · BW${config.lora.bandwidthKhz}`}
            onPress={() => onEditStep(4)}
          />
        ) : null}
        <SummaryRow
          label="Батарея"
          value={
            config.battery?.enabled
              ? `GPIO ${config.battery.pin} · делитель ×${config.battery.ratio} · каждые ${Math.round(config.battery.intervalSec / 60)} мин`
              : 'не подключена'
          }
          onPress={() => onEditStep(5)}
        />
        <SummaryRow
          label="Hub"
          value={`${config.wifi?.ssid || 'SSID не указан'} · ${config.hubUrl || 'URL не указан'}`}
          onPress={() => onEditStep(6)}
        />
        <SummaryRow
          label="Mesh-сеть"
          value={
            network
              ? `скрытая · SSID ${network.ssid} · rev ${network.revision}`
              : 'скрытая · загружается…'
          }
          onPress={() => onEditStep(6)}
        />
        <SummaryRow
          label="Привязка"
          value={config.moduleToken ? 'токен модуля указан' : 'токен не указан — модуль не сможет отчитываться'}
          onPress={() => onEditStep(6)}
        />
      </GlassCard>

      {builder && !builder.available ? (
        <Note icon="warning-outline" tone="danger">
          {builder.reason === 'core_missing'
            ? 'Сборщик запущен, но ядро ESP32 не установлено — обычно не хватило места на диске. Сборка вернёт ошибку: освободите ~4 ГБ и перезапустите сборщик либо используйте сборщик на другой машине.'
            : 'Сборщик прошивок выключен на сервере. Здесь доступны история и готовые .bin; новую прошивку можно собрать на машине с запущенным firmware-builder.'}
        </Note>
      ) : null}

      {builder?.available && Array.isArray(builder.boards) && builder.boards.length > 0 && !builder.boards.includes(config.board) ? (
        <Note icon="hardware-chip-outline" tone="warning">
          В сборщике установлена не эта плата. Доступна сборка: {builder.boards.join(', ')}. Сборка вернёт ошибку —
          выберите доступную плату или добавьте её в ESP32_BOARDS на сервере сборки.
        </Note>
      ) : null}

      {builder?.available && typeof builder.freeMb === 'number' && builder.freeMb < 600 ? (
        <Note icon="server-outline" tone="warning">
          На сервере сборки осталось {builder.freeMb} МБ свободного места — сборка может не пройти.
        </Note>
      ) : null}

      <View style={{ height: 14 }} />

      {buildError ? <ErrorText>{buildError}</ErrorText> : null}

      {!build ? (
        <Btn title={building ? 'Собираем…' : 'Собрать прошивку'} loading={building} onPress={onBuild} />
      ) : (
        <StepCard>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons
              name={ready ? 'checkmark-circle' : build.status === 'failed' ? 'alert-circle' : 'build-outline'}
              size={18}
              color={ready ? theme.success : build.status === 'failed' ? theme.danger : theme.accent}
            />
            <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700', flex: 1 }}>
              Сборка {build.id.slice(0, 8)}…
            </Text>
            <StatusBadge text={statusLabel(build.status)} tone={statusTone(build.status)} />
          </View>

          {!terminal ? (
            <View style={{ marginTop: 10 }}>
              <ProgressBar pct={Math.min(90, 20 + elapsed * 2)} tone="accent" />
              <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 6 }}>
                Hub собирает прошивку… {elapsed > 0 ? `${elapsed} с` : ''} Проверяем статус каждые 2 секунды.
              </Text>
            </View>
          ) : null}

          {ready ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {build.version ? <StatusBadge text={`v${build.version}`} tone="success" /> : null}
              <StatusBadge text={formatBytes(build.sizeBytes)} tone="neutral" />
              {build.sha256 ? <StatusBadge text={`sha ${build.sha256.slice(0, 10)}…`} tone="neutral" /> : null}
            </View>
          ) : null}

          {build.sha256 ? (
            <Text selectable style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 8 }}>
              SHA-256: {build.sha256}
            </Text>
          ) : null}

          {build.log ? (
            <View style={{ marginTop: 10 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 6 }}>Лог сборки</Text>
              <MonoLog text={build.log} height={160} />
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <View style={{ flex: 1 }}>
              <Btn title="Скачать .bin" size="s" variant="ghost" disabled={!ready} onPress={onDownload} />
            </View>
            <View style={{ flex: 1 }}>
              <Btn
                title="Прошить"
                size="s"
                disabled={!ready}
                onPress={onGoFlash}
              />
            </View>
          </View>

          {build.status === 'failed' ? (
            <View style={{ marginTop: 10 }}>
              <Btn
                title="Повторить сборку"
                size="s"
                variant="ghost"
                loading={building}
                onPress={onBuild}
              />
            </View>
          ) : null}
        </StepCard>
      )}

      <View style={{ height: 12 }} />
      <Note icon="shield-checkmark-outline" tone="neutral">
        Сборка выполняется на Hub. В прошивку попадут SSID, токен модуля и параметры LoRa — не передавайте .bin третьим лицам.
      </Note>
    </View>
  );
}
