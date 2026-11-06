import { afterEach, beforeEach, expect, test, vi } from "vitest";
import plugin from "./pi-web-plugin.ts";
import type {
    PluginActivationResultV5,
    PluginSelectionService,
    PluginSelectionSnapshot,
} from "./plugin-api.ts";

/** The browser host surface the plugin touches: socket construction, binary frames, and close. */
class MockSocket {
    static instances: MockSocket[] = [];
    readonly url: string;
    binaryType: BinaryType = "blob";
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string | URL) {
        this.url = String(url);
        MockSocket.instances.push(this);
    }

    /** Delivers an event the way PI WEB's proxy does: JSON text in a binary frame. */
    fire(event: unknown): void {
        const bytes = new TextEncoder().encode(JSON.stringify(event));
        const frame = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(frame).set(bytes);
        this.onmessage?.({
            data: frame,
        });
    }

    /** Every text payload stays readable when a transport keeps it as text. */
    fireText(event: unknown): void {
        this.onmessage?.({
            data: JSON.stringify(event),
        });
    }

    close(): void {
        this.closed = true;
    }
}

function statusPayload(context = 53000) {
    return {
        tokens: {
            input: 110,
            output: 100,
            cacheRead: 22000,
            cacheWrite: 1200,
        },
        contextUsage: {
            tokens: context,
            contextWindow: 272000,
        },
        isStreaming: false,
    };
}

const properties = new Map<string, string>();
let clock = 0;

function advanceTo(value: number): void {
    clock = value;
}

beforeEach(() => {
    MockSocket.instances.length = 0;
    properties.clear();
    clock = 0;
    vi.stubGlobal("document", {
        baseURI: "https://web.example/prefix/",
        documentElement: {
            style: {
                setProperty(name: string, value: string) {
                    properties.set(name, value);
                },
                removeProperty(name: string) {
                    properties.delete(name);
                },
            },
        },
    });
    vi.stubGlobal("WebSocket", MockSocket);
    vi.stubGlobal("fetch", async () => ({
        ok: true,
        json: async () => statusPayload(),
    }));
    vi.stubGlobal("performance", {
        now: () => clock,
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

interface SelectionMock extends PluginSelectionService {
    select(snapshot: PluginSelectionSnapshot): void;
}

function mockSelection(): SelectionMock {
    let listener: ((snapshot: PluginSelectionSnapshot) => void | Promise<void>) | undefined;
    let selected: PluginSelectionSnapshot = {
        selectedMachine: {
            id: "local",
            name: "Local",
            kind: "local",
        },
        selectedSession: {
            id: "first",
            cwd: "/work/alpha",
            archived: false,
            pending: false,
        },
    };
    return {
        getSnapshot: () => selected,
        subscribe(next) {
            listener = next;
            return () => {
                listener = undefined;
            };
        },
        select(snapshot) {
            selected = snapshot;
            void listener?.(snapshot);
        },
    };
}

async function activate(selection: PluginSelectionService): Promise<PluginActivationResultV5> {
    const controller = new AbortController();
    return await plugin.activate({
        apiVersion: 5,
        pluginId: "tokenline",
        runtimePluginId: "tokenline",
        signal: controller.signal,
        lifetimeSignal: controller.signal,
        selection,
    });
}

async function flush(): Promise<void> {
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

async function startFooter(): Promise<{
    activation: PluginActivationResultV5;
    socket: MockSocket;
    selection: SelectionMock;
}> {
    const selection = mockSelection();
    const activation = await activate(selection);
    const signal = new AbortController().signal;
    activation.start?.({
        signal,
    });
    await flush();
    const socket = MockSocket.instances[0];
    if (socket === undefined) throw new Error("expected a session event socket");
    return {
        activation,
        socket,
        selection,
    };
}

test("replaces the native footer with live TPS, then an exact final, and restores it on selection", async () => {
    const { activation, socket, selection } = await startFooter();
    const signal = new AbortController().signal;
    try {
        expect(plugin.apiVersion).toBe(5);
        const stylesheet = activation.contributions.stylesheets?.[0];
        expect(stylesheet?.id).toBe("native-footer-replacement");
        expect(properties.get("--pi-tokenline-native-display")).toBe("none");
        expect(properties.get("--pi-tokenline-content")).toMatch(/Ctx 53K\/272K/u);
        expect(socket.binaryType).toBe("arraybuffer");
        expect(socket.url).toMatch(
            /^wss:\/\/web\.example\/prefix\/api\/machines\/local\/sessions\/first\/events\?cwd=%2Fwork%2Falpha$/u,
        );
        advanceTo(1000);
        socket.fireText({
            type: "assistant.start",
        });
        advanceTo(1400);
        socket.fire({
            type: "assistant.delta",
            text: "abcdefghijabcdefghijabcdefghijabcdefghij",
        });
        advanceTo(2400);
        socket.fire({
            type: "assistant.delta",
            text: "a".repeat(400),
        });
        // The first chunk only opens the window; the second chunk is rated over its interval.
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS ~100 tok\/s/u);
        advanceTo(3400);
        socket.fire({
            type: "message.end",
            message: {
                role: "assistant",
                usage: {
                    totalTokens: 56000,
                    output: 200,
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
        // A fully observable message gets exact decode TPS, without the estimate marker.
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS 100 tok\/s/u);
        expect(properties.get("--pi-tokenline-content")).not.toMatch(/TPS ~100/u);
        expect(properties.get("--pi-tokenline-content")).toMatch(/Out 300/u);
        selection.select({
            selectedMachine: {
                id: "local",
                name: "Local",
                kind: "local",
            },
            selectedSession: {
                id: "second",
                cwd: "/work/beta",
                archived: false,
                pending: false,
            },
        });
        expect(socket.closed).toBe(true);
        expect(properties.has("--pi-tokenline-content")).toBe(false);
        await flush();
        expect(properties.get("--pi-tokenline-content")).toMatch(/In 110/u);
    } finally {
        activation.dispose?.(signal);
    }
    expect(properties.has("--pi-tokenline-content")).toBe(false);
    expect(properties.has("--pi-tokenline-native-display")).toBe(false);
});

test("tool-call messages use an end-to-end average and keep it through tool execution", async () => {
    const { activation, socket } = await startFooter();
    const signal = new AbortController().signal;
    try {
        advanceTo(1000);
        socket.fire({
            type: "assistant.start",
        });
        advanceTo(1400);
        socket.fire({
            type: "assistant.delta",
            text: "a".repeat(40),
        });
        advanceTo(2400);
        socket.fire({
            type: "assistant.delta",
            text: "a".repeat(400),
        });
        advanceTo(3400);
        socket.fire({
            type: "message.end",
            message: {
                role: "assistant",
                usage: {
                    output: 200,
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
        // tool-call tokens are in usage but their deltas never reach the browser, so the final
        // reading is whole-message throughput, clearly marked as an average.
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS 83 tok\/s avg/u);
        expect(properties.get("--pi-tokenline-content")).toMatch(/Out 300/u);
        // The completed reading stays visible while the tool runs.
        advanceTo(4000);
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS 83 tok\/s avg/u);
    } finally {
        activation.dispose?.(signal);
    }
});

test("a new assistant message clears the previous final until its own rate is measurable", async () => {
    const { activation, socket } = await startFooter();
    const signal = new AbortController().signal;
    try {
        advanceTo(1000);
        socket.fire({
            type: "assistant.start",
        });
        advanceTo(1400);
        socket.fire({
            type: "assistant.delta",
            text: "a".repeat(40),
        });
        advanceTo(2400);
        socket.fire({
            type: "assistant.delta",
            text: "a".repeat(400),
        });
        advanceTo(3400);
        socket.fire({
            type: "message.end",
            message: {
                role: "assistant",
                usage: {
                    output: 200,
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
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS 100 tok\/s/u);
        advanceTo(4000);
        socket.fire({
            type: "assistant.start",
        });
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS -- tok\/s/u);
        advanceTo(4400);
        socket.fire({
            type: "assistant.delta",
            text: "a".repeat(400),
        });
        // The old final is gone, and one chunk is not a rate.
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS -- tok\/s/u);
        advanceTo(5400);
        socket.fire({
            type: "assistant.delta",
            text: "a".repeat(400),
        });
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS ~100 tok\/s/u);
    } finally {
        activation.dispose?.(signal);
    }
});

test("agent.start clears the completed reading for a new turn", async () => {
    const { activation, socket } = await startFooter();
    const signal = new AbortController().signal;
    try {
        advanceTo(1000);
        socket.fire({
            type: "assistant.start",
        });
        advanceTo(1400);
        socket.fire({
            type: "assistant.delta",
            text: "a".repeat(40),
        });
        advanceTo(2400);
        socket.fire({
            type: "assistant.delta",
            text: "a".repeat(400),
        });
        advanceTo(3400);
        socket.fire({
            type: "message.end",
            message: {
                role: "assistant",
                usage: {
                    output: 200,
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
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS 100 tok\/s/u);
        socket.fire({
            type: "agent.start",
        });
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS -- tok\/s/u);
    } finally {
        activation.dispose?.(signal);
    }
});
