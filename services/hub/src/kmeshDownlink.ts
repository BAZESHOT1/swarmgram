/**
 * Доставка обычных (HTTP/realtime) сообщений в KMesh-узлы получателей.
 *
 * Когда получатель офлайн в приложении, но его модуль слышен через шлюз,
 * Hub кладёт в downlink готовый E2EE-конверт. Модуль и приложение получают
 * то же сообщение, что и через WebSocket, — без дублирования в истории.
 */
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { one, query } from './db.js';
import { buildPacket, encodeEnvelopeRpc, FLAG_FROM_INTERNET, sealTemp } from './kmeshRpc.js';

interface Target {
  nodeId: number;
  gatewayId: number;
}

/** Живой узел пользователя (свежий presence), иначе последняя привязка. */
async function targetForUser(userId: string): Promise<Target | null> {
  const presence = await one<{ node_id: string; gateway_id: string }>(
    `SELECT node_id::text, gateway_id::text FROM kmesh_v1_presence
      WHERE user_id = $1 AND expires_at > now()
      ORDER BY last_seen_at DESC LIMIT 1`,
    [userId],
  );
  if (presence) {
    return { nodeId: Number(presence.node_id), gatewayId: Number(presence.gateway_id) || 0 };
  }
  const bound = await one<{ node_id: string }>(
    `SELECT node_id::text FROM kmesh_v1_node_bindings
      WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [userId],
  );
  return bound ? { nodeId: Number(bound.node_id), gatewayId: 0 } : null;
}

export interface EnvelopeDownlinkInput {
  chatId: string;
  chatRef: number;
  kind: string;
  nonceB64: string;
  ciphertextB64: string;
  /** Сообщение в БД: получаем/запоминаем msg_uuid для квитанций. */
  messageId?: string;
  /** Время отправки (ISO) для сохранения исходного created_at. */
  createdAt?: string;
  /** Кому не отправлять (автор сообщения). */
  excludeUserId: string;
  srcNodeId: number;
}

/**
 * Разложить E2EE-конверт по downlink-очередям всех получателей чата.
 * Возвращает число поставленных пакетов.
 */
export async function queueEnvelopeDownlink(input: EnvelopeDownlinkInput): Promise<number> {
  if (!config.tempMeshKey) return 0;
  const ciphertext = Buffer.from(input.ciphertextB64, 'base64');
  const nonce = Buffer.from(input.nonceB64, 'base64');
  if (!ciphertext.length || nonce.length < 8 || nonce.length > 24) return 0;
  const members = await query<{ user_id: string }>(
    'SELECT user_id::text FROM chat_members WHERE chat_id = $1',
    [input.chatId],
  );
  let queued = 0;
  const msgUuid = randomBytes(8).readBigUInt64LE(0) || 1n;
  if (input.messageId) {
    // Один и тот же uuid у всех получателей: квитанции доставки/прочтения
    // находят исходное HTTP-сообщение на Hub.
    await query(
      'UPDATE messages SET msg_uuid = COALESCE(msg_uuid, $2) WHERE id = $1',
      [input.messageId, msgUuid.toString(16).padStart(16, '0')],
    ).catch(() => undefined);
  }
  for (const member of members) {
    if (member.user_id === input.excludeUserId) continue;
    const target = await targetForUser(member.user_id);
    if (!target || target.nodeId === input.srcNodeId) continue;
    const rpc = encodeEnvelopeRpc({
      chatRef: input.chatRef,
      chatId: input.chatId,
      kind: input.kind,
      nonce,
      ciphertext,
      ...(input.createdAt
        ? { timestamp: Math.floor(new Date(input.createdAt).getTime() / 1000) }
        : {}),
    });
    // Пакет целиком должен влезть в один кадр KMesh (payload <= 255).
    if (rpc.length + 6 > 255) continue;
    const packetId = randomBytes(4).readUInt32LE(0) || 1;
    const sealed = sealTemp(
      config.tempMeshKey,
      {
        packetId,
        msgUuid,
        srcId: input.srcNodeId || target.nodeId,
        dstId: target.nodeId,
        type: 1,
      },
      rpc,
      FLAG_FROM_INTERNET,
    );
    if (!sealed) continue;
    const wire = buildPacket({
      packetId,
      msgUuid,
      srcId: input.srcNodeId || target.nodeId,
      dstId: target.nodeId,
      nextHopId: target.nodeId,
      type: 1,
      flags: sealed.flags,
      payload: sealed.payload,
    });
    await query(
      `INSERT INTO kmesh_v1_downlink
         (gateway_id, dst_node_id, kind, packet_id, msg_uuid, packet_b64, expires_at)
       VALUES ($1,$2,'packet',$3,$4,$5, now() + interval '24 hours')`,
      [
        target.gatewayId,
        target.nodeId,
        packetId,
        BigInt.asUintN(64, msgUuid).toString(16).padStart(16, '0'),
        wire.toString('base64'),
      ],
    );
    queued += 1;
  }
  return queued;
}
