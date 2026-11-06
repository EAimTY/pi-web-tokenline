/**
 * The private PI WEB routes this plugin reads, modeled at the boundary.
 *
 * `GET api/machines/<machine>/sessions/<session>/status` and its `events` WebSocket sibling are
 * not part of PI WEB's public plugin API: `docs/plugins.md` lists internal routes as unsupported
 * selectors. The footer depends on them anyway, so every payload is narrowed here, in one place,
 * and each shape below is a claim about a specific host build rather than a guarantee. A host
 * upgrade may invalidate it; the footer restores the native status bar when a payload no longer
 * parses.
 *
 * The `events` socket is text JSON on the session daemon's side, but PI WEB's web/API proxy
 * forwards each payload as a `Buffer`, so browsers receive those frames as binary. The browser
 * entry accepts both encodings and decodes binary frames synchronously to preserve wire order.
 *
 * Status publishes on every session event, but its `tokens` are committed session statistics, not
 * live provider usage. The browser event projection forwards text and thinking deltas only;
 * tool-call argument deltas never reach this contract. A message's final usage therefore cannot
 * be paired with a tool-safe decode window unless the message content proves there was no tool call.
 */

/** Provider counters. A field is absent when the host did not report it. */
export interface UsageTotals {
    readonly totalTokens?: number;
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    /** Reasoning tokens when the provider reports them; already included in `output`. */
    readonly reasoning?: number;
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
    /** `<provider>/<model>` when the host reports the active model; otherwise `null`. */
    readonly modelKey: string | null;
}

export interface MessageEnd {
    readonly role: string | undefined;
    readonly usage: UsageTotals;
    readonly stopReason: string | undefined;
    /** `true`/`false` when the content proves it; `null` when the payload cannot tell. */
    readonly hasToolCall: boolean | null;
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
          readonly type: "agent.start";
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
        ...reported("reasoning", count(value["reasoning"])),
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

function parseModelKey(value: unknown): string | null {
    if (!isRecord(value)) return null;
    const provider = value["provider"];
    const id = value["id"];
    return typeof provider === "string" &&
        provider.length > 0 &&
        typeof id === "string" &&
        id.length > 0
        ? `${provider}/${id}`
        : null;
}

/** Whether a complete message contains a tool call, or `null` when its shape cannot prove it. */
function toolCallPresence(content: unknown): boolean | null {
    if (!Array.isArray(content)) return null;
    return content.some((part) => isRecord(part) && part["type"] === "toolCall");
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
        modelKey: parseModelKey(value["model"]),
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
        case "agent.start":
            return {
                type: "agent.start",
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
            const stopReason = message["stopReason"];
            const reportedStopReason = typeof stopReason === "string" ? stopReason : undefined;
            const contentToolCall = toolCallPresence(message["content"]);
            return {
                type: "message.end",
                message: {
                    role: typeof role === "string" ? role : undefined,
                    usage: parseUsage(message["usage"]),
                    stopReason: reportedStopReason,
                    hasToolCall:
                        contentToolCall === true || reportedStopReason === "toolUse"
                            ? true
                            : contentToolCall,
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
