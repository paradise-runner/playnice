import { Session } from "./session.js";
import type { OpenOptions, SessionSummary } from "./types.js";

export class SessionError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "exists" | "bad_request" | "exited" = "bad_request",
  ) {
    super(message);
    this.name = "SessionError";
  }
}

/**
 * The set of live terminals owned by a process (the daemon, in practice).
 * Sessions outlive the client that created them — that persistence is the whole
 * point: an agent runs a TUI once and pokes at it across many tool calls.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private counter = 0;

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((s) => s.summary())
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      const known = [...this.sessions.keys()];
      throw new SessionError(
        known.length
          ? `No session "${id}". Open sessions: ${known.join(", ")}`
          : `No session "${id}" — nothing is open yet. Use \`playnice open\` first.`,
        "not_found",
      );
    }
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  async open(options: OpenOptions & { id?: string }): Promise<Session> {
    const id = this.resolveId(options);
    if (this.sessions.has(id)) {
      throw new SessionError(`Session "${id}" already exists. Close it or pick another id.`, "exists");
    }
    const session = await Session.open({ ...options, id });
    this.sessions.set(id, session);
    session.on("exit", () => {
      // Keep the corpse around: an agent usually wants the final screen.
      // It is removed by close() or by the daemon at shutdown.
    });
    return session;
  }

  private resolveId(options: OpenOptions & { id?: string }): string {
    const explicit = options.id?.trim();
    if (explicit) return explicit;
    const fromName = options.name?.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (fromName && !this.sessions.has(fromName)) return fromName;
    for (;;) {
      this.counter++;
      const candidate = `t${this.counter}`;
      if (!this.sessions.has(candidate)) return candidate;
    }
  }

  async close(id: string): Promise<Session> {
    const session = this.get(id);
    await session.close();
    this.sessions.delete(id);
    return session;
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      all.map(async (session) => {
        try {
          await session.close();
        } catch {
          /* best effort */
        }
      }),
    );
  }
}
