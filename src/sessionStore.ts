type SessionState = { mode: 'edit_post'; postId: number };

class SessionStore {
  private readonly states = new Map<string, SessionState>();

  private getKey(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }

  set(chatId: number, userId: number, state: SessionState): void {
    this.states.set(this.getKey(chatId, userId), state);
  }

  get(chatId: number, userId: number): SessionState | undefined {
    return this.states.get(this.getKey(chatId, userId));
  }

  clear(chatId: number, userId: number): void {
    this.states.delete(this.getKey(chatId, userId));
  }
}

const sessionStore = new SessionStore();
export type { SessionState };
export default sessionStore;
