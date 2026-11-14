/**
 * Auth-поток: вход, регистрация, восстановление устройства, резерв ключей.
 * Пароль и приватные ключи на сервер не уходят (сервер хранит только
 * шифрованный blob с AES-GCM от PBKDF2-ключа).
 */
import { Platform } from 'react-native';
import * as api from './api';
import {
  generateDeviceKeys,
  generateAccountKey,
  generateOneTimePrekeys,
  publicJwkOf,
  sha256Of,
  storage,
  decryptBackupBlob,
  encryptBackupBlob,
  type DeviceKeys,
} from '../crypto/core';
import { useStore } from '../state/useStore';
import { refreshCachedIdentity } from '../kmesh/v1/identity';

export interface AuthResult {
  session: api.Session;
  user: api.User;
  keys: DeviceKeys;
  needEmailVerify: boolean;
}

function devicePayloadFor(keys: DeviceKeys, prekeys: string[] = []) {
  return {
    deviceId: keys.deviceId,
    deviceName: Platform.OS === 'web' ? 'web browser' : `${Platform.OS} app`,
    platform: Platform.OS,
    identityPub: JSON.stringify(publicJwkOf(keys.identityPriv)),
    ecdhPub: JSON.stringify(publicJwkOf(keys.ecdhPriv)),
    signedPrekey: JSON.stringify(publicJwkOf(keys.signedPrekeyPriv)),
    prekeySig: keys.prekeySig,
    prekeys,
  };
}

async function freshDeviceKeys(): Promise<DeviceKeys> {
  const { stored } = await generateDeviceKeys();
  await storage.saveKeys(stored);
  return stored;
}

function applyMe(user: api.User): void {
  useStore.getState().setMe(user);
}

/**
 * Ключ аккаунта: гарантирует, что публичная часть опубликована, а приватная
 * хранится локально (и попадает в шифрованный резерв). Для старых аккаунтов
 * без accountPub генерируется новая пара; для существующей пары ключ не меняется.
 */
async function ensureAccountKey(): Promise<string | null> {
  try {
    const me = await api.api.me().catch(() => null);
    let priv = await storage.loadAccountPriv();
    if (!priv) {
      // если аккаунт уже опубликовал ключ, а приватника нет — не подменяем его
      if (me?.accountPub) return null;
      priv = generateAccountKey().accountPriv;
      await storage.saveAccountPriv(priv);
    }
    const pub = JSON.stringify(publicJwkOf(priv));
    if (!me || me.accountPub !== pub) {
      await api.api.putAccountKey(pub).catch(() => undefined);
    }
    return priv;
  } catch {
    return null;
  }
}

/** Выгрузка шифрованного резерва ключей на Hub. */
export async function tryUploadBackup(password: string): Promise<boolean> {
  try {
    const me = await api.api.me();
    if (!me.kdfSalt) return false;
    const keys = await storage.loadKeys();
    if (!keys) return false;
    const localChatKeys = await storage.loadChatKeys();
    let accountPriv = (await storage.loadAccountPriv()) ?? undefined;

    // мердж: локальные ключи + ключи из существующего резерва,
    // чтобы не затереть ключи чатов, полученные на других устройствах
    let mergedChatKeys = localChatKeys;
    try {
      const existing = await api.api.getBackup();
      if (existing.blob) {
        const payload = decryptBackupBlob(password, me.kdfSalt, existing.blob);
        mergedChatKeys = { ...(payload.chatKeys ?? {}), ...localChatKeys };
        const current = await storage.loadChatKeys();
        const missing: Record<string, string> = {};
        for (const [chatId, raw] of Object.entries(mergedChatKeys)) {
          if (!current[chatId]) missing[chatId] = raw;
        }
        if (Object.keys(missing).length) await storage.saveChatKeys({ ...current, ...missing });
        // ключ аккаунта восстанавливаем из резерва, если локально его нет
        if (!accountPriv && payload.accountPriv) {
          accountPriv = payload.accountPriv;
          await storage.saveAccountPriv(accountPriv);
        }
      }
    } catch { /* резервной копии ещё нет — загружаем пустой набор */ }

    const blob = encryptBackupBlob(password, me.kdfSalt, {
      chatKeys: mergedChatKeys,
      deviceKeys: keys,
      accountPriv,
      createdAt: new Date().toISOString(),
    });
    await api.api.putBackup(blob);
    return true;
  } catch {
    return false;
  }
}

export async function login(login: string, password: string): Promise<AuthResult> {
  const localKeys = await storage.loadKeys();
  let keys: DeviceKeys;
  if (localKeys) {
    keys = localKeys;
  } else {
    keys = await freshDeviceKeys();
  }

  const res = await api.api.login({ login, password, device: devicePayloadFor(keys) });
  const session: api.Session = {
    userId: res.user.id,
    username: res.user.username,
    deviceId: res.deviceId,
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    accessExp: Date.now() + res.expiresIn * 1000,
    meshRelayKey: (res as { meshRelayKey?: string }).meshRelayKey,
  };
  await api.setSession(session);
  useStore.getState().setSession(session);
  applyMe(res.user);
  void refreshCachedIdentity();

  if (!localKeys) {
    // новое устройство: восстановить ключи чатов и ключ аккаунта из резерва
    const refreshed = await api.api.me().catch(() => res.user);
    try {
      if (refreshed.kdfSalt) {
        const backup = await api.api.getBackup();
        if (backup.blob) {
          const payload = decryptBackupBlob(password, refreshed.kdfSalt, backup.blob);
          const restored = payload.chatKeys ?? {};
          if (Object.keys(restored).length) {
            const current = await storage.loadChatKeys();
            await storage.saveChatKeys({ ...restored, ...current });
          }
          if (payload.accountPriv) await storage.saveAccountPriv(payload.accountPriv);
        }
      }
    } catch {
      /* неверный пароль/битый blob — пропускаем, ключи для новых чатов появятся */
    }
  }

  // публикуем ключ аккаунта и догружаем резерв в фоне — не задерживаем переход
  void ensureAccountKey();
  keyBackupPasswordStash.value = password;
  // PBKDF2 (210k итераций) синхронный: запускаем после анимации перехода,
  // чтобы вход не подвисал на первом экране.
  setTimeout(() => void tryUploadBackup(password), 2500);
  return { session, user: res.user, keys, needEmailVerify: !res.user.emailVerified };
}

export async function register(input: {
  email: string;
  username: string;
  password: string;
  displayName?: string;
}): Promise<AuthResult> {
  const generated = await generateDeviceKeys();
  await storage.saveKeys(generated.stored);
  const res = await api.api.register({
    email: input.email,
    username: input.username,
    password: input.password,
    displayName: input.displayName,
    device: devicePayloadFor(generated.stored, generated.publicBundle.prekeys),
  });
  const session: api.Session = {
    userId: res.user.id,
    username: res.user.username,
    deviceId: res.deviceId,
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    accessExp: Date.now() + res.expiresIn * 1000,
    meshRelayKey: (res as { meshRelayKey?: string }).meshRelayKey,
  };
  await api.setSession(session);
  applyMe(res.user);
  void refreshCachedIdentity();
  void ensureAccountKey();
  keyBackupPasswordStash.value = input.password;
  setTimeout(() => void tryUploadBackup(input.password), 2500);
  return { session, user: res.user, keys: generated.stored, needEmailVerify: !res.user.emailVerified };
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await api.api.changePassword(oldPassword, newPassword);
}

export async function verifyEmail(email: string, code: string): Promise<void> {
  await api.api.verifyEmail(email, code);
}

const keyBackupPasswordStash: { value: string | null } = { value: null };

/** Мгновенная синхронизация резерва ключей (если пароль ещё в памяти сессии). */
export async function refreshKeyBackup(): Promise<boolean> {
  if (!keyBackupPasswordStash.value) return false;
  return tryUploadBackup(keyBackupPasswordStash.value);
}

export async function logout(): Promise<void> {
  const s = api.getSession();
  if (s) await api.api.logout(s.refreshToken).catch(() => undefined);
  await api.setSession(null);
  useStore.getState().setSession(null);
  keyBackupPasswordStash.value = null;
}

export function fingerprintOf(deviceId: string): string {
  return sha256Of(new TextEncoder().encode(deviceId)).slice(0, 8);
}
