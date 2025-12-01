type EditSessionTarget =
  | { type: 'message'; messageId: number }
  | { type: 'job'; jobId: number };

interface EditSession {
  chatId: number;
  userId: number;
  target: EditSessionTarget;
  startedAt: Date;
}

class EditSessionStore {
  private readonly sessions = new Map<string, EditSession>();

  private getKey(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }

  startMessageSession(chatId: number, userId: number, messageId: number): EditSession {
    const session: EditSession = {
      chatId,
      userId,
      target: { type: 'message', messageId },
      startedAt: new Date(),
    };
    this.sessions.set(this.getKey(chatId, userId), session);
    return session;
  }

  startJobSession(chatId: number, userId: number, jobId: number): EditSession {
    const session: EditSession = {
      chatId,
      userId,
      target: { type: 'job', jobId },
      startedAt: new Date(),
    };
    this.sessions.set(this.getKey(chatId, userId), session);
    return session;
  }

  get(chatId: number, userId: number): EditSession | undefined {
    return this.sessions.get(this.getKey(chatId, userId));
  }

  clear(chatId: number, userId: number): void {
    this.sessions.delete(this.getKey(chatId, userId));
  }
}

const editSessionStore = new EditSessionStore();
export default editSessionStore;
