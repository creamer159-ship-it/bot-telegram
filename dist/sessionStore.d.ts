type SessionState = {
    mode: 'edit_post';
    postId: number;
};
declare class SessionStore {
    private readonly states;
    private getKey;
    set(chatId: number, userId: number, state: SessionState): void;
    get(chatId: number, userId: number): SessionState | undefined;
    clear(chatId: number, userId: number): void;
}
declare const sessionStore: SessionStore;
export type { SessionState };
export default sessionStore;
//# sourceMappingURL=sessionStore.d.ts.map