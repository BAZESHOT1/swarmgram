/**
 * Admin → «База данных»: документация проекта (контейнеры, сервер, клиент, прошивка, kMesh).
 * Документы лежат в services/hub/docs/*.md и раздаются Hub только администраторам.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import * as rawApi from '../../data/api';
import { useTheme } from '../../theme/useTheme';
import { GlassCard } from '../settings/SettingsUI';

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'li'; text: string }
  | { t: 'code'; text: string }
  | { t: 'table'; rows: string[][] }
  | { t: 'hr' };

const FENCE = '```';
const isTableLine = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isListLine = (line: string) => /^\s*([-*]|\d+\.)\s+/.test(line);

/** Минимальный разбор Markdown: заголовки, списки, блоки кода, таблицы, абзацы. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith(FENCE)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(FENCE)) body.push(lines[i++]);
      i++;
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (isTableLine(line)) {
      const rows: string[][] = [];
      while (i < lines.length && isTableLine(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      out.push({ t: 'table', rows });
      continue;
    }
    if (isListLine(line)) {
      out.push({ t: 'li', text: line.replace(/^\s*([-*]|\d+\.)\s+/, '') });
      i++;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (line.trim()) {
      const para: string[] = [line.trim()];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].startsWith('#') &&
        !lines[i].startsWith(FENCE) &&
        !isTableLine(lines[i]) &&
        !isListLine(lines[i])
      ) {
        para.push(lines[i++].trim());
      }
      out.push({ t: 'p', text: para.join(' ') });
      continue;
    }
    i++;
  }
  return out;
}

/** Инлайн: **жирный** и `код`. */
function Inline({ text, color, size }: { text: string; color: string; size: number }) {
  const theme = useTheme();
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <Text style={{ color, fontSize: size, lineHeight: size * 1.5 }} selectable>
      {parts.map((part, idx) =>
        part.startsWith('**') ? (
          <Text key={idx} style={{ fontWeight: '800' }}>
            {part.slice(2, -2)}
          </Text>
        ) : part.startsWith('`') ? (
          <Text key={idx} style={{ fontFamily: 'monospace', backgroundColor: theme.surfacePressed }}>
            {part.slice(1, -1)}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

export function Markdown({ source }: { source: string }) {
  const theme = useTheme();
  const blocks = React.useMemo(() => parseMarkdown(source), [source]);
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((b, idx) => {
        switch (b.t) {
          case 'h':
            return (
              <Text
                key={idx}
                selectable
                style={{
                  color: theme.textPrimary,
                  fontWeight: '800',
                  fontSize: b.level === 1 ? 20 : b.level === 2 ? 16.5 : 14,
                  marginTop: b.level <= 2 ? 10 : 4,
                }}
              >
                {b.text}
              </Text>
            );
          case 'li':
            return (
              <View key={idx} style={{ flexDirection: 'row', gap: 6, paddingLeft: 6 }}>
                <Text style={{ color: theme.textSecondary }}>•</Text>
                <View style={{ flex: 1 }}>
                  <Inline text={b.text} color={theme.textSecondary} size={12.5} />
                </View>
              </View>
            );
          case 'code':
            return (
              <ScrollView key={idx} horizontal style={{ backgroundColor: theme.surfacePressed, borderRadius: 8 }}>
                <Text selectable style={{ color: theme.textPrimary, fontFamily: 'monospace', fontSize: 11, padding: 10 }}>
                  {b.text}
                </Text>
              </ScrollView>
            );
          case 'table':
            return (
              <ScrollView key={idx} horizontal>
                <View style={{ borderWidth: 1, borderColor: theme.line, borderRadius: 8 }}>
                  {b.rows.map((row, r) => (
                    <View
                      key={r}
                      style={{
                        flexDirection: 'row',
                        borderTopWidth: r ? 1 : 0,
                        borderTopColor: theme.line,
                        backgroundColor: r === 0 ? theme.surfacePressed : undefined,
                      }}
                    >
                      {row.map((cell, c) => (
                        <View key={c} style={{ width: 170, padding: 6 }}>
                          <Inline text={cell} color={r === 0 ? theme.textPrimary : theme.textSecondary} size={11.5} />
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
          case 'hr':
            return <View key={idx} style={{ height: 1, backgroundColor: theme.line }} />;
          default:
            return <Inline key={idx} text={b.text} color={theme.textSecondary} size={12.5} />;
        }
      })}
    </View>
  );
}

export function DocsPanel() {
  const theme = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['admin-docs'], queryFn: () => rawApi.api.adminDocs(), staleTime: 60_000 });
  const current = selected ?? list.data?.[0]?.name ?? null;
  const doc = useQuery({
    queryKey: ['admin-doc', current],
    queryFn: () => rawApi.api.adminDoc(current as string),
    enabled: Boolean(current),
    staleTime: 60_000,
  });

  return (
    <View style={{ gap: 10, marginBottom: 12 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {(list.data ?? []).map((item) => {
          const active = item.name === current;
          return (
            <Pressable
              key={item.name}
              onPress={() => setSelected(item.name)}
              accessibilityRole="button"
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
                {item.title}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <GlassCard>
        <View style={{ padding: 14 }}>
          {list.isLoading || doc.isLoading ? (
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Загрузка…</Text>
          ) : doc.data ? (
            <Markdown source={doc.data.content} />
          ) : (
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
              Документы не найдены. Они лежат в services/hub/docs на сервере.
            </Text>
          )}
        </View>
      </GlassCard>
    </View>
  );
}
