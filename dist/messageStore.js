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
        const { contentType, fileId } = determineContent(message);
        const textContent = 'text' in message && typeof message.text === 'string'
            ? message.text
            : 'caption' in message && typeof message.caption === 'string'
                ? message.caption
                : '';
        const payload = {
            messageId: message.message_id,
            chatId: message.chat.id,
            text: textContent,
            source,
            sentAt: new Date(sentAtSeconds * 1000),
            contentType,
        };
        if (fileId) {
            payload.fileId = fileId;
        }
        this.add(payload);
    }
    updateContent(chatId, messageId, updates) {
        const message = this.get(chatId, messageId);
        if (!message) {
            return false;
        }
        if (updates.text !== undefined) {
            message.text = updates.text;
        }
        if (updates.contentType !== undefined) {
            message.contentType = updates.contentType;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'fileId')) {
            if (updates.fileId === undefined) {
                delete message.fileId;
            }
            else {
                message.fileId = updates.fileId;
            }
        }
        return true;
    }
}
const determineContent = (message) => {
    if ('text' in message && typeof message.text === 'string') {
        return { contentType: 'text' };
    }
    const photos = 'photo' in message ? message.photo : undefined;
    if (photos && photos.length > 0) {
        const lastPhoto = photos[photos.length - 1];
        if (lastPhoto?.file_id) {
            return { contentType: 'photo', fileId: lastPhoto.file_id };
        }
    }
    if ('video' in message) {
        const video = message.video;
        if (video && video.file_id) {
            return { contentType: 'video', fileId: video.file_id };
        }
    }
    if ('animation' in message) {
        const animation = message.animation;
        if (animation && animation.file_id) {
            return { contentType: 'animation', fileId: animation.file_id };
        }
    }
    if ('document' in message) {
        const document = message.document;
        if (document && document.file_id) {
            return { contentType: 'document', fileId: document.file_id };
        }
    }
    return { contentType: 'other' };
};
const messageStore = new MessageStore();
export default messageStore;
//# sourceMappingURL=messageStore.js.map