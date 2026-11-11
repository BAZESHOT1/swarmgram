/**
 * Карта mesh-сети вокруг носимого модуля, подключённого к клиенту.
 *
 * Центр карты — всегда реальный носимый модуль, который сейчас подключён
 * напрямую (USB/BLE). Вокруг него — ретрансляторы и другие носимые, внешним
 * уровнем — шлюзы с выходом в интернет. Никаких выдуманных узлов: рисуем
 * только модули из списка и связи по ролям.
 */
import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import type { ModuleRow } from '../../data/api';
import { moduleRoleLabel, moduleStatusView } from './moduleUi';

interface Props {
  modules: ModuleRow[];
  /** Носимый модуль, подключённый к клиенту. Он в центре карты. */
  focus: ModuleRow | null;
  selectedId: string | null;
  onSelect: (module: ModuleRow) => void;
  /** Развёрнутый вид карты: больше высоты и больше узлов. */
  expanded?: boolean;
}

type NodeKind = 'focus' | 'inner' | 'gateway';

interface PlacedNode {
  module: ModuleRow;
  x: number;
  y: number;
  kind: NodeKind;
  size: number;
  color: string;
  icon: keyof typeof Ionicons.glyphMap;
  faded: boolean;
}

function roleOf(module: ModuleRow): string {
  return module.role ?? 'gateway';
}

function isGateway(module: ModuleRow): boolean {
  return roleOf(module) === 'gateway';
}

function roleIcon(module: ModuleRow): keyof typeof Ionicons.glyphMap {
  if (isGateway(module)) return module.gateway === false ? 'git-network-outline' : 'globe-outline';
  if (roleOf(module) === 'repeater') return 'radio-outline';
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

function nodeColor(
  module: ModuleRow,
  theme: ReturnType<typeof useTheme>,
): string {
  const status = moduleStatusView(module);
  if (status.tone === 'danger') return theme.danger;
  if (status.tone === 'warning') return theme.warning;
  if (isGateway(module)) return module.gateway === false ? theme.textDisabled : theme.warning;
  if (status.tone === 'success') return theme.success;
  return theme.textDisabled;
}

export function ModulesNetworkMap({ modules, focus, selectedId, onSelect, expanded = false }: Props) {
  const theme = useTheme();
  const [width, setWidth] = React.useState(0);
  const widthRef = React.useRef(0);
  const fallbackWidth =
    Platform.OS === 'web' && typeof window !== 'undefined' ? Math.min(680, window.innerWidth - 64) : 320;
  const mapWidth = width > 0 ? width : fallbackWidth;
  const compact = mapWidth < 520;
  const height = expanded ? (compact ? 300 : 340) : compact ? 190 : 200;
  const nodeSize = compact ? 32 : 38;
  const centerSize = compact ? 48 : 56;
  const ios = Platform.OS === 'ios';

  const layout = React.useMemo(() => {
    const others = modules.filter((module) => module.id !== focus?.id);
    const innerAll = others.filter((module) => !isGateway(module));
    const gatewayAll = others.filter(isGateway);
    const innerLimit = expanded ? 10 : 6;
    const gatewayLimit = expanded ? 8 : 4;
    const inner = innerAll.slice(0, innerLimit);
    const gateways = gatewayAll.slice(0, gatewayLimit);

    const cx = mapWidth / 2;
    const cy = height / 2;
    const maxRx = Math.max(56, mapWidth / 2 - nodeSize / 2 - 10);
    const minY = nodeSize / 2 + 6;
    const maxY = height - nodeSize / 2 - 26;

    const place = (
      group: ModuleRow[],
      kind: NodeKind,
      rx: number,
      ry: number,
      startAngle: number,
      size: number,
    ): PlacedNode[] =>
      group.map((module, index) => {
        const angle = group.length === 1 ? -Math.PI / 2 : startAngle + ((Math.PI * 2) / group.length) * index;
        const rawX = cx + rx * Math.cos(angle);
        const rawY = cy + ry * Math.sin(angle);
        const x = Math.max(nodeSize / 2 + 2, Math.min(mapWidth - nodeSize / 2 - 2, rawX));
        const y = Math.max(minY, Math.min(maxY, rawY));
        return {
          module,
          x,
          y,
          kind,
          size,
          color: nodeColor(module, theme),
          icon: roleIcon(module),
          // Носимые без прямого подключения к клиенту и всё офлайн — бледнее.
          faded:
            kind === 'gateway'
              ? module.online !== true || module.blocked === true || module.gateway === false
              : roleOf(module) === 'wearable' || module.online !== true || module.blocked === true,
        };
      });

    const innerNodes = place(
      inner,
      'inner',
      Math.min(maxRx * (expanded ? 0.72 : 0.6), 170),
      height * (expanded ? 0.3 : 0.24),
      -Math.PI / 2 + 0.35,
      nodeSize,
    );
    const gatewayNodes = place(
      gateways,
      'gateway',
      Math.min(maxRx * 0.98, 260),
      height * (expanded ? 0.44 : 0.4),
      -Math.PI / 2 + 0.15,
      nodeSize + (compact ? 2 : 4),
    );

    return {
      center: { x: cx, y: cy + (expanded ? 0 : 2) },
      innerNodes,
      gatewayNodes,
      hidden: innerAll.length - inner.length + (gatewayAll.length - gateways.length),
    };
  }, [compact, expanded, focus?.id, height, mapWidth, modules, nodeSize, theme]);

  const { center, innerNodes, gatewayNodes, hidden } = layout;

  const edges = React.useMemo(() => {
    const list: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; dashed: boolean; tone: 'accent' | 'success' }> = [];
    const nearestGateway = (node: PlacedNode): PlacedNode | null => {
      let best: PlacedNode | null = null;
      let bestDistance = Infinity;
      for (const gateway of gatewayNodes) {
        const distance = (gateway.x - node.x) ** 2 + (gateway.y - node.y) ** 2;
        if (distance < bestDistance) {
          best = gateway;
          bestDistance = distance;
        }
      }
      return best;
    };

    for (const node of innerNodes) {
      list.push({
        from: node,
        to: center,
        dashed: node.module.online !== true,
        tone: 'accent',
      });
      const gateway = nearestGateway(node);
      if (gateway) {
        list.push({
          from: node,
          to: gateway,
          dashed: !(node.module.online && gateway.module.online),
          tone: 'success',
        });
      }
    }

    // Без ретрансляторов шлюзы подключаем прямо к носимому модулю.
    if (innerNodes.length === 0) {
      for (const gateway of gatewayNodes) {
        list.push({
          from: gateway,
          to: center,
          dashed: gateway.module.online !== true,
          tone: 'accent',
        });
      }
    }
    return list;
  }, [center, gatewayNodes, innerNodes]);

  if (!focus) {
    return (
      <View
        style={{
          width: '100%',
          height,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.dark ? 'rgba(255,255,255,0.015)' : 'rgba(16,24,40,0.02)',
        }}
      >
        <Text style={{ color: theme.textDisabled, fontSize: 12 }}>Нет подключённого носимого модуля</Text>
      </View>
    );
  }

  const centerColor = theme.accent;

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
      accessibilityLabel="Карта mesh-сети от подключённого носимого модуля"
    >
      {edges.map((edge, index) => (
        <Link
          key={`edge-${index}`}
          x1={edge.from.x}
          y1={edge.from.y}
          x2={edge.to.x}
          y2={edge.to.y}
          color={edge.dashed ? theme.textDisabled : edge.tone === 'success' ? theme.success : theme.accent}
          dashed={edge.dashed}
          width={edge.dashed ? 1 : 1.4}
        />
      ))}

      {/* Центр — носимый модуль, который подключён к этому клиенту. */}
      <Pressable
        onPress={() => onSelect(focus)}
        accessibilityRole="button"
        accessibilityLabel={`${moduleRoleLabel(focus.role)}${
          focus.publicId ? `, ID ${focus.publicId}` : ''
        }, подключён к клиенту`}
        style={({ pressed }) => ({
          position: 'absolute',
          left: center.x - centerSize / 2 - 10,
          top: center.y - centerSize / 2,
          width: centerSize + 20,
          alignItems: 'center',
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <View
          style={{
            width: centerSize,
            height: centerSize,
            borderRadius: 999,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 2.5,
            borderColor: centerColor,
            backgroundColor: theme.accentSoft,
            ...(ios
              ? {}
              : Platform.OS === 'web'
                ? ({ boxShadow: `0 0 0 4px ${theme.accentSoft}` } as object)
                : {}),
          }}
        >
          <Ionicons name="watch-outline" size={compact ? 20 : 24} color={centerColor} />
          <View
            style={{
              position: 'absolute',
              right: 1,
              bottom: 1,
              width: 11,
              height: 11,
              borderRadius: 999,
              backgroundColor: theme.success,
              borderWidth: 2,
              borderColor: theme.surfaceElevated,
            }}
          />
        </View>
        <Text
          numberOfLines={1}
          style={{
            color: theme.textPrimary,
            fontSize: 9.5,
            fontWeight: '800',
            marginTop: 2,
            maxWidth: 78,
            textAlign: 'center',
            fontVariant: ['tabular-nums'] as never,
          }}
        >
          {focus.publicId || moduleRoleLabel(focus.role)}
        </Text>
        <Text style={{ color: theme.accent, fontSize: 8, fontWeight: '800', marginTop: 1 }}>КЛИЕНТ</Text>
      </Pressable>

      {[...innerNodes, ...gatewayNodes].map((node) => {
        const selected = selectedId === node.module.id;
        const status = moduleStatusView(node.module);
        const gatewayWithInternet = node.kind === 'gateway' && node.module.gateway !== false;
        const neighbors = Math.max(0, Number(node.module.neighbors ?? 0));
        const caption = node.kind === 'gateway' ? (gatewayWithInternet ? 'Интернет' : 'без выхода') : `${neighbors} соседей`;
        const iconSize = compact ? 14 : node.kind === 'gateway' ? 19 : 17;
        return (
          <Pressable
            key={node.module.id}
            onPress={() => onSelect(node.module)}
            accessibilityRole="button"
            accessibilityLabel={`${moduleRoleLabel(node.module.role)}${
              node.module.publicId ? `, ID ${node.module.publicId}` : ''
            }, ${status.text}${neighbors ? `, ${neighbors} соседей` : ''}`}
            style={({ pressed }) => ({
              position: 'absolute',
              left: node.x - 32,
              top: node.y - node.size / 2,
              width: 64,
              alignItems: 'center',
              opacity: pressed ? 0.7 : node.faded ? 0.55 : 1,
            })}
          >
            <View
              style={{
                width: node.size,
                height: node.size,
                borderRadius: 999,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: selected ? 2.5 : 1.5,
                borderColor: selected ? theme.accent : node.color,
                backgroundColor: gatewayWithInternet ? theme.warningSoft : theme.surfaceElevated,
                ...(ios
                  ? {}
                  : Platform.OS === 'web' && selected
                    ? ({ boxShadow: `0 0 0 3px ${theme.accentSoft}` } as object)
                    : {}),
              }}
            >
              <Ionicons name={node.icon} size={iconSize} color={node.color} />
              <View
                style={{
                  position: 'absolute',
                  right: -1,
                  bottom: -1,
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  backgroundColor: node.module.online ? theme.success : node.color,
                  borderWidth: 1.5,
                  borderColor: theme.surfaceElevated,
                }}
              />
            </View>
            <Text
              numberOfLines={1}
              style={{
                color: selected ? theme.accent : theme.textPrimary,
                fontSize: 8.5,
                fontWeight: selected ? '800' : '600',
                marginTop: 1,
                maxWidth: 64,
                textAlign: 'center',
                fontVariant: ['tabular-nums'] as never,
              }}
            >
              {node.module.publicId || '—'}
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 2,
                maxWidth: 64,
              }}
            >
              {gatewayWithInternet ? (
                <Ionicons name="globe-outline" size={7} color={theme.warning} />
              ) : null}
              <Text
                numberOfLines={1}
                style={{
                  color: gatewayWithInternet ? theme.warning : theme.textDisabled,
                  fontSize: 7.5,
                  fontWeight: '600',
                  textAlign: 'center',
                }}
              >
                {caption}
              </Text>
            </View>
          </Pressable>
        );
      })}

      {hidden > 0 ? (
        <View
          style={{
            position: 'absolute',
            right: 8,
            bottom: 6,
            paddingHorizontal: 7,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: theme.surfacePressed,
          }}
        >
          <Text style={{ color: theme.textSecondary, fontSize: 9, fontWeight: '700' }}>+{hidden} узлов</Text>
        </View>
      ) : null}
    </View>
  );
}
