/**
 * Первые шаги визарда: плата, роль модуля и тип связи.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../../theme/useTheme';
import { ChoiceCard, Note } from './FirmwareUI';
import { BOARDS, recommendedBatteryPin, recommendedPins, type FirmwareConfig } from './types';

export function BoardStep({
  config,
  onChange,
}: {
  config: FirmwareConfig;
  onChange: (patch: Partial<FirmwareConfig>) => void;
}) {
  const theme = useTheme();
  return (
    <View>
      <Note icon="desktop-outline" tone="warning">
        Прошивка идёт из браузера через Web Serial — нужен компьютер с Chrome или Edge (Chromium) и USB-кабель с передачей данных.
        На телефоне собрать конфигурацию можно, а прошить — только скачав .bin или через OTA.
      </Note>
      {BOARDS.map((board, index) => (
        <ChoiceCard
          key={board.id}
          icon={board.icon}
          title={board.title}
          subtitle={board.short}
          description={board.description}
          selected={config.board === board.id}
          delay={index * 40}
          onPress={() =>
            onChange({
              board: board.id,
              lora: config.lora
                ? { ...config.lora, pins: recommendedPins(board.id) }
                : config.lora,
              battery: config.battery
                ? { ...config.battery, pin: recommendedBatteryPin(board.id) }
                : config.battery,
            })
          }
        />
      ))}
      <Text style={{ color: theme.textDisabled, fontSize: 11.5, lineHeight: 17, paddingHorizontal: 2 }}>
        Пины LoRa и АЦП подставятся рекомендуемые для выбранной платы — их можно изменить на шаге LoRa.
      </Text>
    </View>
  );
}

export function RoleStep({
  config,
  onChange,
}: {
  config: FirmwareConfig;
  onChange: (patch: Partial<FirmwareConfig>) => void;
}) {
  const options = [
    {
      id: 'gateway' as const,
      icon: 'git-network-outline' as const,
      title: 'Шлюз',
      subtitle: 'выход в интернет · Hub',
      description: 'Подключается к Wi-Fi и пересылает сообщения mesh-сети на Hub. Держите его включённым в сети питания.',
    },
    {
      id: 'repeater' as const,
      icon: 'radio-outline' as const,
      title: 'Ретранслятор',
      subtitle: 'расширяет покрытие',
      description: 'Повторяет сигнал между модулями и клиентами. Интернет не обязателен — достаточно питания.',
    },
    {
      id: 'wearable' as const,
      icon: 'watch-outline' as const,
      title: 'Носимый модуль',
      subtitle: 'связь двух клиентов напрямую',
      description: 'Связывает двух клиентов напрямую, без интернета и Hub. Подходит для пары устройств рядом.',
    },
  ];
  return (
    <View>
      {options.map((option, index) => (
        <ChoiceCard
          key={option.id}
          icon={option.icon}
          title={option.title}
          subtitle={option.subtitle}
          description={option.description}
          selected={config.role === option.id}
          delay={index * 40}
          onPress={() => onChange({ role: option.id })}
        />
      ))}
    </View>
  );
}

export function ConnectivityStep({
  config,
  onChange,
}: {
  config: FirmwareConfig;
  onChange: (patch: Partial<FirmwareConfig>) => void;
}) {
  const options = [
    {
      id: 'wifi' as const,
      icon: 'wifi-outline' as const,
      title: 'Только Wi-Fi mesh',
      subtitle: 'проще · меньше деталей',
      description: 'Модуль работает через Wi-Fi и BLE. Не требует LoRa-модуля и антенны.',
    },
    {
      id: 'wifi_lora' as const,
      icon: 'cellular-outline' as const,
      title: 'Wi-Fi mesh + LoRa mesh',
      subtitle: 'дальняя связь · нужен SX12xx',
      description: 'Добавляет дальний радиоканал LoRa. Понадобится модуль SX1278/SX1276/SX1262 и антенна на нужную частоту.',
    },
  ];
  return (
    <View>
      {options.map((option, index) => (
        <ChoiceCard
          key={option.id}
          icon={option.icon}
          title={option.title}
          subtitle={option.subtitle}
          description={option.description}
          selected={config.connectivity === option.id}
          delay={index * 40}
          onPress={() => onChange({ connectivity: option.id })}
        />
      ))}
    </View>
  );
}
