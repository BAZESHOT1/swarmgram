/**
 * Удалённая настройка модуля: тип, делитель батареи, LoRa (чип, пины, мощность), мощность ESP-NOW.
 *
 * Команда подписывается Hub (только владельцу модуля) и уходит в подключённый модуль по BLE/USB
 * либо через него по mesh другому узлу. Значения хранятся в NVS модуля, перепрошивка не нужна;
 * после применения модуль перезагружается.
 */
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { SettingsInput, SettingsModal } from '../settings/SettingsWidgets';
import { useModuleConnection } from '../../modules/ModuleProvider';
import { nodeIdFromMac } from './ClusterMap';

const CHIPS: Array<{ code: number; title: string }> = [
  { code: 1, title: 'SX1262' },
  { code: 0, title: 'SX1278' },
  { code: 2, title: 'SX1276' },
  { code: 3, title: 'LR2021' },
];
const PIN_KEYS = ['SCK', 'MISO', 'MOSI', 'CS', 'RST', 'IRQ', 'BUSY'] as const;

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        paddingHorizontal: 11,
        height: 30,
        borderRadius: 999,
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: active ? theme.accent : theme.line,
        backgroundColor: active ? theme.accentSoft : theme.surface,
      }}
    >
      <Text style={{ color: active ? theme.accent : theme.textSecondary, fontSize: 11.5, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
}

const digits = (text: string) => text.replace(/[^0-9-]/g, '').slice(0, 4);

export function ModuleConfigSheet({
  target,
  onClose,
}: {
  target: { name: string; mac: string } | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const connection = useModuleConnection();
  const info = connection.connected ? connection.info : null;
  const mac12 = target?.mac.toLowerCase().replace(/^esp32-/, '').replace(/[^0-9a-f]/g, '') ?? '';
  const live = info && info.hardwareId.toLowerCase().replace(/^esp32-/, '') === mac12 ? info : null;
  const hw = live?.hw;
  const isGateway = live?.role === 'gateway';

  const [role, setRole] = React.useState<'c' | 'r' | ''>('');
  const [battPin, setBattPin] = React.useState('');
  const [battRatio, setBattRatio] = React.useState('');
  const [chip, setChip] = React.useState<number | null>(null);
  const [pins, setPins] = React.useState<string[]>(['', '', '', '', '', '', '']);
  const [espnow, setEspnow] = React.useState('');
  const [loraPower, setLoraPower] = React.useState('');
  const [ifEspnow, setIfEspnow] = React.useState(true);
  const [ifLora, setIfLora] = React.useState(false);
  const [ifTouched, setIfTouched] = React.useState(false);
  const [led, setLed] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  // Подставляем текущие значения модуля, когда они известны (прямое подключение).
  React.useEffect(() => {
    if (!target) return;
    setError('');
    setRole(live ? (live.role === 'repeater' ? 'r' : live.role === 'wearable' ? 'c' : '') : '');
    setBattPin(hw ? (hw.b >= 0 ? String(hw.b) : '') : '');
    setBattRatio(hw ? String(hw.r / 100) : '');
    setChip(hw && hw.lb ? hw.c : null);
    setPins(hw && hw.lb ? hw.l.map(String) : ['', '', '', '', '', '', '']);
    setEspnow(hw && hw.e > 0 ? String(hw.e) : '');
    setLoraPower(hw && hw.lb ? String(hw.w) : '');
    setIfEspnow(hw?.i !== undefined ? (hw.i & 1) !== 0 : true);
    setIfLora(hw?.i !== undefined ? (hw.i & 2) !== 0 : false);
    setIfTouched(false);
    setLed('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.mac, hw?.he]);

  const build = (): string | null => {
    const parts: string[] = [];
    if (role) parts.push(`r=${role}`);
    if (ifTouched) {
      const mask = (ifEspnow ? 1 : 0) | (ifLora ? 2 : 0);
      if (!mask) return null;
      parts.push(`i=${mask}`);
    }
    if (led.trim()) {
      const v = Number(led);
      if (!Number.isInteger(v) || v < -1 || v > 48) return null;
      parts.push(`d=${v}`);
    }
    // Пин батареи: пусто при известном модуле = «нет батареи» (-1), иначе поле не трогаем.
    if (battPin.trim() !== '' || hw) {
      const pin = battPin.trim() === '' ? -1 : Number(battPin);
      const ratio = Math.round(Number(battRatio.replace(',', '.') || '2') * 100);
      if (!Number.isInteger(pin) || pin < -1 || pin > 48) return null;
      if (!Number.isFinite(ratio) || ratio < 100 || ratio > 1000) return null;
      parts.push(`b=${pin},${ratio}`);
    }
    if (chip !== null) parts.push(`c=${chip}`);
    if (pins.every((v) => v.trim() !== '')) {
      const values = pins.map(Number);
      if (values.some((v) => !Number.isInteger(v) || v < -1 || v > 48)) return null;
      parts.push(`l=${values.join(',')}`);
    }
    if (espnow.trim()) {
      const v = Number(espnow);
      if (!Number.isInteger(v) || v < 2 || v > 21) return null;
      parts.push(`e=${v}`);
    }
    if (loraPower.trim()) {
      const v = Number(loraPower);
      if (!Number.isInteger(v) || v < 2 || v > 22) return null;
      parts.push(`w=${v}`);
    }
    return parts.length ? parts.join(';') : '';
  };

  const submit = async () => {
    if (!target) return;
    const p = build();
    if (p === null) {
      setError('Проверьте значения: пины 0–48, мощность ESP-NOW 2–21, LoRa 2–22 дБм, коэффициент 1–10.');
      return;
    }
    if (!p) {
      setError('Нечего менять.');
      return;
    }
    setBusy(true);
    setError('');
    const ok = await connection.applyHardware({ mac: target.mac, nodeId: nodeIdFromMac(target.mac) || undefined }, p);
    setBusy(false);
    if (ok) onClose();
  };

  const label = (text: string) => (
    <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '700', marginTop: 10, marginBottom: 4 }}>{text}</Text>
  );

  return (
    <SettingsModal
      visible={target !== null}
      title="Настройка модуля"
      subtitle={target ? `${target.name} · ${target.mac}` : undefined}
      onClose={onClose}
    >
      <ScrollView style={{ maxHeight: 460 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 17 }}>
          {live
            ? 'Модуль подключён напрямую: текущие значения подставлены.'
            : 'Модуль не подключён напрямую: команда уйдёт через ваш носимый модуль по mesh, а если его нет — через Hub и шлюз кластера. Заполните только то, что меняете. Нужен интернет — подпись выдаёт Hub.'}
        </Text>

        {!isGateway ? (
          <>
            {label('Тип модуля')}
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Chip label="не менять" active={role === ''} onPress={() => setRole('')} />
              <Chip label="Носимый" active={role === 'c'} onPress={() => setRole('c')} />
              <Chip label="Ретранслятор" active={role === 'r'} onPress={() => setRole('r')} />
            </View>
            <Text style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 4 }}>
              Шлюз нельзя превратить в другой тип без перепрошивки: у него другая сборка.
            </Text>
          </>
        ) : null}

        {label('Транспорты')}
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Chip
            label="ESP-NOW"
            active={ifEspnow}
            onPress={() => {
              setIfEspnow((v) => !v);
              setIfTouched(true);
            }}
          />
          <Chip
            label="LoRa"
            active={ifLora}
            onPress={() => {
              setIfLora((v) => !v);
              setIfTouched(true);
            }}
          />
        </View>
        <Text style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 4 }}>
          С обоими транспортами модуль работает мостом: пакеты переходят между ESP-NOW и LoRa.
        </Text>

        {label('Делитель батареи')}
        <SettingsInput
          label="Пин (пусто — батареи нет)"
          value={battPin}
          onChangeText={(t) => setBattPin(digits(t))}
          keyboardType="numeric"
          accessibilityLabel="Пин делителя батареи"
        />
        <SettingsInput
          label="Коэффициент делителя"
          value={battRatio}
          onChangeText={(t) => setBattRatio(t.replace(/[^0-9.,]/g, '').slice(0, 5))}
          keyboardType="numeric"
          placeholder="2.0"
          accessibilityLabel="Коэффициент делителя"
        />

        {label('LoRa')}
        {hw && !hw.lb ? (
          <Text style={{ color: theme.warning, fontSize: 11.5, lineHeight: 17 }}>
            Прошивка этого модуля старше 178 и собрана без LoRa: чип и пины не применятся, нужна перепрошивка.
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {CHIPS.map((c) => (
                <Chip key={c.code} label={c.title} active={chip === c.code} onPress={() => setChip(c.code)} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {PIN_KEYS.map((key, i) => (
                <View key={key} style={{ width: '30%', minWidth: 90 }}>
                  <SettingsInput
                    label={key}
                    value={pins[i]}
                    onChangeText={(t) => setPins((prev) => prev.map((v, idx) => (idx === i ? digits(t) : v)))}
                    keyboardType="numeric"
                    accessibilityLabel={`Пин LoRa ${key}`}
                  />
                </View>
              ))}
            </View>
            <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>
              Пины меняются только все сразу (все семь заполнены); для SX127x BUSY можно указать -1.
            </Text>
          </>
        )}

        {label('Светодиод')}
        <SettingsInput
          label="Пин светодиода (-1 — нет)"
          value={led}
          onChangeText={(t) => setLed(digits(t))}
          keyboardType="numeric"
          placeholder="не менять"
          accessibilityLabel="Пин светодиода"
        />

        {label('Мощность сигнала')}
        <SettingsInput
          label="ESP-NOW, дБм (2–21)"
          value={espnow}
          onChangeText={(t) => setEspnow(digits(t))}
          keyboardType="numeric"
          accessibilityLabel="Мощность ESP-NOW"
        />
        <SettingsInput
          label="LoRa, дБм (2–22)"
          value={loraPower}
          onChangeText={(t) => setLoraPower(digits(t))}
          keyboardType="numeric"
          accessibilityLabel="Мощность LoRa"
        />
        <Text style={{ color: theme.textDisabled, fontSize: 10.5, lineHeight: 15 }}>
          Для шлюза на C3 высокая мощность ESP-NOW может мешать подключению к роутеру — меняйте осторожно.
        </Text>
      </ScrollView>
      {error ? <Text style={{ color: theme.danger, fontSize: 12, marginTop: 8 }}>{error}</Text> : null}
      <View style={{ height: 10 }} />
      <Btn title="Применить и перезагрузить модуль" loading={busy} onPress={() => void submit()} />
    </SettingsModal>
  );
}
