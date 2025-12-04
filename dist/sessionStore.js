class SessionStore {
    states = new Map();
    getKey(chatId, userId) {
        return `${chatId}:${userId}`;
    }
    set(chatId, userId, state) {
        this.states.set(this.getKey(chatId, userId), state);
    }
    get(chatId, userId) {
        return this.states.get(this.getKey(chatId, userId));
    }
    clear(chatId, userId) {
        this.states.delete(this.getKey(chatId, userId));
    }
}
const sessionStore = new SessionStore();
export default sessionStore;
//# sourceMappingURL=sessionStore.js.map