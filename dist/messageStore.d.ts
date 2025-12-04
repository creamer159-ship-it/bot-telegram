import type { Message } from 'telegraf/typings/core/types/typegram';
export type StoredMessageSource = string;
export type StoredMessageContentType = 'text' | 'photo' | 'video' | 'animation' | 'document' | 'other';
export interface StoredMessage {
    messageId: number;
    chatId: number;
    text: string;
    source: StoredMessageSource;
    sentAt: Date;
    deleted: boolean;
    contentType: StoredMessageContentType;
    fileId?: string;
}
declare class MessageStore {
    private readonly store;
    add(message: Omit<StoredMessage, 'deleted'> & {
        deleted?: boolean;
    }): StoredMessage;
    get(chatId: number, messageId: number): StoredMessage | undefined;
    updateText(chatId: number, messageId: number, text: string): boolean;
    markDeleted(chatId: number, messageId: number): boolean;
    getMessagesForChat(chatId: number, limit?: number): StoredMessage[];
    getAllMessagesForChat(chatId: number): StoredMessage[];
    recordTelegramMessage(message: Message.TextMessage | Message.PhotoMessage | Message.VideoMessage | Message.AnimationMessage | Message.DocumentMessage, source: StoredMessageSource): void;
    updateContent(chatId: number, messageId: number, updates: {
        text?: string;
        contentType?: StoredMessageContentType;
        fileId?: string | undefined;
    }): boolean;
}
declare const messageStore: MessageStore;
export default messageStore;
//# sourceMappingURL=messageStore.d.ts.map