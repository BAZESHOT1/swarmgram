/**
 * Интерактивная карта кластера KMesh.
 *
 * Сверху — мой модуль (последний подключённый носимый), ниже — узлы, которых он слышит напрямую,
 * ещё ниже — остальные узлы кластера, внизу — пограничные узлы соседних кластеров.
 * Рёбра — прямая радиосвязь между узлами (из INFO модуля и карты Hub). Шлюзы с выходом в Hub
 * помечены значком глобуса. Нажатие на узел показывает его данные.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';

export interface MapNode {
  nodeId: number;
  name: string;
  mac?: string;
  online: boolean;
  gateway: boolean;
  hub: boolean;
  rssi: number | null;
  battery: number | null;
  /** 0 — мой модуль, 1 — сосед, 2 — кластер, 3 — соседний кластер. */
  layer: 0 | 1 | 2 | 3;
  mine: boolean;
}

export interface MapLink {
  a: number;
  b: number;
  rssi: number;
  lora: boolean;
}

const NODE = 44;
const ROW_H = 92;

function rssiColor(rssi: number, theme: ReturnType<typeof useTheme>): string {
  if (rssi >= -65) return theme.success;
  if (rssi >= -80) return theme.warning;
  return theme.danger;
}

export function ClusterMap({ nodes, links }: { nodes: MapNode[]; links: MapLink[] }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);

  const layout = useMemo(() => {
    const rows: MapNode[][] = [[], [], [], []];
    for (const n of nodes) rows[n.layer].push(n);
    const used = rows.map((r, i) => ({ r, i })).filter((x) => x.r.length > 0);
    const pos = new Map<number, { x: number; y: number }>();
    used.forEach(({ r }, rowIndex) => {
      const step = width / (r.length + 1);
      r.forEach((n, i) => pos.set(n.nodeId, { x: step * (i + 1), y: 24 + rowIndex * ROW_H + NODE / 2 }));
    });
    return { pos, height: Math.max(1, used.length) * ROW_H + 8 };
  }, [nodes, width]);

  const sel = nodes.find((n) => n.nodeId === selected) ?? null;
  const selLinks = sel ? links.filter((l) => l.a === sel.nodeId || l.b === sel.nodeId) : [];

  return (
    <View>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height: layout.height, overflow: 'hidden' }}
      >
        {width > 0 &&
          links.map((l, i) => {
            const p1 = layout.pos.get(l.a);
            const p2 = layout.pos.get(l.b);
            if (!p1 || !p2) return null;
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
            const active = selected != null && (l.a === selected || l.b === selected);
            return (
              <View
                key={`${l.a}-${l.b}-${i}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: (p1.x + p2.x) / 2 - len / 2,
                  top: (p1.y + p2.y) / 2 - 1,
                  width: len,
                  height: active ? 3 : 2,
                  borderRadius: 2,
                  backgroundColor: rssiColor(l.rssi, theme),
                  opacity: selected == null || active ? 0.75 : 0.2,
                  borderStyle: l.lora ? 'dashed' : 'solid',
                  transform: [{ rotate: `${angle}deg` }],
                }}
              />
            );
          })}
        {width > 0 &&
          nodes.map((n) => {
            const p = layout.pos.get(n.nodeId);
            if (!p) return null;
            const color = n.layer === 0 ? theme.accent : n.online ? theme.success : theme.textDisabled;
            const isSel = selected === n.nodeId;
            return (
              <Pressable
                key={n.nodeId}
                onPress={() => setSelected(isSel ? null : n.nodeId)}
                accessibilityRole="button"
                accessibilityLabel={`Узел ${n.name}`}
                style={{ position: 'absolute', left: p.x - 40, top: p.y - NODE / 2, width: 80, alignItems: 'center' }}
              >
                <View
                  style={{
                    width: NODE,
                    height: NODE,
                    borderRadius: NODE / 2,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: theme.surfaceElevated,
                    borderWidth: isSel ? 3 : 2,
                    borderColor: color,
                    opacity: n.layer === 3 ? 0.7 : 1,
                  }}
                >
                  <Ionicons
                    name={n.layer === 0 ? 'watch-outline' : n.gateway ? 'radio-outline' : 'git-network-outline'}
                    size={19}
                    color={color}
                  />
                  {n.hub ? (
                    <View
                      style={{
                        position: 'absolute',
                        right: -4,
                        top: -4,
                        width: 18,
                        height: 18,
                        borderRadius: 9,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: theme.warning,
                      }}
                    >
                      <Ionicons name="globe-outline" size={12} color="#fff" />
                    </View>
                  ) : null}
                </View>
                <Text
                  numberOfLines={1}
                  style={{ color: theme.textSecondary, fontSize: 10, marginTop: 3, maxWidth: 78, textAlign: 'center' }}
                >
                  {n.name}
                </Text>
              </Pressable>
            );
          })}
      </View>

      {sel ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.line, padding: 12, gap: 4 }}>
          <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700' }}>{sel.name}</Text>
          <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>
            {[
              sel.layer === 0 ? 'мой модуль' : sel.layer === 3 ? 'соседний кластер' : sel.gateway ? 'шлюз' : 'узел кластера',
              sel.hub ? 'есть связь с Hub' : null,
              sel.online ? 'онлайн' : 'офлайн',
              sel.rssi != null ? `${sel.rssi} dBm` : null,
              sel.battery != null ? `заряд ${sel.battery}%` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Text style={{ color: theme.textDisabled, fontSize: 11 }}>
            {sel.mac ? `MAC ${sel.mac} · ` : ''}узел {sel.nodeId.toString(16)} · связей: {selLinks.length}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** nodeId прошивки: FNV-1a(hex MAC) с резервными значениями — как kl_node_id_from_mac(). */
export function nodeIdFromMac(mac: string): number {
  const hex = mac.toLowerCase().replace(/^esp32-/, '').replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < hex.length; i++) {
    h ^= hex.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let id = ((h & 0x7ffffffe) | 0x10000000) >>> 0;
  if (id <= 1) id = 0x10000002;
  return id;
}
