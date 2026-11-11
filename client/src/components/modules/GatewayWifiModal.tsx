/**
 * Модалка «Wi-Fi шлюза»: SSID и пароль роутера уходят шлюзу кадром SET_CONFIG
 * через уже открытое USB/BLE-соединение. Пароль не логируется и не сохраняется
 * на клиенте — только отправляется в модуль.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { SettingsInput, SettingsModal } from '../settings/SettingsWidgets';
import type { ModuleRow } from '../../data/api';

export function GatewayWifiModal({
  visible,
  module,
  connected,
  saving,
  onClose,
  onSave,
}: {
  visible: boolean;
  module: ModuleRow | null;
  /** Есть ли активное USB/BLE-соединение именно с этим шлюзом. */
  connected: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (ssid: string, password: string) => Promise<boolean>;
}) {
  const theme = useTheme();
  const [ssid, setSsid] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    setSsid('');
    setPassword('');
    setError('');
    setShowPassword(false);
  }, [visible, module?.id]);

  const submit = async () => {
    const clean = ssid.trim();
    if (!clean) {
      setError('Укажите SSID Wi-Fi роутера.');
      return;
    }
    if (clean.length > 32) {
      setError('SSID длиннее 32 символов — проверьте название сети.');
      return;
    }
    if (password.length > 0 && password.length < 8) {
      setError('Пароль короче 8 символов. Для открытой сети оставьте поле пустым.');
      return;
    }
    setError('');
    const ok = await onSave(clean, password);
    if (ok) onClose();
  };

  return (
    <SettingsModal
      visible={visible}
      title="Wi-Fi шлюза"
      subtitle={
        module
          ? `Роутер для шлюза${module.publicId ? ` ID ${module.publicId}` : ''}. Пароль уйдёт только в модуль.`
          : undefined
      }
      onClose={onClose}
      maxWidth={420}
    >
      <View style={{ gap: 4 }}>
        {!connected ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 8,
              padding: 11,
              borderRadius: 12,
              backgroundColor: theme.warningSoft,
              marginBottom: 8,
            }}
          >
            <Ionicons name="hardware-chip-outline" size={16} color={theme.warning} style={{ marginTop: 1 }} />
            <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, flex: 1 }}>
              Подключите шлюз по USB/BLE — иначе отправить настройки некуда. Список модулей показывает шлюз, но
              активного соединения с ним сейчас нет.
            </Text>
          </View>
        ) : (
          <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginBottom: 4 }}>
            Шлюз подключён. После сохранения он переподключится к вашему роутеру; mesh-сеть останется прежней.
          </Text>
        )}

        <SettingsInput
          label="SSID роутера"
          value={ssid}
          onChangeText={(value) => {
            setSsid(value);
            if (error) setError('');
          }}
          placeholder="например, HomeWiFi"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={32}
          editable={connected && !saving}
          accessibilityLabel="SSID Wi-Fi роутера"
        />
        <View>
          <SettingsInput
            label="Пароль Wi-Fi"
            value={password}
            onChangeText={(value) => {
              setPassword(value);
              if (error) setError('');
            }}
            placeholder="оставьте пустым для открытой сети"
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={63}
            editable={connected && !saving}
            accessibilityLabel="Пароль Wi-Fi роутера"
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
            <Text style={{ color: theme.textDisabled, fontSize: 11 }}>Пароль не сохраняется на клиенте</Text>
            <Text
              onPress={() => setShowPassword((value) => !value)}
              accessibilityRole="button"
              accessibilityLabel={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }}
            >
              {showPassword ? 'Скрыть' : 'Показать'}
            </Text>
          </View>
        </View>

        {error ? (
          <Text accessibilityRole="alert" style={{ color: theme.danger, fontSize: 12, lineHeight: 17, marginTop: 6 }}>
            {error}
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <View style={{ flex: 1 }}>
            <Btn title="Отмена" variant="ghost" onPress={onClose} disabled={saving} />
          </View>
          <View style={{ flex: 1.4 }}>
            <Btn
              title="Сохранить"
              loading={saving}
              disabled={!connected || !ssid.trim()}
              onPress={() => void submit()}
            />
          </View>
        </View>
      </View>
    </SettingsModal>
  );
}
