// src/footer.css?url
var footer_default = "" + new URL("footer.css", import.meta.url).href;
// src/host-contract.ts
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
/** A counter the host reported: finite and non-negative, or absent. */
function count(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
/** Includes the key only when the host actually reported the counter. */
function reported(key, value) {
	return value === void 0 ? {} : { [key]: value };
}
function parseUsage(value) {
	if (!isRecord(value)) return {};
	return {
		...reported("totalTokens", count(value["totalTokens"])),
		...reported("input", count(value["input"])),
		...reported("output", count(value["output"])),
		...reported("cacheRead", count(value["cacheRead"])),
		...reported("cacheWrite", count(value["cacheWrite"]))
	};
}
function parseContextUsage(value) {
	if (!isRecord(value)) return null;
	const tokens = value["tokens"];
	const contextWindow = count(value["contextWindow"]) ?? 0;
	if (tokens === null) return {
		tokens: null,
		contextWindow
	};
	const reportedTokens = count(tokens);
	return reportedTokens === void 0 ? null : {
		tokens: reportedTokens,
		contextWindow
	};
}
function parseSessionStatus(value) {
	if (!isRecord(value)) return null;
	const tokens = value["tokens"];
	if (!isRecord(tokens) || typeof tokens["input"] !== "number") return null;
	return {
		tokens: parseUsage(tokens),
		contextUsage: parseContextUsage(value["contextUsage"]),
		isStreaming: value["isStreaming"] === true
	};
}
function parseSessionEvent(data) {
	if (!isRecord(data)) return null;
	switch (data["type"]) {
		case "status.update": {
			const status = parseSessionStatus(data["status"]);
			return status === null ? null : {
				type: "status.update",
				status
			};
		}
		case "assistant.start": return { type: "assistant.start" };
		case "assistant.delta": return typeof data["text"] === "string" ? {
			type: "assistant.delta",
			text: data["text"]
		} : null;
		case "assistant.thinking.delta": return typeof data["text"] === "string" ? {
			type: "assistant.thinking.delta",
			text: data["text"]
		} : null;
		case "message.end": {
			const message = data["message"];
			if (!isRecord(message)) return null;
			const role = message["role"];
			return {
				type: "message.end",
				message: {
					role: typeof role === "string" ? role : void 0,
					usage: parseUsage(message["usage"])
				}
			};
		}
		case "agent.end": return { type: "agent.end" };
		case "session.tree.changed": return { type: "session.tree.changed" };
		default: return null;
	}
}
// src/metrics.ts
var RATE_WINDOW_MS = 2500;
var CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Estimates generated tokens from streamed text; never a provider-reported count. */
function approximateTokens(text) {
	if (text.length === 0) return 0;
	let cjk = 0;
	let otherBytes = 0;
	for (const character of text) {
		if (CJK_PATTERN.test(character)) {
			cjk += 1;
			continue;
		}
		const codePoint = character.codePointAt(0) ?? 0;
		otherBytes += codePoint <= 127 ? 1 : codePoint <= 2047 ? 2 : codePoint <= 65535 ? 3 : 4;
	}
	return cjk + otherBytes / 4;
}
/** Trailing-window throughput that includes idle gaps instead of inflating bursts. */
var RateWindow = class {
	windowMs;
	total = 0;
	samples = [];
	startedAt = null;
	lastTokenAt = null;
	constructor(windowMs = RATE_WINDOW_MS) {
		this.windowMs = windowMs;
	}
	clear() {
		this.samples = [];
		this.total = 0;
		this.startedAt = null;
		this.lastTokenAt = null;
	}
	start(now) {
		this.clear();
		this.startedAt = now;
		this.samples.push({
			at: now,
			total: 0
		});
	}
	add(delta, now) {
		if (this.startedAt === null) this.start(now);
		if (!(delta > 0)) return;
		this.total += delta;
		this.lastTokenAt = now;
		this.samples.push({
			at: now,
			total: this.total
		});
		this.prune(now);
	}
	prune(now) {
		const cutoff = now - this.windowMs;
		while (this.samples.length > 2) {
			const second = this.samples[1];
			if (second === void 0 || second.at >= cutoff) break;
			this.samples.shift();
		}
	}
	value(now) {
		if (this.startedAt === null || this.lastTokenAt === null) return null;
		if (now - this.lastTokenAt > this.windowMs) return 0;
		this.prune(now);
		const cutoff = Math.max(this.startedAt, now - this.windowMs);
		const first = this.samples[0];
		if (first === void 0) return null;
		let before = first;
		for (const sample of this.samples) {
			if (sample.at >= cutoff) break;
			before = sample;
		}
		const generated = this.total - before.total;
		const elapsed = Math.max(600, now - before.at);
		return Math.max(0, generated * 1e3 / elapsed);
	}
};
/** Best available context size for one completed request, or `null` when none is reported. */
function reportedContext(usage) {
	if (usage === null || usage === void 0) return null;
	const total = usage.totalTokens ?? 0;
	if (total > 0) return total;
	const sum = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return sum > 0 ? sum : null;
}
function formatCount(count) {
	if (count < 1e3) return String(Math.round(count));
	const scale = count >= 1e6 ? 1e6 : 1e3;
	const suffix = scale === 1e6 ? "M" : "K";
	const value = count / scale;
	const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(digits).replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "")}${suffix}`;
}
/** Produces plain text. Never display data from model output in the footer. */
function formatFooter({ status, rate = null, streaming = false, liveOutput = 0, pendingOutput = 0, lastContext = null } = {}) {
	const tokens = status?.tokens;
	const input = tokens?.input ?? 0;
	const output = Math.max(tokens?.output ?? 0, liveOutput, pendingOutput);
	const cacheRead = tokens?.cacheRead ?? 0;
	const cacheWrite = tokens?.cacheWrite ?? 0;
	const context = status?.contextUsage;
	const contextWindow = context?.contextWindow ?? 0;
	const contextTokens = context?.tokens === null ? null : lastContext ?? context?.tokens ?? null;
	const currentContext = contextTokens === null ? "--" : formatCount(contextTokens);
	const maxContext = contextWindow > 0 ? `/${formatCount(contextWindow)}` : "";
	return `TPS ${streaming ? rate === null ? "--" : Math.min(rate, 9999).toFixed(1) : "--"} tok/s  ·  Ctx ${currentContext}${maxContext}  ·  In ${formatCount(input)}  ·  Out ${formatCount(output)}  ·  Cache R ${formatCount(cacheRead)}  ·  W ${formatCount(cacheWrite)}`;
}
/** Keeps CSS-generated content safe, quoting exactly one CSS string token. */
function cssString(value) {
	return JSON.stringify(value.replace(/[\x00-\x1f\x7f]/gu, " "));
}
// src/pi-web-plugin.ts
var CSS_VALUE = "--pi-tokenline-content";
var CSS_NATIVE_DISPLAY = "--pi-tokenline-native-display";
var UPDATE_INTERVAL_MS = 180;
var STATUS_REFRESH_DELAY_MS = 100;
var STALE_TPS_MS = 3e3;
/** Resolves PI WEB's own application prefix, including reverse-proxy subpaths. */
function appBase(moduleUrl = import.meta.url, fallback = document.baseURI) {
	const url = new URL(moduleUrl);
	const index = url.pathname.indexOf("/pi-web-plugins/");
	if (index < 0) return new URL("./", fallback);
	return new URL(`${url.pathname.slice(0, index + 1)}`, url.origin);
}
/** Identity of the watched conversation; an empty key means nothing is selected. */
function sessionKey(selection) {
	const session = selection?.selectedSession;
	if (session === void 0 || session.pending || !session.id || !session.cwd) return "";
	const machineId = selection?.selectedMachine?.id ?? "local";
	return JSON.stringify([
		machineId,
		session.id,
		session.cwd
	]);
}
function sessionUrls(base, machineId, session) {
	const prefix = `api/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(session.id)}`;
	const query = new URLSearchParams({ cwd: session.cwd });
	const statusUrl = new URL(`${prefix}/status?${query}`, base);
	const eventsUrl = new URL(`${prefix}/events?${query}`, base);
	eventsUrl.protocol = eventsUrl.protocol === "https:" ? "wss:" : "ws:";
	return {
		statusUrl,
		eventsUrl
	};
}
var TokenlineFooter = class {
	selection;
	base;
	rate = new RateWindow();
	version = 0;
	key = "";
	active = false;
	disposed = false;
	status = null;
	statusRevision = 0;
	lastContext = null;
	streaming = false;
	liveBaseline = 0;
	pendingOutput = 0;
	lastDeltaAt = 0;
	lastPaintAt = 0;
	retryMs = 500;
	lastError = "";
	lastLine;
	urls;
	unsubscribe;
	tickTimer;
	retryTimer;
	refreshTimer;
	fetchController;
	socket;
	constructor(selection) {
		this.selection = selection;
		this.base = appBase();
	}
	start() {
		this.unsubscribe = this.selection?.subscribe((next) => this.select(next));
		this.select(this.selection?.getSnapshot());
		this.tickTimer = setInterval(() => {
			if (this.active && this.streaming) this.paint();
		}, 500);
	}
	select(selection) {
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
		this.urls = void 0;
		this.restoreNative();
		const session = selection?.selectedSession;
		if (next.length === 0 || session === void 0) return;
		const machineId = selection?.selectedMachine?.id ?? "local";
		this.urls = sessionUrls(this.base, machineId, session);
		this.retryMs = 500;
		this.connect(this.version);
		this.refreshStatus(this.version);
	}
	async refreshStatus(version) {
		const urls = this.urls;
		if (this.disposed || this.version !== version || urls === void 0) return;
		const requestId = this.statusRevision;
		const controller = new AbortController();
		this.fetchController?.abort();
		this.fetchController = controller;
		try {
			const response = await fetch(urls.statusUrl, {
				signal: controller.signal,
				credentials: "same-origin"
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			if (this.disposed || this.version !== version || controller.signal.aborted) return;
			if (this.statusRevision !== requestId) return;
			const status = parseSessionStatus(payload);
			if (status !== null) this.receiveStatus(status);
		} catch (error) {
			if (this.version === version && !controller.signal.aborted) this.logOnce("Unable to read session status", error);
		} finally {
			if (this.fetchController === controller) this.fetchController = void 0;
		}
	}
	scheduleStatusRefresh(version) {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => void this.refreshStatus(version), STATUS_REFRESH_DELAY_MS);
	}
	receiveStatus(status) {
		this.status = status;
		this.statusRevision += 1;
		if (this.pendingOutput <= (status.tokens.output ?? 0)) this.pendingOutput = 0;
		if (status.contextUsage !== null) this.lastContext = status.contextUsage.tokens;
		if (!status.isStreaming && !this.streaming) this.rate.clear();
		this.active = true;
		this.paint(true);
	}
	connect(version) {
		const urls = this.urls;
		if (this.disposed || this.version !== version || urls === void 0) return;
		const socket = new WebSocket(urls.eventsUrl);
		this.socket = socket;
		socket.onopen = () => {
			if (this.socket !== socket || this.version !== version) return;
			this.retryMs = 500;
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
			this.socket = void 0;
			this.retryTimer = setTimeout(() => this.connect(version), this.retryMs);
			this.retryMs = Math.min(Math.round(this.retryMs * 1.6), 5e3);
		};
	}
	consume(event) {
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
					this.liveBaseline = Math.max(this.status?.tokens.output ?? 0, this.pendingOutput);
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
					this.pendingOutput = Math.max(this.pendingOutput, this.liveBaseline + (event.message.usage.output ?? this.rate.total));
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
				this.restoreNative();
				this.active = false;
				this.scheduleStatusRefresh(this.version);
		}
	}
	paint(force = false) {
		const status = this.status;
		if (!this.active || status === null || this.key.length === 0) return;
		const now = performance.now();
		if (!force && now - this.lastPaintAt < UPDATE_INTERVAL_MS) return;
		this.lastPaintAt = now;
		const liveOutput = this.streaming ? this.liveBaseline + this.rate.total : 0;
		let tokensPerSecond = this.streaming ? this.rate.value(now) : null;
		if (this.streaming && this.lastDeltaAt > 0 && now - this.lastDeltaAt > STALE_TPS_MS) tokensPerSecond = 0;
		const line = formatFooter({
			status,
			streaming: this.streaming,
			rate: tokensPerSecond,
			liveOutput,
			pendingOutput: this.pendingOutput,
			lastContext: this.lastContext
		});
		if (this.lastLine === line) return;
		this.lastLine = line;
		const root = document.documentElement.style;
		root.setProperty(CSS_VALUE, cssString(line));
		root.setProperty(CSS_NATIVE_DISPLAY, "none");
	}
	restoreNative() {
		document.documentElement.style.removeProperty(CSS_VALUE);
		document.documentElement.style.removeProperty(CSS_NATIVE_DISPLAY);
		this.lastLine = void 0;
	}
	clearConnection() {
		clearTimeout(this.retryTimer);
		clearTimeout(this.refreshTimer);
		this.fetchController?.abort();
		this.fetchController = void 0;
		const socket = this.socket;
		this.socket = void 0;
		if (socket !== void 0) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onerror = null;
			socket.onclose = null;
			socket.close();
		}
	}
	logOnce(label, error) {
		const message = `${label}: ${String(error)}`;
		if (this.lastError === message) return;
		this.lastError = message;
		console.warn("[pi-web-tokenline]", message);
	}
	dispose() {
		this.disposed = true;
		this.unsubscribe?.();
		clearInterval(this.tickTimer);
		this.clearConnection();
		this.restoreNative();
	}
};
var plugin = {
	apiVersion: 5,
	name: "Tokenline",
	activate({ selection }) {
		const footer = new TokenlineFooter(selection);
		return {
			contributions: { stylesheets: [{
				id: "native-footer-replacement",
				url: footer_default,
				order: 2e3
			}] },
			start() {
				footer.start();
			},
			dispose() {
				footer.dispose();
			}
		};
	}
};
export { plugin as default };
