import { expect, test } from "vitest";
import { parseSessionEvent, parseSessionStatus, parseUsage } from "./host-contract.ts";

test("session status carries the active model identity", () => {
    const status = parseSessionStatus({
        tokens: {
            input: 12,
            output: 4,
        },
        contextUsage: {
            tokens: 100,
            contextWindow: 1000,
        },
        isStreaming: true,
        model: {
            provider: "magpie",
            id: "deepseek-v4.1-flash",
        },
    });
    expect(status?.modelKey).toBe("magpie/deepseek-v4.1-flash");
    expect(
        parseSessionStatus({
            ...status,
            model: undefined,
        })?.modelKey,
    ).toBeNull();
    expect(
        parseUsage({
            output: 10,
            reasoning: 4,
        }),
    ).toEqual({
        output: 10,
        reasoning: 4,
    });
});

test("a completed message reports how its tool-call state was proven", () => {
    const toolUse = parseSessionEvent({
        type: "message.end",
        message: {
            role: "assistant",
            usage: {
                output: 10,
                reasoning: 4,
            },
            stopReason: "toolUse",
            content: [
                {
                    type: "text",
                    text: "calling",
                },
                {
                    type: "toolCall",
                    name: "read",
                },
            ],
        },
    });
    expect(toolUse).toMatchObject({
        type: "message.end",
        message: {
            stopReason: "toolUse",
            hasToolCall: true,
            usage: {
                output: 10,
                reasoning: 4,
            },
        },
    });
    const plain = parseSessionEvent({
        type: "message.end",
        message: {
            role: "assistant",
            usage: {
                output: 10,
            },
            stopReason: "stop",
            content: [
                {
                    type: "text",
                    text: "done",
                },
            ],
        },
    });
    expect(plain).toMatchObject({
        message: {
            hasToolCall: false,
        },
    });
    // A payload that cannot prove the content shape stays unknown, never falsely decode-safe.
    const unknown = parseSessionEvent({
        type: "message.end",
        message: {
            role: "assistant",
            usage: {
                output: 10,
            },
            stopReason: "stop",
        },
    });
    expect(unknown).toMatchObject({
        message: {
            hasToolCall: null,
        },
    });
    // The stop reason alone proves a tool call when content is absent.
    const toolUseWithoutContent = parseSessionEvent({
        type: "message.end",
        message: {
            role: "assistant",
            usage: {},
            stopReason: "toolUse",
        },
    });
    expect(toolUseWithoutContent).toMatchObject({
        message: {
            hasToolCall: true,
        },
    });
});

test("agent turn boundaries and malformed payloads stay explicit", () => {
    expect(
        parseSessionEvent({
            type: "agent.start",
        }),
    ).toEqual({
        type: "agent.start",
    });
    expect(
        parseSessionEvent({
            type: "message.end",
        }),
    ).toBeNull();
    expect(
        parseSessionEvent({
            type: "message.end",
            message: {},
        }),
    ).toMatchObject({
        message: {
            role: undefined,
            usage: {},
            stopReason: undefined,
            hasToolCall: null,
        },
    });
});
