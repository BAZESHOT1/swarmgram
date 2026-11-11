/**
 * Шаг батареи: включение, ADC-пин, делитель напряжения и интервал отчёта.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../../theme/useTheme';
import { SettingsInput } from '../settings/SettingsWidgets';
import { SettingsToggle } from '../settings/SettingsUI';
import { Note, PillGroup, StepCard } from './FirmwareUI';
import { recommendedBatteryPin, type BatteryConfig, type FirmwareConfig } from './types';

export function BatteryStep({
  config,
  onChange,
}: {
  config: FirmwareConfig;
  onChange: (patch: Partial<FirmwareConfig>) => void;
}) {
  const theme = useTheme();
  const battery: BatteryConfig = config.battery ?? {
    enabled: false,
    pin: recommendedBatteryPin(config.board),
    ratio: 2,
    intervalSec: 900,
  };

  const updateBattery = (patch: Partial<BatteryConfig>) => {
    onChange({ battery: { ...battery, ...patch } });
  };

  // Пин батареи не должен совпадать с пинами LoRa — иначе АЦП будет читать чужой сигнал.
  const loraConflicts =
    config.connectivity === 'wifi_lora' && config.lora && battery.enabled
      ? (Object.entries(config.lora.pins) as Array<[string, number | undefined]>)
          .filter(([, pin]) => pin === battery.pin)
          .map(([name]) => name.toUpperCase())
      : [];

  return (
    <View>
      <Note icon="battery-half-outline" tone="accent">
        Плата измеряет напряжение на АЦП-пине. Если между батареей и пином стоит делитель 1:1, укажите коэффициент 2.0 — иначе
        прошивка покажет завышенный заряд.
      </Note>

      <StepCard>
        <SettingsToggle
          icon="battery-charging-outline"
          title="Отправлять заряд батареи"
          subtitle="появится в списке модулей и на карточке"
          value={battery.enabled}
          onValueChange={(enabled) =>
            updateBattery({
              enabled,
              pin: battery.pin ?? recommendedBatteryPin(config.board),
            })
          }
        />

        {battery.enabled ? (
          <View style={{ paddingHorizontal: 10, paddingBottom: 10, paddingTop: 6 }}>
            <SettingsInput
              label="Пин АЦП"
              value={String(battery.pin)}
              onChangeText={(text) => {
                const parsed = Number(text.trim());
                if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 48) updateBattery({ pin: parsed });
              }}
              keyboardType="numeric"
              placeholder="0–48"
              accessibilityLabel="Пин АЦП батареи"
              maxLength={2}
            />
            <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: -4, marginBottom: 10, paddingHorizontal: 2 }}>
              Рекомендуемый для этой платы: GPIO {recommendedBatteryPin(config.board)}
            </Text>

            <SettingsInput
              label="Коэффициент делителя"
              value={String(battery.ratio)}
              onChangeText={(text) => {
                const parsed = Number(text.replace(',', '.'));
                if (Number.isFinite(parsed) && parsed > 1 && parsed <= 10) updateBattery({ ratio: parsed });
              }}
              keyboardType="numeric"
              placeholder="2.0"
              accessibilityLabel="Коэффициент делителя напряжения"
              maxLength={4}
            />
            <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: -4, marginBottom: 10, paddingHorizontal: 2 }}>
              Делитель 1:1 (два одинаковых резистора) → 2.0. Делитель 1:2 → 3.0.
            </Text>

            <PillGroup
              label="Интервал отчёта"
              value={battery.intervalSec}
              options={[
                { value: 300, label: '5 минут' },
                { value: 900, label: '15 минут' },
                { value: 3600, label: '60 минут' },
              ]}
              onChange={(intervalSec) => updateBattery({ intervalSec })}
            />
          </View>
        ) : null}
      </StepCard>

      <View style={{ height: 12 }} />
      {loraConflicts.length > 0 ? (
        <Note icon="warning-outline" tone="danger">
          Пин батареи GPIO {battery.pin} уже занят линией LoRa ({loraConflicts.join(', ')}). Выберите другой АЦП-пин.
        </Note>
      ) : null}
      <Note icon="flash-outline" tone="warning">
        Не подавайте на АЦП больше 3.3 В — используйте делитель. На ESP32 классические ADC2-пины конфликтуют с Wi-Fi.
      </Note>
    </View>
  );
}
