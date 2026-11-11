/**
 * Реальный транспорт работы с Hub: WebSocket для конвертов +
 * периодический репорт доставки в сеть.
 */
import * as api from '../data/api';
import { wsUrl } from '../data/api';
import type { Envelope } from '../data/api';
import { useStore } from '../state/useStore';

export interface HttpTransportHandlers {
  onEnvelope: (e: Envelope) => void;
  onDelivered: (chatId: string, messageId: string) => void;
  onRead: (chatId: string, seq: number) => void;
  onChatChanged: () => void;
  onChatKey: (chatId: string) => void;
}

export class HttpTransport {
  private ws: WebSocket | null = null;
  private handlers: HttpTransportHandlers;
  private retryTimer: any = null;

  constructor(handlers: HttpTransportHandlers) {
    this.handlers = handlers;
  }

  start(initialToken: string | null): void {
    const store = useStore.getState();
    if (!initialToken) {
      store.setTransportOnline(false);
      return;
    }
    this.connect(initialToken);
  }

  private connect(token: string): void {
    try {
      const ws = new WebSocket(wsUrl(token));
      this.ws = ws;

      ws.onopen = () => {
        useStore.getState().setTransportOnline(true);
      };
      ws.onerror = () => {
        useStore.getState().setTransportOnline(false);
      };
      ws.onclose = () => {
        useStore.getState().setTransportOnline(false);
        this.ws = null;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.reconnect(), 4000);
      };
      ws.onmessage = (raw) => {
        try {
          const event = JSON.parse(String(raw.data));
          if (event.type === 'message') this.handlers.onEnvelope(event.message as Envelope);
          else if (event.type === 'message_delivered') this.handlers.onDelivered(event.chatId, event.messageId);
          else if (event.type === 'message_read') this.handlers.onRead(event.chatId, event.seq);
          else if (event.type === 'chat_added' || event.type === 'chat_key_added') this.handlers.onChatChanged();
        } catch {
          /* некорректное сообщение */
        }
      };
    } catch {
      useStore.getState().setTransportOnline(false);
    }
  }

  private reconnect(): void {
    void (async () => {
      const token = (await api.ensureAccessToken()) || api.getSession()?.accessToken;
      if (!token) return;
      this.connect(token);
    })();
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    useStore.getState().setTransportOnline(false);
  }
}
