import type { Message } from 'telegraf/typings/core/types/typegram';

export type StoredMessageSource = string;

export interface StoredMessage {
  messageId: number;
  chatId: number;
  text: string;
  source: StoredMessageSource;
  sentAt: Date;
  deleted: boolean;
}

class MessageStore {
  private readonly store = new Map<number, Map<number, StoredMessage>>();

  add(message: Omit<StoredMessage, 'deleted'> & { deleted?: boolean }): StoredMessage {
    const chatMessages = this.store.get(message.chatId) ?? new Map<number, StoredMessage>();
    const record: StoredMessage = {
      ...message,
      deleted: message.deleted ?? false,
    };
    chatMessages.set(message.messageId, record);
    this.store.set(message.chatId, chatMessages);
    console.log(
      `[message-store] Zapisano wiadomość ${record.messageId} w czacie ${record.chatId} (źródło: ${record.source})`,
    );
    return record;
  }

  get(chatId: number, messageId: number): StoredMessage | undefined {
    return this.store.get(chatId)?.get(messageId);
  }

  updateText(chatId: number, messageId: number, text: string): boolean {
    const message = this.get(chatId, messageId);
    if (!message) {
      return false;
    }
    message.text = text;
    return true;
  }

  markDeleted(chatId: number, messageId: number): boolean {
    const message = this.get(chatId, messageId);
    if (!message) {
      return false;
    }
    message.deleted = true;
    return true;
  }

  getMessagesForChat(chatId: number, limit = 10): StoredMessage[] {
    const chatMessages = this.store.get(chatId);
    if (!chatMessages) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.floor(limit));
    return Array.from(chatMessages.values())
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
      .slice(0, normalizedLimit);
  }

  getAllMessagesForChat(chatId: number): StoredMessage[] {
    const chatMessages = this.store.get(chatId);
    if (!chatMessages) {
      return [];
    }
    return Array.from(chatMessages.values()).sort(
      (a, b) => b.sentAt.getTime() - a.sentAt.getTime(),
    );
  }

  recordTelegramMessage(
    message:
      | Message.TextMessage
      | Message.PhotoMessage
      | Message.VideoMessage
      | Message.AnimationMessage
      | Message.DocumentMessage,
    source: StoredMessageSource,
  ): void {
    const sentAtSeconds = message.date ?? Math.floor(Date.now() / 1000);
    const textContent =
      'text' in message && typeof message.text === 'string'
        ? message.text
        : 'caption' in message && typeof message.caption === 'string'
          ? message.caption
          : '';
    this.add({
      messageId: message.message_id,
      chatId: message.chat.id,
      text: textContent,
      source,
      sentAt: new Date(sentAtSeconds * 1000),
    });
  }
}

const messageStore = new MessageStore();
export default messageStore;
