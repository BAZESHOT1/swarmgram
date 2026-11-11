/**
 * Шаг LoRa: чип, частота, параметры модуляции, sync word и пины.
 * Пины проверяются на конфликты и занятые USB/strapping-выводы.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../../theme/useTheme';
import { EmptyState } from '../EmptyState';
import { SettingsInput } from '../settings/SettingsWidgets';
import { Note, PillGroup, StepCard } from './FirmwareUI';
import {
  checkLoraPins,
  formatSyncWord,
  parseSyncWord,
  recommendedPins,
  type FirmwareConfig,
  type LoraChip,
  type LoraConfig,
  type LoraPinKey,
  type LoraPins,
} from './types';

/** Числовое поле пина: разрешает временно пустое значение при вводе. */
function PinField({
  label,
  value,
  onChange,
  optional,
  placeholder,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  optional?: boolean;
  placeholder?: string;
}) {
  const theme = useTheme();
  const [text, setText] = React.useState(value === undefined ? '' : String(value));
  const focused = React.useRef(false);

  React.useEffect(() => {
    if (!focused.current) setText(value === undefined ? '' : String(value));
  }, [value]);

  return (
    <View style={{ flexBasis: '47%', flexGrow: 1, marginBottom: 10 }}>
      <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '600', marginBottom: 5 }}>
        {label}
        {optional ? ' (необяз.)' : ''}
      </Text>
      <TextInputBridge
        label={label}
        value={text}
        placeholder={placeholder ?? '0–48'}
        onChangeText={(next) => {
          setText(next);
          const trimmed = next.trim();
          if (!trimmed) {
            if (optional) onChange(undefined);
            return;
          }
          const parsed = Number(trimmed);
          if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 48) onChange(parsed);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          const trimmed = text.trim();
          if (!trimmed) {
            if (optional) onChange(undefined);
            else setText(value === undefined ? '' : String(value));
            return;
          }
          const parsed = Number(trimmed);
          if (!Number.isInteger(parsed) || parsed < 0 || parsed > 48) {
            setText(value === undefined ? '' : String(value));
          }
        }}
      />
    </View>
  );
}

/** Обёртка над SettingsInput, чтобы не дублировать стили полей в сетке. */
function TextInputBridge(props: React.ComponentProps<typeof SettingsInput>) {
  const { label: _label, ...rest } = props;
  return (
    <View style={{ marginBottom: 0 }}>
      <SettingsInput {...rest} />
    </View>
  );
}

type LoraPinUpdate = Partial<LoraPins>;

export function LoRaStep({
  config,
  onChange,
}: {
  config: FirmwareConfig;
  onChange: (patch: Partial<FirmwareConfig>) => void;
}) {
  const theme = useTheme();
  const lora = config.lora;

  if (!lora) {
    return (
      <EmptyState
        icon="cellular-outline"
        title="LoRa не выбрана"
        subtitle="Вернитесь на шаг «Связь» и выберите Wi-Fi mesh + LoRa mesh."
      />
    );
  }

  const updateLora = (patch: Partial<LoraConfig>) => onChange({ lora: { ...lora, ...patch } });
  const updatePins = (patch: LoraPinUpdate) => updateLora({ pins: { ...lora.pins, ...patch } });
  const issues = checkLoraPins(lora, config.board, config.battery?.enabled ? config.battery.pin : undefined);
  const errors = issues.filter((issue) => issue.kind === 'error');
  const warnings = issues.filter((issue) => issue.kind === 'warning');

  return (
    <View>
      <PillGroup
        label="Чип приёмопередатчика"
        value={lora.chip}
        options={[
          { value: 'sx1278' as LoraChip, label: 'SX1278' },
          { value: 'sx1276' as LoraChip, label: 'SX1276' },
          { value: 'sx1262' as LoraChip, label: 'SX1262' },
        ]}
        onChange={(chip) => {
          const nextBusy =
            chip === 'sx1262' && lora.pins.busy === undefined
              ? recommendedPins(config.board).busy
              : lora.pins.busy;
          updateLora({ chip, pins: { ...lora.pins, busy: nextBusy } });
        }}
      />

      <PillGroup
        label="Частота"
        value={lora.frequencyMhz}
        options={[
          { value: 433 as const, label: '433 МГц' },
          { value: 868 as const, label: '868 МГц' },
          { value: 915 as const, label: '915 МГц' },
        ]}
        onChange={(frequencyMhz) => updateLora({ frequencyMhz })}
      />
      <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: -6, marginBottom: 12, paddingHorizontal: 2 }}>
        433 — универсальный диапазон, 868 — Европа, 915 — Америка. Антенна должна соответствовать частоте, иначе дальность и модуль пострадают.
      </Text>

      <PillGroup
        label="Spreading Factor (SF)"
        value={lora.spreadingFactor}
        options={[7, 8, 9, 10, 11, 12].map((value) => ({ value, label: `SF${value}` }))}
        onChange={(spreadingFactor) => updateLora({ spreadingFactor })}
      />

      <PillGroup
        label="Полоса (bandwidth)"
        value={lora.bandwidthKhz}
        options={[
          { value: 125 as const, label: '125 кГц' },
          { value: 250 as const, label: '250 кГц' },
          { value: 500 as const, label: '500 кГц' },
        ]}
        onChange={(bandwidthKhz) => updateLora({ bandwidthKhz })}
      />

      <SettingsInput
        label="Sync word (hex)"
        value={formatSyncWord(lora.syncWord)}
        onChangeText={(text) => {
          const parsed = parseSyncWord(text);
          if (parsed !== null) updateLora({ syncWord: parsed });
        }}
        placeholder="0x12"
        autoCapitalize="characters"
        maxLength={4}
        accessibilityLabel="Sync word в шестнадцатеричном виде"
      />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginBottom: 8 }}>
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 }}>
          ПИНЫ ПОДКЛЮЧЕНИЯ
        </Text>
        <Text
          onPress={() => updatePins(recommendedPins(config.board))}
          accessibilityRole="button"
          accessibilityLabel="Сбросить пины на рекомендуемые"
          style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }}
        >
          Сбросить на рекомендуемые
        </Text>
      </View>

      <StepCard>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {(
            [
              ['sck', 'SCK'],
              ['miso', 'MISO'],
              ['mosi', 'MOSI'],
              ['cs', 'CS'],
              ['rst', 'RST'],
              ['dio0', 'DIO0'],
            ] as Array<[LoraPinKey, string]>
          ).map(([key, label]) => (
            <PinField
              key={key}
              label={label}
              value={lora.pins[key] as number | undefined}
              onChange={(value) => updatePins({ [key]: value } as LoraPinUpdate)}
            />
          ))}
          <PinField
            label="BUSY"
            optional={lora.chip !== 'sx1262'}
            value={lora.pins.busy}
            onChange={(value) => updatePins({ busy: value })}
            placeholder={lora.chip === 'sx1262' ? 'обязателен' : 'только SX1262'}
          />
        </View>
      </StepCard>

      <View style={{ height: 12 }} />
      {errors.map((issue) => (
        <Note key={`e-${issue.message}`} icon="alert-circle-outline" tone="danger">
          {issue.message}
        </Note>
      ))}
      {warnings.map((issue) => (
        <Note key={`w-${issue.message}`} icon="warning-outline" tone="warning">
          {issue.message}
        </Note>
      ))}
      {issues.length === 0 ? (
        <Note icon="checkmark-circle-outline" tone="success">
          Конфликтов пинов не найдено. Проверьте пайку и питание модуля 3.3 В.
        </Note>
      ) : null}
      {lora.chip === 'sx1262' ? (
        <Note icon="information-circle-outline" tone="accent">
          Для SX1262 линия BUSY обязательна — без неё драйвер не дождётся готовности чипа.
        </Note>
      ) : null}
    </View>
  );
}
