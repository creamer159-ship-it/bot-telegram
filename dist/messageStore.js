class MessageStore {
    store = new Map();
    add(message) {
        const chatMessages = this.store.get(message.chatId) ?? new Map();
        const record = {
            ...message,
            deleted: message.deleted ?? false,
        };
        chatMessages.set(message.messageId, record);
        this.store.set(message.chatId, chatMessages);
        console.log(`[message-store] Zapisano wiadomość ${record.messageId} w czacie ${record.chatId} (źródło: ${record.source})`);
        return record;
    }
    get(chatId, messageId) {
        return this.store.get(chatId)?.get(messageId);
    }
    updateText(chatId, messageId, text) {
        const message = this.get(chatId, messageId);
        if (!message) {
            return false;
        }
        message.text = text;
        return true;
    }
    markDeleted(chatId, messageId) {
        const message = this.get(chatId, messageId);
        if (!message) {
            return false;
        }
        message.deleted = true;
        return true;
    }
    getMessagesForChat(chatId, limit = 10) {
        const chatMessages = this.store.get(chatId);
        if (!chatMessages) {
            return [];
        }
        const normalizedLimit = Math.max(1, Math.floor(limit));
        return Array.from(chatMessages.values())
            .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
            .slice(0, normalizedLimit);
    }
    getAllMessagesForChat(chatId) {
        const chatMessages = this.store.get(chatId);
        if (!chatMessages) {
            return [];
        }
        return Array.from(chatMessages.values()).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
    }
    recordTelegramMessage(message, source) {
        const sentAtSeconds = message.date ?? Math.floor(Date.now() / 1000);
        const textContent = 'text' in message && typeof message.text === 'string'
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
//# sourceMappingURL=messageStore.js.map