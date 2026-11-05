import { afterEach, beforeEach, expect, test, vi } from "vitest";
import plugin from "./pi-web-plugin.ts";
import type {
    PluginActivationResultV5,
    PluginSelectionService,
    PluginSelectionSnapshot,
} from "./plugin-api.ts";

/** The browser host surface the plugin touches: socket construction, text frames, and close. */
class MockSocket {
    static instances: MockSocket[] = [];
    readonly url: string;
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string | URL) {
        this.url = String(url);
        MockSocket.instances.push(this);
    }

    fire(event: unknown): void {
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

test("replaces and restores the native footer across streams and selection changes", async () => {
    const selection = mockSelection();
    const activation = await activate(selection);
    const signal = new AbortController().signal;
    try {
        expect(plugin.apiVersion).toBe(5);
        const stylesheet = activation.contributions.stylesheets?.[0];
        expect(stylesheet?.id).toBe("native-footer-replacement");
        activation.start?.({
            signal,
        });
        await flush();
        expect(properties.get("--pi-tokenline-native-display")).toBe("none");
        expect(properties.get("--pi-tokenline-content")).toMatch(/Ctx 53K\/272K/u);
        const firstSocket = MockSocket.instances[0];
        if (firstSocket === undefined) throw new Error("expected a session event socket");
        expect(firstSocket.url).toMatch(
            /^wss:\/\/web\.example\/prefix\/api\/machines\/local\/sessions\/first\/events\?cwd=%2Fwork%2Falpha$/u,
        );
        advanceTo(1000);
        firstSocket.fire({
            type: "assistant.start",
        });
        advanceTo(1400);
        firstSocket.fire({
            type: "assistant.delta",
            text: "abcdefghijabcdefghijabcdefghijabcdefghij",
        });
        advanceTo(1900);
        firstSocket.fire({
            type: "assistant.thinking.delta",
            text: "abcdefghijabcdefghijabcdefghijabcdefghij",
        });
        expect(properties.get("--pi-tokenline-content")).toMatch(/TPS [0-9]+\.[0-9] tok\/s/u);
        firstSocket.fire({
            type: "message.end",
            message: {
                role: "assistant",
                usage: {
                    totalTokens: 56000,
                    output: 200,
                },
            },
        });
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
        expect(firstSocket.closed).toBe(true);
        expect(properties.has("--pi-tokenline-content")).toBe(false);
        await flush();
        expect(properties.get("--pi-tokenline-content")).toMatch(/In 110/u);
    } finally {
        activation.dispose?.(signal);
    }
    expect(properties.has("--pi-tokenline-content")).toBe(false);
    expect(properties.has("--pi-tokenline-native-display")).toBe(false);
});
