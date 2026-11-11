/**
 * Шаг Hub: Wi-Fi, адрес Hub, токен модуля, привязка по UUID и OTA.
 */
import React from 'react';
import { Alert, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Btn } from '../Btn';
import { humanError } from '../../data/queries';
import { useTheme } from '../../theme/useTheme';
import { SettingsInput } from '../settings/SettingsWidgets';
import { SettingsToggle } from '../settings/SettingsUI';
import { ErrorText, StepCard } from './FirmwareUI';
import {
  DEFAULT_HUB_URL,
  generateBoardUuid,
  getModuleNetwork,
  pairModule,
  rotateModuleNetwork,
  type FirmwareConfig,
  type ModuleNetwork,
} from './types';

async function copyToClipboard(value: string): Promise<void> {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const { Clipboard } = await import('react-native');
  Clipboard.setString(value);
}

export function HubStep({
  config,
  onChange,
  firmwareVersion,
}: {
  config: FirmwareConfig;
  onChange: (patch: Partial<FirmwareConfig>) => void;
  firmwareVersion?: string;
}) {
  const theme = useTheme();
  const wifi = config.wifi ?? { ssid: '', password: '' };
  const [boardUuid, setBoardUuid] = React.useState('');
  const [pairing, setPairing] = React.useState(false);
  const [pairError, setPairError] = React.useState('');
  const [pairToken, setPairToken] = React.useState('');
  const [copied, setCopied] = React.useState(false);

  // «Сеть аккаунта»: SSID/пароль генерирует Hub, клиент только читает.
  const [network, setNetwork] = React.useState<ModuleNetwork | null>(null);
  const [networkLoading, setNetworkLoading] = React.useState(true);
  const [networkBusy, setNetworkBusy] = React.useState(false);
  const [networkError, setNetworkError] = React.useState('');
  const [showNetworkPass, setShowNetworkPass] = React.useState(false);

  const errorMessage = (error: unknown): string =>
    error instanceof Error && error.message ? error.message : humanError(error);

  const loadNetwork = React.useCallback(async () => {
    setNetworkLoading(true);
    setNetworkError('');
    try {
      setNetwork(await getModuleNetwork());
    } catch (error) {
      setNetworkError(errorMessage(error));
    } finally {
      setNetworkLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadNetwork();
  }, [loadNetwork]);

  const rotateNetwork = async () => {
    setNetworkBusy(true);
    setNetworkError('');
    try {
      const updated = await rotateModuleNetwork();
      setNetwork(updated);
      setShowNetworkPass(false);
    } catch (error) {
      setNetworkError(errorMessage(error));
    } finally {
      setNetworkBusy(false);
    }
  };

  // Ротация рвёт связь всем модулям — спрашиваем подтверждение.
  const confirmRotateNetwork = () => {
    const message =
      'Все модули аккаунта потеряют связь с mesh, пока им не обновят прошивку или не передадут новый пароль.';
    if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (window.confirm(`Обновить пароль mesh-сети?\n\n${message}`)) void rotateNetwork();
      return;
    }
    Alert.alert('Обновить пароль mesh-сети?', message, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Обновить', style: 'destructive', onPress: () => void rotateNetwork() },
    ]);
  };

  const updateWifi = (patch: Partial<{ ssid: string; password: string }>) => {
    onChange({ wifi: { ...wifi, ...patch } });
  };

  const pair = async () => {
    const uuid = boardUuid.trim().toLowerCase();
    if (uuid.length < 8) {
      setPairError('UUID платы должен содержать минимум 8 символов.');
      return;
    }
    setPairError('');
    setPairing(true);
    try {
      const result = await pairModule({
        boardUuid: uuid,
        kind: config.connectivity === 'wifi_lora' ? 'lora' : 'wifi',
        firmware: firmwareVersion || undefined,
      });
      if (!result?.moduleToken) {
        throw new Error('Hub не вернул токен модуля. Привязка не завершена.');
      }
      setPairToken(result.moduleToken);
      onChange({ moduleToken: result.moduleToken });
    } catch (error) {
      setPairError(humanError(error));
    } finally {
      setPairing(false);
    }
  };

  return (
    <View>
      <SettingsInput
        label="SSID Wi-Fi"
        value={wifi.ssid}
        onChangeText={(ssid) => updateWifi({ ssid })}
        placeholder="например, HomeMesh"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={64}
        accessibilityLabel="SSID Wi-Fi сети"
      />
      <SettingsInput
        label="Пароль Wi-Fi"
        value={wifi.password}
        onChangeText={(password) => updateWifi({ password })}
        placeholder="оставьте пустым для открытой сети"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={128}
        accessibilityLabel="Пароль Wi-Fi"
      />
      <SettingsInput
        label="URL Hub"
        value={config.hubUrl ?? ''}
        onChangeText={(hubUrl) => onChange({ hubUrl })}
        placeholder={DEFAULT_HUB_URL}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={256}
        accessibilityLabel="URL Hub"
      />
      <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: -4, marginBottom: 14, paddingHorizontal: 2 }}>
        По умолчанию {DEFAULT_HUB_URL}. Если Hub без HTTPS, браузер может блокировать запросы с HTTPS-страницы.
      </Text>

      <StepCard>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Ionicons name="wifi-outline" size={17} color={theme.accent} />
          <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700', flex: 1 }}>Сеть модулей</Text>
          {network ? (
            <Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>rev {network.revision}</Text>
          ) : null}
        </View>
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17.5, marginBottom: 10 }}>
          Скрытая Wi-Fi mesh-сеть аккаунта: SSID и пароль одинаковы у всех ваших модулей. Сервер подставит их в
          прошивку сам — вручную вводить не нужно.
        </Text>

        {networkLoading ? (
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 10 }}>Загружаем сеть…</Text>
        ) : null}

        {networkError ? <ErrorText>{networkError}</ErrorText> : null}

        {!networkLoading && !network && !networkError ? (
          <View style={{ marginBottom: 10 }}>
            <Btn title="Загрузить сеть" size="s" variant="ghost" onPress={() => void loadNetwork()} />
          </View>
        ) : null}

        {network ? (
          <View
            style={{
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.glassBorder,
              backgroundColor: theme.surfaceElevated,
              padding: 10,
              marginBottom: 10,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12, flex: 1 }}>SSID</Text>
              <Text selectable style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }}>
                {network.ssid}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12, flex: 1 }}>Пароль</Text>
              <Text selectable style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }}>
                {showNetworkPass ? network.password : '•'.repeat(Math.min(16, network.password.length))}
              </Text>
              <Pressable
                onPress={() => setShowNetworkPass((value) => !value)}
                accessibilityRole="button"
                accessibilityLabel={showNetworkPass ? 'Скрыть пароль сети' : 'Показать пароль сети'}
                style={({ pressed }) => ({ marginLeft: 10, opacity: pressed ? 0.6 : 1 })}
              >
                <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }}>
                  {showNetworkPass ? 'Скрыть' : 'Показать'}
                </Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12, flex: 1 }}>Режим</Text>
              <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }}>скрытая</Text>
            </View>
            <Text selectable style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 8 }}>
              networkId: {network.networkId}
            </Text>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Btn
              title="Обновить пароль"
              size="s"
              variant="ghost"
              disabled={!network || networkBusy}
              loading={networkBusy}
              onPress={confirmRotateNetwork}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Btn
              title="Обновить данные"
              size="s"
              variant="ghost"
              disabled={networkLoading || networkBusy}
              onPress={() => void loadNetwork()}
            />
          </View>
        </View>
        <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: 8, lineHeight: 17, paddingHorizontal: 2 }}>
          После смены пароля прошивку модулей нужно собрать заново — старые .bin останутся в старой сети. Пароль
          хранится только на Hub и передаётся в прошивку при сборке.
        </Text>
      </StepCard>

      <View style={{ height: 12 }} />
      <StepCard>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Ionicons name="link-outline" size={17} color={theme.accent} />
          <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700', flex: 1 }}>Привязка модуля</Text>
        </View>
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17.5, marginBottom: 10 }}>
          Введите UUID платы (на корпусе или сгенерируйте новый) и привяжите модуль к аккаунту. Hub вернёт токен — он попадёт в прошивку.
        </Text>

        <SettingsInput
          label="UUID платы"
          value={boardUuid}
          onChangeText={(value) => {
            setBoardUuid(value);
            if (pairError) setPairError('');
            if (pairToken) setPairToken('');
          }}
          placeholder="esp32-a1b2c3d4"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={64}
          accessibilityLabel="UUID платы"
        />
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
          <View style={{ flex: 1 }}>
            <Btn
              title="Сгенерировать UUID"
              size="s"
              variant="ghost"
              onPress={() => {
                setBoardUuid(generateBoardUuid());
                setPairError('');
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Btn title="Привязать модуль сейчас" size="s" loading={pairing} onPress={() => void pair()} />
          </View>
        </View>

        {pairError ? <ErrorText>{pairError}</ErrorText> : null}

        {pairToken ? (
          <View
            style={{
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.glassBorder,
              backgroundColor: theme.successSoft,
              padding: 10,
              marginBottom: 10,
            }}
          >
            <Text style={{ color: theme.success, fontSize: 11.5, fontWeight: '700', marginBottom: 4 }}>
              Токен модуля получен
            </Text>
            <Text selectable style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }}>
              {pairToken}
            </Text>
            <Pressable
              onPress={() =>
                void copyToClipboard(pairToken)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  })
                  .catch(() => undefined)
              }
              accessibilityRole="button"
              accessibilityLabel="Скопировать токен модуля"
              style={({ pressed }) => ({ marginTop: 8, opacity: pressed ? 0.6 : 1, alignSelf: 'flex-start' })}
            >
              <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }}>
                {copied ? 'Скопировано' : 'Скопировать токен'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <SettingsInput
          label="Токен модуля / claim-токен"
          value={config.moduleToken ?? ''}
          onChangeText={(moduleToken) => onChange({ moduleToken })}
          placeholder="вставьте токен вручную или получите привязкой"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={256}
          accessibilityLabel="Токен модуля или claim-токен"
        />
        <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: -4, lineHeight: 17, paddingHorizontal: 2 }}>
          Токен показывается один раз. Если потеряли — отвяжите модуль и создайте новый токен.
        </Text>
      </StepCard>

      <View style={{ height: 12 }} />
      <StepCard>
        <SettingsToggle
          icon="cloud-download-outline"
          title="OTA-обновления"
          subtitle="модуль сможет обновляться по воздуху после первой прошивки"
          value={config.ota ?? true}
          onValueChange={(ota) => onChange({ ota })}
        />
      </StepCard>
    </View>
  );
}
