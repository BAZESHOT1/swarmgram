/** Журнал приложения: просмотр, фильтры ([ble], [kmesh]…) и отправка логов. */
import React from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../../src/theme/useTheme';
import { GlassCard, SettingsPage, SettingsSection } from '../../../src/components/settings/SettingsUI';
import {
  clearAppLog,
  formatLogLine,
  getAppLog,
  subscribeAppLog,
  type LogEntry,
} from '../../../src/debug/appLog';

type Filter = 'all' | 'ble' | 'kmesh' | 'module' | 'errors';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'ble', label: 'BLE' },
  { key: 'kmesh', label: 'KMesh' },
  { key: 'module', label: 'Модуль' },
  { key: 'errors', label: 'Ошибки' },
];

function matches(entry: LogEntry, filter: Filter): boolean {
  const t = entry.text.toLowerCase();
  switch (filter) {
    case 'ble':
      return t.includes('[ble]');
    case 'kmesh':
      return t.includes('[kmesh]');
    case 'module':
      return t.includes('[module]') || t.includes('[msg]');
    case 'errors':
      return entry.level === 'error' || entry.level === 'warn';
    default:
      return true;
  }
}

export default function LogsScreen() {
  const theme = useTheme();
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  const [filter, setFilter] = React.useState<Filter>('all');
  React.useEffect(() => subscribeAppLog(bump), []);

  const all = getAppLog();
  const rows = all.filter((e) => matches(e, filter)).slice(-400);
  const color = (level: LogEntry['level']) =>
    level === 'error' ? '#e5484d' : level === 'warn' ? '#e0a100' : theme.textSecondary;

  const share = () => {
    const text = all.filter((e) => matches(e, filter)).map(formatLogLine).join('\n');
    void Share.share({ message: text || 'Журнал пуст', title: 'Журнал Kinto' }).catch(() => undefined);
  };

  return (
    <SettingsPage title="Журнал" subtitle={`Строк в памяти: ${all.length}`}>
      <SettingsSection title="Фильтр" delay={0}>
        <View style={styles.chips}>
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[
                styles.chip,
                {
                  borderColor: theme.glassBorder,
                  backgroundColor: filter === f.key ? theme.accent : theme.glass,
                },
              ]}
            >
              <Text style={{ color: filter === f.key ? '#fff' : theme.textPrimary, fontSize: 13, fontWeight: '600' }}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={[styles.chips, { marginTop: 8 }]}>
          <Pressable onPress={share} style={[styles.chip, { borderColor: theme.glassBorder, backgroundColor: theme.glass }]}>
            <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '600' }}>Поделиться</Text>
          </Pressable>
          <Pressable
            onPress={() => clearAppLog()}
            style={[styles.chip, { borderColor: theme.glassBorder, backgroundColor: theme.glass }]}
          >
            <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '600' }}>Очистить</Text>
          </Pressable>
        </View>
      </SettingsSection>

      <SettingsSection title={`Записи (${rows.length})`} delay={40}>
        <GlassCard>
          <ScrollView style={{ maxHeight: 520 }} nestedScrollEnabled>
            <View style={{ padding: 10 }}>
              {rows.length === 0 ? (
                <Text style={{ color: theme.textDisabled, fontSize: 12.5 }}>Записей нет.</Text>
              ) : (
                rows.map((entry, index) => (
                  <Text key={`${entry.at}-${index}`} selectable style={[styles.line, { color: color(entry.level) }]}>
                    {formatLogLine(entry)}
                  </Text>
                ))
              )}
            </View>
          </ScrollView>
        </GlassCard>
      </SettingsSection>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  line: { fontSize: 11, lineHeight: 15, fontFamily: 'monospace', marginBottom: 2 },
});
