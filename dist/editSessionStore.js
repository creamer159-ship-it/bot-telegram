class EditSessionStore {
    sessions = new Map();
    getKey(chatId, userId) {
        return `${chatId}:${userId}`;
    }
    startMessageSession(chatId, userId, messageId) {
        const session = {
            chatId,
            userId,
            target: { type: 'message', messageId },
            startedAt: new Date(),
        };
        this.sessions.set(this.getKey(chatId, userId), session);
        return session;
    }
    startJobSession(chatId, userId, jobId) {
        const session = {
            chatId,
            userId,
            target: { type: 'job', jobId },
            startedAt: new Date(),
        };
        this.sessions.set(this.getKey(chatId, userId), session);
        return session;
    }
    get(chatId, userId) {
        return this.sessions.get(this.getKey(chatId, userId));
    }
    clear(chatId, userId) {
        this.sessions.delete(this.getKey(chatId, userId));
    }
}
const editSessionStore = new EditSessionStore();
export default editSessionStore;
//# sourceMappingURL=editSessionStore.js.map