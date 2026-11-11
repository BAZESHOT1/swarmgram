/**
 * Карта mesh-сети аккаунта: Hub в центре, вокруг шлюзы, затем ретрансляторы
 * и носимые модули. Рисуем только реальные модули из списка — никаких
 * выдуманных узлов и связей. Связи строятся по иерархии ролей; если сервер
 * когда-нибудь отдаст явных соседей, их можно передать через `linkTargets`.
 */
import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import type { ModuleRow } from '../../data/api';
import { moduleRoleLabel, moduleStatusView } from './moduleUi';

interface Props {
  modules: ModuleRow[];
  selectedId: string | null;
  onSelect: (module: ModuleRow) => void;
  /**
   * Явные связи: id модуля → id соседей. Необязательно; при отсутствии
   * используется иерархия «шлюз → Hub, ретранслятор → шлюз, носимый → ретранслятор».
   */
  linkTargets?: Record<string, string[]>;
}

interface PlacedNode {
  module: ModuleRow;
  x: number;
  y: number;
  level: 0 | 1 | 2;
  color: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const HUB_ID = '__hub__';

function roleLevel(module: ModuleRow): 0 | 1 | 2 {
  if ((module.role ?? 'gateway') === 'gateway') return 0;
  if (module.role === 'repeater') return 1;
  return 2;
}

function roleIcon(module: ModuleRow): keyof typeof Ionicons.glyphMap {
  if ((module.role ?? 'gateway') === 'gateway') return 'git-network-outline';
  if (module.role === 'repeater') return 'radio-outline';
  return 'watch-outline';
}

/** Связь рисуем поверх карты как тонкую линию с поворотом вокруг центра. */
function Link({
  x1,
  y1,
  x2,
  y2,
  color,
  dashed,
  width = 1.4,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dashed: boolean;
  width?: number;
}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 1) return null;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Пунктир без react-native-svg: несколько коротких штрихов вдоль линии.
  if (dashed) {
    const segments = Math.max(2, Math.floor(length / 8));
    const gap = length / segments;
    return (
      <>
        {Array.from({ length: segments }).map((_, index) => {
          const t = (index + 0.5) / segments;
          return (
            <View
              key={`dash-${x1}-${y1}-${x2}-${y2}-${index}`}
              style={{
                position: 'absolute',
                left: x1 + dx * t - gap * 0.32,
                top: y1 + dy * t - width / 2,
                width: gap * 0.64,
                height: width,
                borderRadius: width,
                backgroundColor: color,
                transform: [{ rotate: `${angle}deg` }],
              }}
            />
          );
        })}
      </>
    );
  }
  return (
    <View
      style={{
        position: 'absolute',
        left: (x1 + x2) / 2 - length / 2,
        top: (y1 + y2) / 2 - width / 2,
        width: length,
        height: width,
        borderRadius: width,
        backgroundColor: color,
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
}

export function ModulesNetworkMap({ modules, selectedId, onSelect, linkTargets }: Props) {
  const theme = useTheme();
  const [width, setWidth] = React.useState(0);
  const widthRef = React.useRef(0);
  const fallbackWidth = Platform.OS === 'web' && typeof window !== 'undefined' ? Math.min(680, window.innerWidth - 64) : 320;
  const mapWidth = width > 0 ? width : fallbackWidth;
  const compact = mapWidth < 520;
  const height = compact ? 200 : 280;
  const nodeSize = compact ? 32 : 40;
  const ios = Platform.OS === 'ios';

  const placed = React.useMemo<PlacedNode[]>(() => {
    const groups: ModuleRow[][] = [[], [], []];
    for (const module of modules) groups[roleLevel(module)].push(module);

    const cx = mapWidth / 2;
    const cy = height / 2;
    const maxRx = Math.max(60, mapWidth / 2 - nodeSize / 2 - 8);
    const radii = compact
      ? [
          { rx: Math.min(maxRx * 0.58, 140), ry: height * 0.24 },
          { rx: Math.min(maxRx * 0.84, 210), ry: height * 0.36 },
          { rx: maxRx * 0.98, ry: height * 0.43 },
        ]
      : [
          { rx: Math.min(maxRx * 0.58, 210), ry: height * 0.24 },
          { rx: Math.min(maxRx * 0.84, 300), ry: height * 0.36 },
          { rx: maxRx * 0.98, ry: height * 0.44 },
        ];

    const result: PlacedNode[] = [];
    groups.forEach((group, level) => {
      if (!group.length) return;
      const ring = radii[level];
      // Один узел — сверху; несколько — равномерно по эллипсу со сдвигом уровня.
      const start = -Math.PI / 2 + level * 0.45;
      const step = (Math.PI * 2) / Math.max(1, group.length);
      group.forEach((module, index) => {
        const angle = group.length === 1 ? -Math.PI / 2 : start + step * index;
        const rawX = cx + ring.rx * Math.cos(angle);
        const rawY = cy + ring.ry * Math.sin(angle);
        const x = Math.max(nodeSize / 2 + 2, Math.min(mapWidth - nodeSize / 2 - 2, rawX));
        const y = Math.max(nodeSize / 2 + 2, Math.min(height - nodeSize / 2 - 10, rawY));
        const status = moduleStatusView(module);
        const color =
          status.tone === 'danger'
            ? theme.danger
            : status.tone === 'warning'
              ? theme.warning
              : status.tone === 'success'
                ? theme.success
                : theme.textDisabled;
        result.push({
          module,
          x,
          y,
          level: level as 0 | 1 | 2,
          color,
          icon: roleIcon(module),
        });
      });
    });
    // Слишком близкие узлы одного уровня слегка раздвигаем по вертикали.
    for (let i = 0; i < result.length; i += 1) {
      for (let j = i + 1; j < result.length; j += 1) {
        const a = result[i];
        const b = result[j];
        if (a.level !== b.level) continue;
        if (Math.abs(a.x - b.x) < nodeSize + 4 && Math.abs(a.y - b.y) < nodeSize + 4) {
          b.y = Math.min(height - nodeSize / 2 - 10, b.y + nodeSize * 0.55);
        }
      }
    }
    return result;
  }, [compact, height, mapWidth, modules, nodeSize, theme.danger, theme.success, theme.textDisabled, theme.warning]);

  const byId = React.useMemo(() => {
    const map = new Map<string, PlacedNode>();
    for (const node of placed) map.set(node.module.id, node);
    return map;
  }, [placed]);

  const hub = { x: mapWidth / 2, y: height / 2 };

  const edges = React.useMemo(() => {
    const list: Array<{ from: PlacedNode; to: PlacedNode; dashed: boolean }> = [];
    const nextHubPoint = (node: PlacedNode) => {
      // Линия к Hub заканчивается на границе его круга, а не в центре.
      const dx = hub.x - node.x;
      const dy = hub.y - node.y;
      const length = Math.sqrt(dx * dx + dy * dy) || 1;
      const r = compact ? 19 : 23;
      return { x: hub.x - (dx / length) * r, y: hub.y - (dy / length) * r };
    };
    const hubNode: PlacedNode = {
      module: { id: HUB_ID } as ModuleRow,
      x: hub.x,
      y: hub.y,
      level: 0,
      color: theme.accent,
      icon: 'cloud-outline',
    };

    const explicit = linkTargets ?? {};
    let usedExplicit = false;
    for (const node of placed) {
      const targets = explicit[node.module.id];
      if (!targets?.length) continue;
      for (const targetId of targets) {
        if (targetId === HUB_ID) {
          const point = nextHubPoint(node);
          list.push({
            from: node,
            to: { ...hubNode, x: point.x, y: point.y },
            dashed: !node.module.online,
          });
          usedExplicit = true;
          continue;
        }
        const target = byId.get(targetId);
        if (!target) continue;
        list.push({ from: node, to: target, dashed: !(node.module.online && target.module.online) });
        usedExplicit = true;
      }
    }
    if (usedExplicit) return list;

    // Иерархия: шлюзы — к Hub, остальные — к ближайшему старшему уровню.
    const gateways = placed.filter((node) => node.level === 0);
    const repeaters = placed.filter((node) => node.level === 1);
    const nearest = (node: PlacedNode, candidates: PlacedNode[]): PlacedNode | null => {
      let best: PlacedNode | null = null;
      let bestDistance = Infinity;
      for (const candidate of candidates) {
        const distance = (candidate.x - node.x) ** 2 + (candidate.y - node.y) ** 2;
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
      return best;
    };

    for (const gateway of gateways) {
      const point = nextHubPoint(gateway);
      list.push({
        from: gateway,
        to: { ...hubNode, x: point.x, y: point.y },
        dashed: !gateway.module.online,
      });
    }
    for (const node of placed) {
      if (node.level === 0) continue;
      const parent =
        node.level === 1
          ? nearest(node, gateways)
          : nearest(node, repeaters) ?? nearest(node, gateways);
      if (parent) {
        list.push({
          from: node,
          to: parent,
          dashed: !(node.module.online && parent.module.online),
        });
      } else {
        const point = nextHubPoint(node);
        list.push({
          from: node,
          to: { ...hubNode, x: point.x, y: point.y },
          dashed: true,
        });
      }
    }
    return list;
  }, [byId, compact, hub.x, hub.y, linkTargets, placed, theme.accent]);

  return (
    <View
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width);
        // Защита от бесконечного layout-цикла: обновляем только заметное изменение.
        if (next > 0 && Math.abs(next - widthRef.current) > 1) {
          widthRef.current = next;
          setWidth(next);
        }
      }}
      style={{
        width: '100%',
        height,
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: theme.dark ? 'rgba(255,255,255,0.015)' : 'rgba(16,24,40,0.02)',
      }}
      accessibilityLabel="Карта mesh-сети"
    >
      {edges.map((edge, index) => (
        <Link
          key={`edge-${edge.from.module.id}-${edge.to.module.id}-${index}`}
          x1={edge.from.x}
          y1={edge.from.y}
          x2={edge.to.x}
          y2={edge.to.y}
          color={edge.dashed ? theme.textDisabled : theme.accent}
          dashed={edge.dashed}
          width={edge.dashed ? 1 : 1.4}
        />
      ))}

      {/* Центральный узел Hub. */}
      <View
        style={{
          position: 'absolute',
          left: hub.x - (compact ? 19 : 23),
          top: hub.y - (compact ? 19 : 23),
          width: compact ? 38 : 46,
          height: compact ? 38 : 46,
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1.5,
          borderColor: theme.accent,
          backgroundColor: theme.accentSoft,
        }}
      >
        <Ionicons name="cloud-outline" size={compact ? 17 : 21} color={theme.accent} />
        <Text
          style={{
            position: 'absolute',
            top: (compact ? 38 : 46) + 1,
            color: theme.textSecondary,
            fontSize: 9,
            fontWeight: '700',
          }}
        >
          Hub
        </Text>
      </View>

      {placed.map((node) => {
        const selected = selectedId === node.module.id;
        const status = moduleStatusView(node.module);
        return (
          <Pressable
            key={node.module.id}
            onPress={() => onSelect(node.module)}
            accessibilityRole="button"
            accessibilityLabel={`${moduleRoleLabel(node.module.role)}${
              node.module.publicId ? `, ID ${node.module.publicId}` : ''
            }, ${status.text}`}
            style={({ pressed }) => ({
              position: 'absolute',
              left: node.x - (compact ? 17 : 21),
              top: node.y - (compact ? 17 : 21),
              width: compact ? 34 : 42,
              alignItems: 'center',
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <View
              style={{
                width: nodeSize,
                height: nodeSize,
                borderRadius: 999,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: selected ? 2.5 : 1.5,
                borderColor: selected ? theme.accent : node.color,
                backgroundColor: theme.surfaceElevated,
                ...(ios
                  ? {}
                  : Platform.OS === 'web'
                    ? ({ boxShadow: selected ? `0 0 0 3px ${theme.accentSoft}` : undefined } as object)
                    : {}),
              }}
            >
              <Ionicons name={node.icon} size={compact ? 14 : 18} color={node.color} />
              <View
                style={{
                  position: 'absolute',
                  right: -1,
                  bottom: -1,
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  backgroundColor: node.color,
                  borderWidth: 1.5,
                  borderColor: theme.surfaceElevated,
                }}
              />
            </View>
            <Text
              numberOfLines={1}
              style={{
                color: selected ? theme.accent : theme.textDisabled,
                fontSize: 8.5,
                fontWeight: selected ? '700' : '500',
                marginTop: 1,
                maxWidth: 56,
                textAlign: 'center',
                fontVariant: ['tabular-nums'] as never,
              }}
            >
              {node.module.publicId || '—'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
