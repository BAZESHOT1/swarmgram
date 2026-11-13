/**
 * Сервис KMesh_v1 для приложения.
 *
 * Один экземпляр на сессию. UI вызывает:
 *   await connectKMeshV1()    — открыть BLE GATT;
 *   await sendMeshText(...)   — сохранить локально и передать;
 *   await syncKMeshV1()       — выгрузить очередь при восстановлении сети.
 */
import { KMeshV1Client, type KMeshV1ClientOptions } from './client';
import { BleKMeshV1Link } from '../../modules/bleKMeshV1';

let link: BleKMeshV1Link | null = null;
let client: KMeshV1Client | null = null;
let connecting: Promise<KMeshV1Client> | null = null;

export function kmeshV1Client(): KMeshV1Client | null {
  return client;
}

export function kmeshV1Supported(): boolean {
  return BleKMeshV1Link.supported();
}

export async function connectKMeshV1(
  callbacks: Pick<KMeshV1ClientOptions, 'onMessage' | 'onStatus' | 'onInfo' | 'resolveChatByRef'> = {},
): Promise<KMeshV1Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    link = new BleKMeshV1Link();
    await link.connect();
    const instance = new KMeshV1Client({
      link: {
        send: (frame) => link!.send(frame),
      },
      ...callbacks,
    });
    link.onData((chunk) => instance.handleData(chunk));
    client = instance;
    await instance.hello();
    return instance;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

export async function disconnectKMeshV1(): Promise<void> {
  await link?.disconnect();
  link = null;
  client = null;
}

export async function sendMeshText(input: {
  chatId: string;
  chatRef: number;
  peerNodeId: number;
  text: string;
  toInternet?: boolean;
  group?: boolean;
}): Promise<{ msgUuid: string; state: string }> {
  if (!client) await connectKMeshV1();
  return client!.sendText(input);
}

export async function syncKMeshV1(): Promise<{ synced: number; remaining: number }> {
  if (!client) return { synced: 0, remaining: 0 };
  return client.syncOutbox();
}
