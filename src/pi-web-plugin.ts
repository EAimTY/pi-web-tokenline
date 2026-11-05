// Vite emits this asset import as an `import.meta.url`-relative absolute URL; the browser build
// is the only place the value is read, and `vite.config.ts` keeps `base` relative for it.
import footerStylesheetUrl from "./footer.css?url";
import type { SessionEvent, SessionStatus } from "./host-contract.ts";
import { parseSessionEvent, parseSessionStatus } from "./host-contract.ts";
import {
    approximateTokens,
    cssString,
    formatFooter,
    RateWindow,
    reportedContext,
} from "./metrics.ts";
import type {
    PiWebPluginV5,
    PluginSelectedSession,
    PluginSelectionService,
    PluginSelectionSnapshot,
} from "./plugin-api.ts";

const CSS_VALUE = "--pi-tokenline-content";
const CSS_NATIVE_DISPLAY = "--pi-tokenline-native-display";
const UPDATE_INTERVAL_MS = 180;
const STATUS_REFRESH_DELAY_MS = 100;
const STALE_TPS_MS = 3000;

/** Resolves PI WEB's own application prefix, including reverse-proxy subpaths. */
function appBase(moduleUrl = import.meta.url, fallback = document.baseURI): URL {
    const url = new URL(moduleUrl);
    const marker = "/pi-web-plugins/";
    const index = url.pathname.indexOf(marker);
    if (index < 0) return new URL("./", fallback);
    return new URL(`${url.pathname.slice(0, index + 1)}`, url.origin);
}

/** Identity of the watched conversation; an empty key means nothing is selected. */
function sessionKey(selection: PluginSelectionSnapshot | undefined): string {
    const session = selection?.selectedSession;
    if (session === undefined || session.pending || !session.id || !session.cwd) return "";
    const machineId = selection?.selectedMachine?.id ?? "local";
    return JSON.stringify([
        machineId,
        session.id,
        session.cwd,
    ]);
}

interface SessionUrls {
    readonly statusUrl: URL;
    readonly eventsUrl: URL;
}

function sessionUrls(base: URL, machineId: string, session: PluginSelectedSession): SessionUrls {
    const prefix = `api/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(session.id)}`;
    const query = new URLSearchParams({
        cwd: session.cwd,
    });
    const statusUrl = new URL(`${prefix}/status?${query}`, base);
    const eventsUrl = new URL(`${prefix}/events?${query}`, base);
    eventsUrl.protocol = eventsUrl.protocol === "https:" ? "wss:" : "ws:";
    return {
        statusUrl,
        eventsUrl,
    };
}

class TokenlineFooter {
    private readonly selection: PluginSelectionService | undefined;
    private readonly base: URL;
    private readonly rate = new RateWindow();
    private version = 0;
    private key = "";
    private active = false;
    private disposed = false;
    private status: SessionStatus | null = null;
    private statusRevision = 0;
    private lastContext: number | null = null;
    private streaming = false;
    private liveBaseline = 0;
    private pendingOutput = 0;
    private lastDeltaAt = 0;
    private lastPaintAt = 0;
    private retryMs = 500;
    private lastError = "";
    private lastLine: string | undefined;
    private urls: SessionUrls | undefined;
    private unsubscribe: (() => void) | undefined;
    private tickTimer: ReturnType<typeof setInterval> | undefined;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private fetchController: AbortController | undefined;
    private socket: WebSocket | undefined;

    constructor(selection: PluginSelectionService | undefined) {
        this.selection = selection;
        this.base = appBase();
    }

    start(): void {
        this.unsubscribe = this.selection?.subscribe((next) => this.select(next));
        this.select(this.selection?.getSnapshot());
        this.tickTimer = setInterval(() => {
            if (this.active && this.streaming) this.paint();
        }, 500);
    }

    private select(selection: PluginSelectionSnapshot | undefined): void {
        if (this.disposed) return;
        const next = sessionKey(selection);
        if (next === this.key) return;
        this.clearConnection();
        this.key = next;
        this.version += 1;
        this.status = null;
        this.statusRevision = 0;
        this.lastContext = null;
        this.rate.clear();
        this.streaming = false;
        this.liveBaseline = 0;
        this.pendingOutput = 0;
        this.active = false;
        this.urls = undefined;
        this.restoreNative();
        const session = selection?.selectedSession;
        if (next.length === 0 || session === undefined) return;
        const machineId = selection?.selectedMachine?.id ?? "local";
        this.urls = sessionUrls(this.base, machineId, session);
        this.retryMs = 500;
        this.connect(this.version);
        void this.refreshStatus(this.version);
    }

    private async refreshStatus(version: number): Promise<void> {
        const urls = this.urls;
        if (this.disposed || this.version !== version || urls === undefined) return;
        const requestId = this.statusRevision;
        const controller = new AbortController();
        this.fetchController?.abort();
        this.fetchController = controller;
        try {
            const response = await fetch(urls.statusUrl, {
                signal: controller.signal,
                credentials: "same-origin",
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload: unknown = await response.json();
            if (this.disposed || this.version !== version || controller.signal.aborted) return;
            // Don't let a slower HTTP response overwrite a fresher WebSocket status.
            if (this.statusRevision !== requestId) return;
            const status = parseSessionStatus(payload);
            if (status !== null) this.receiveStatus(status);
        } catch (error) {
            if (this.version === version && !controller.signal.aborted) {
                this.logOnce("Unable to read session status", error);
            }
        } finally {
            if (this.fetchController === controller) this.fetchController = undefined;
        }
    }

    private scheduleStatusRefresh(version: number): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(
            () => void this.refreshStatus(version),
            STATUS_REFRESH_DELAY_MS,
        );
    }

    private receiveStatus(status: SessionStatus): void {
        this.status = status;
        this.statusRevision += 1;
        if (this.pendingOutput <= (status.tokens.output ?? 0)) this.pendingOutput = 0;
        if (status.contextUsage !== null) this.lastContext = status.contextUsage.tokens;
        if (!status.isStreaming && !this.streaming) this.rate.clear();
        this.active = true;
        this.paint(true);
    }

    private connect(version: number): void {
        const urls = this.urls;
        if (this.disposed || this.version !== version || urls === undefined) return;
        const socket = new WebSocket(urls.eventsUrl);
        this.socket = socket;
        socket.onopen = () => {
            if (this.socket !== socket || this.version !== version) return;
            this.retryMs = 500;
            // A gap between subscribing and the status fetch may have lost completed usage.
            this.scheduleStatusRefresh(version);
        };
        socket.onmessage = (event) => {
            if (this.socket !== socket || this.version !== version) return;
            if (typeof event.data !== "string") return;
            try {
                const sessionEvent = parseSessionEvent(JSON.parse(event.data));
                if (sessionEvent !== null) this.consume(sessionEvent);
            } catch (error) {
                this.logOnce("Unrecognized session event", error);
            }
        };
        socket.onerror = () => {
            socket.close();
        };
        socket.onclose = () => {
            if (this.socket !== socket || this.version !== version) return;
            this.socket = undefined;
            this.retryTimer = setTimeout(() => this.connect(version), this.retryMs);
            this.retryMs = Math.min(Math.round(this.retryMs * 1.6), 5000);
        };
    }

    private consume(event: SessionEvent): void {
        const now = performance.now();
        switch (event.type) {
            case "status.update":
                this.receiveStatus(event.status);
                break;
            case "assistant.start":
                this.streaming = true;
                this.rate.start(now);
                this.lastDeltaAt = 0;
                this.liveBaseline = Math.max(this.status?.tokens.output ?? 0, this.pendingOutput);
                this.paint(true);
                break;
            case "assistant.delta":
            case "assistant.thinking.delta":
                if (!this.streaming) {
                    this.streaming = true;
                    this.rate.start(now);
                    this.liveBaseline = Math.max(
                        this.status?.tokens.output ?? 0,
                        this.pendingOutput,
                    );
                }
                this.rate.add(approximateTokens(event.text), now);
                this.lastDeltaAt = now;
                this.paint();
                break;
            case "message.end":
                if (event.message.role === "assistant") {
                    this.streaming = false;
                    const fromMessage = reportedContext(event.message.usage);
                    if (fromMessage !== null) this.lastContext = fromMessage;
                    this.pendingOutput = Math.max(
                        this.pendingOutput,
                        this.liveBaseline + (event.message.usage.output ?? this.rate.total),
                    );
                    this.paint(true);
                    this.scheduleStatusRefresh(this.version);
                }
                break;
            case "agent.end":
                this.streaming = false;
                this.rate.clear();
                this.paint(true);
                this.scheduleStatusRefresh(this.version);
                break;
            case "session.tree.changed":
                this.streaming = false;
                this.rate.clear();
                this.pendingOutput = 0;
                this.lastContext = null;
                // Don't show stale branch totals during navigation.
                this.restoreNative();
                this.active = false;
                this.scheduleStatusRefresh(this.version);
                break;
        }
    }

    private paint(force = false): void {
        const status = this.status;
        if (!this.active || status === null || this.key.length === 0) return;
        const now = performance.now();
        if (!force && now - this.lastPaintAt < UPDATE_INTERVAL_MS) return;
        this.lastPaintAt = now;
        const liveOutput = this.streaming ? this.liveBaseline + this.rate.total : 0;
        let tokensPerSecond = this.streaming ? this.rate.value(now) : null;
        if (this.streaming && this.lastDeltaAt > 0 && now - this.lastDeltaAt > STALE_TPS_MS) {
            tokensPerSecond = 0;
        }
        const line = formatFooter({
            status,
            streaming: this.streaming,
            rate: tokensPerSecond,
            liveOutput,
            pendingOutput: this.pendingOutput,
            lastContext: this.lastContext,
        });
        if (this.lastLine === line) return;
        this.lastLine = line;
        const root = document.documentElement.style;
        root.setProperty(CSS_VALUE, cssString(line));
        root.setProperty(CSS_NATIVE_DISPLAY, "none");
    }

    private restoreNative(): void {
        document.documentElement.style.removeProperty(CSS_VALUE);
        document.documentElement.style.removeProperty(CSS_NATIVE_DISPLAY);
        this.lastLine = undefined;
    }

    private clearConnection(): void {
        clearTimeout(this.retryTimer);
        clearTimeout(this.refreshTimer);
        this.fetchController?.abort();
        this.fetchController = undefined;
        const socket = this.socket;
        this.socket = undefined;
        if (socket !== undefined) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
        }
    }

    private logOnce(label: string, error: unknown): void {
        const message = `${label}: ${String(error)}`;
        if (this.lastError === message) return;
        this.lastError = message;
        console.warn("[pi-web-tokenline]", message);
    }

    dispose(): void {
        this.disposed = true;
        this.unsubscribe?.();
        clearInterval(this.tickTimer);
        this.clearConnection();
        this.restoreNative();
    }
}

const plugin: PiWebPluginV5 = {
    apiVersion: 5,
    name: "Tokenline",
    activate({ selection }) {
        const footer = new TokenlineFooter(selection);
        return {
            contributions: {
                stylesheets: [
                    {
                        id: "native-footer-replacement",
                        url: footerStylesheetUrl,
                        order: 2000,
                    },
                ],
            },
            start() {
                footer.start();
            },
            dispose() {
                footer.dispose();
            },
        };
    },
};

export default plugin;
