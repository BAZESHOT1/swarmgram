import React from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { PressableScale } from './PressableScale';
import { BANNERS, bannerBackground, type BannerId } from './banner';

/** Стилизованное поле ввода профиля с подписью, подсказкой и счётчиком. */
export function ProfileField({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  hint,
  error,
  multiline,
  editable = true,
  keyboardType,
  autoCapitalize = 'sentences',
  prefix,
  right,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  hint?: string;
  error?: string;
  multiline?: boolean;
  editable?: boolean;
  keyboardType?: 'default' | 'url' | 'numbers-and-punctuation';
  autoCapitalize?: 'none' | 'sentences' | 'words';
  prefix?: string;
  right?: React.ReactNode;
}) {
  const theme = useTheme();
  const [focused, setFocused] = React.useState(false);
  const borderColor = error ? theme.danger : focused ? theme.accent : theme.line;

  return (
    <View style={{ marginBottom: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '600' }}>{label}</Text>
        {right}
      </View>
      <View
        style={[
          styles.inputWrap,
          {
            backgroundColor: theme.dark ? 'rgba(10,14,20,0.55)' : 'rgba(255,255,255,0.85)',
            borderColor,
            opacity: editable ? 1 : 0.6,
          },
        ]}
      >
        {prefix ? <Text style={{ color: theme.textDisabled, fontSize: 15, paddingLeft: 12 }}>{prefix}</Text> : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.textDisabled}
          maxLength={maxLength}
          multiline={multiline}
          editable={editable}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          accessibilityLabel={label}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            color: theme.textPrimary,
            fontSize: 15,
            paddingHorizontal: prefix ? 4 : 12,
            paddingVertical: 10,
            ...(multiline
              ? { minHeight: 92, textAlignVertical: 'top' as never }
              : { minHeight: 44 }),
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
          }}
        />
      </View>
      {error ? (
        <Text style={{ color: theme.danger, fontSize: 11, marginTop: 4 }}>{error}</Text>
      ) : hint ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
          <Text style={{ color: theme.textDisabled, fontSize: 11, flex: 1 }}>{hint}</Text>
          {maxLength ? (
            <Text style={{ color: theme.textDisabled, fontSize: 11 }}>
              {value.length}/{maxLength}
            </Text>
          ) : null}
        </View>
      ) : maxLength ? (
        <Text style={{ color: theme.textDisabled, fontSize: 11, marginTop: 4, textAlign: 'right' }}>
          {value.length}/{maxLength}
        </Text>
      ) : null}
    </View>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  subtitle?: string;
  icon?: keyof typeof Ionicons.glyphMap;
}

/** Радио-группа выбора одного значения (приватность, видимость). */
export function ChoiceGroup<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <PressableScale
            key={option.value}
            onPress={() => onChange(option.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={`${option.label}. ${option.subtitle ?? ''}`}
            style={[
              styles.choice,
              {
                borderTopColor: theme.line,
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                backgroundColor: selected ? theme.accentSoft : 'transparent',
                opacity: disabled ? 0.6 : 1,
              },
            ]}
          >
            {option.icon ? <Ionicons name={option.icon} size={16} color={selected ? theme.accent : theme.textSecondary} /> : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                {option.label}
              </Text>
              {option.subtitle ? (
                <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={2}>
                  {option.subtitle}
                </Text>
              ) : null}
            </View>
            <View
              style={[
                styles.radio,
                {
                  borderColor: selected ? theme.accent : theme.line,
                  backgroundColor: selected ? theme.accent : 'transparent',
                },
              ]}
            >
              {selected ? <Ionicons name="checkmark" size={13} color={theme.onAccent} /> : null}
            </View>
          </PressableScale>
        );
      })}
    </View>
  );
}

/** Палитра баннеров: выбранный отмечен галочкой и рамкой. */
export function BannerPicker({ value, onChange }: { value: BannerId; onChange: (value: BannerId) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.bannerGrid}>
      {BANNERS.map((preset) => {
        const selected = preset.id === value;
        return (
          <PressableScale
            key={preset.id}
            onPress={() => onChange(preset.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`Баннер: ${preset.label}`}
            style={[
              styles.bannerItem,
              {
                borderColor: selected ? theme.textPrimary : theme.line,
                borderWidth: selected ? 2 : 1,
              },
            ]}
          >
            <View style={[styles.bannerSwatch, bannerBackground(preset.id)]}>
              {Platform.OS !== 'web' ? (
                <View style={{ position: 'absolute', right: -12, bottom: -18, width: 46, height: 46, borderRadius: 23, backgroundColor: preset.colors[2], opacity: 0.7 }} />
              ) : null}
              {selected ? (
                <View style={styles.bannerCheck}>
                  <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                </View>
              ) : null}
            </View>
            <Text style={{ color: selected ? theme.textPrimary : theme.textSecondary, fontSize: 11.5, fontWeight: selected ? '700' : '500', marginTop: 5 }} numberOfLines={1}>
              {preset.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  inputWrap: { flexDirection: 'row', alignItems: 'flex-start', borderWidth: 1, borderRadius: 12, overflow: 'hidden', minHeight: 44 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 10, paddingVertical: 11, minHeight: 48 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  bannerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  bannerItem: { width: 88, borderRadius: 14, padding: 5, backgroundColor: 'transparent' },
  bannerSwatch: { height: 48, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  bannerCheck: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
  },
});
