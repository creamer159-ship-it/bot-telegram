type EditSessionTarget = {
    type: 'message';
    messageId: number;
} | {
    type: 'job';
    jobId: number;
};
interface EditSession {
    chatId: number;
    userId: number;
    target: EditSessionTarget;
    startedAt: Date;
}
declare class EditSessionStore {
    private readonly sessions;
    private getKey;
    startMessageSession(chatId: number, userId: number, messageId: number): EditSession;
    startJobSession(chatId: number, userId: number, jobId: number): EditSession;
    get(chatId: number, userId: number): EditSession | undefined;
    clear(chatId: number, userId: number): void;
}
declare const editSessionStore: EditSessionStore;
export default editSessionStore;
//# sourceMappingURL=editSessionStore.d.ts.map