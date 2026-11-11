/**
 * Shared types for the native push layer.
 *
 * Kept free of react-native / Firebase imports so both the native
 * implementation and any caller can use them without pulling native modules.
 */

/** Minimal session shape required to bind a push token to a device. */
export interface PushSession {
  deviceId: string;
  userId?: string;
  accessToken?: string;
}

/** Cleanup callback returned by listeners / registration helpers. */
export type PushCleanup = () => void;

/** Normalized notification data (values are always strings for notifee). */
export type PushData = Record<string, string>;

export type PushPlatform = 'ios' | 'android';

/** Options for showing a local notification through notifee. */
export interface PushDisplayOptions {
  title?: string;
  body?: string;
  data?: PushData;
  /** Explicit notifee notification id (useful for idempotent pending replays). */
  id?: string;
  /** Android channel id. Defaults to the messages channel. */
  channelId?: string;
}
