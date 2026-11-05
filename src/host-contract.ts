/**
 * The private PI WEB routes this plugin reads, modeled at the boundary.
 *
 * `GET api/machines/<machine>/sessions/<session>/status` and its `events` WebSocket sibling are
 * not part of PI WEB's public plugin API: `docs/plugins.md` lists internal routes as unsupported
 * selectors. The footer depends on them anyway, so every payload is narrowed here, in one place,
 * and each shape below is a claim about a specific host build rather than a guarantee. A host
 * upgrade may invalidate it; the footer restores the native status bar when a payload no longer
 * parses.
 */

/** Provider counters. A field is absent when the host did not report it. */
export interface UsageTotals {
    readonly totalTokens?: number;
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
}

export interface ContextUsage {
    /** `null` when PI WEB cannot report a trustworthy size, such as right after compaction. */
    readonly tokens: number | null;
    readonly contextWindow: number;
}

export interface SessionStatus {
    readonly tokens: UsageTotals;
    /** Absent when the host reports no context accounting for the session. */
    readonly contextUsage: ContextUsage | null;
    readonly isStreaming: boolean;
}

export interface MessageEnd {
    readonly role: string | undefined;
    readonly usage: UsageTotals;
}

/** The session event types the footer reacts to; every other event is ignored. */
export type SessionEvent =
    | {
          readonly type: "status.update";
          readonly status: SessionStatus;
      }
    | {
          readonly type: "assistant.start";
      }
    | {
          readonly type: "assistant.delta";
          readonly text: string;
      }
    | {
          readonly type: "assistant.thinking.delta";
          readonly text: string;
      }
    | {
          readonly type: "message.end";
          readonly message: MessageEnd;
      }
    | {
          readonly type: "agent.end";
      }
    | {
          readonly type: "session.tree.changed";
      };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** A counter the host reported: finite and non-negative, or absent. */
function count(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Includes the key only when the host actually reported the counter. */
function reported(key: string, value: number | undefined): Record<string, number> {
    return value === undefined
        ? {}
        : {
              [key]: value,
          };
}

export function parseUsage(value: unknown): UsageTotals {
    if (!isRecord(value)) return {};
    return {
        ...reported("totalTokens", count(value["totalTokens"])),
        ...reported("input", count(value["input"])),
        ...reported("output", count(value["output"])),
        ...reported("cacheRead", count(value["cacheRead"])),
        ...reported("cacheWrite", count(value["cacheWrite"])),
    };
}

function parseContextUsage(value: unknown): ContextUsage | null {
    if (!isRecord(value)) return null;
    const tokens = value["tokens"];
    const contextWindow = count(value["contextWindow"]) ?? 0;
    if (tokens === null)
        return {
            tokens: null,
            contextWindow,
        };
    const reportedTokens = count(tokens);
    return reportedTokens === undefined
        ? null
        : {
              tokens: reportedTokens,
              contextWindow,
          };
}

export function parseSessionStatus(value: unknown): SessionStatus | null {
    if (!isRecord(value)) return null;
    const tokens = value["tokens"];
    // Without an input counter the host is not reporting usage yet; the footer stays native.
    if (!isRecord(tokens) || typeof tokens["input"] !== "number") return null;
    return {
        tokens: parseUsage(tokens),
        contextUsage: parseContextUsage(value["contextUsage"]),
        isStreaming: value["isStreaming"] === true,
    };
}

export function parseSessionEvent(data: unknown): SessionEvent | null {
    if (!isRecord(data)) return null;
    switch (data["type"]) {
        case "status.update": {
            const status = parseSessionStatus(data["status"]);
            return status === null
                ? null
                : {
                      type: "status.update",
                      status,
                  };
        }
        case "assistant.start":
            return {
                type: "assistant.start",
            };
        case "assistant.delta":
            return typeof data["text"] === "string"
                ? {
                      type: "assistant.delta",
                      text: data["text"],
                  }
                : null;
        case "assistant.thinking.delta":
            return typeof data["text"] === "string"
                ? {
                      type: "assistant.thinking.delta",
                      text: data["text"],
                  }
                : null;
        case "message.end": {
            const message = data["message"];
            if (!isRecord(message)) return null;
            const role = message["role"];
            return {
                type: "message.end",
                message: {
                    role: typeof role === "string" ? role : undefined,
                    usage: parseUsage(message["usage"]),
                },
            };
        }
        case "agent.end":
            return {
                type: "agent.end",
            };
        case "session.tree.changed":
            return {
                type: "session.tree.changed",
            };
        default:
            return null;
    }
}
