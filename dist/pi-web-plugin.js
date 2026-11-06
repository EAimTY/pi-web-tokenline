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
		...reported("cacheWrite", count(value["cacheWrite"])),
		...reported("reasoning", count(value["reasoning"]))
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
function parseModelKey(value) {
	if (!isRecord(value)) return null;
	const provider = value["provider"];
	const id = value["id"];
	return typeof provider === "string" && provider.length > 0 && typeof id === "string" && id.length > 0 ? `${provider}/${id}` : null;
}
/** Whether a complete message contains a tool call, or `null` when its shape cannot prove it. */
function toolCallPresence(content) {
	if (!Array.isArray(content)) return null;
	return content.some((part) => isRecord(part) && part["type"] === "toolCall");
}
function parseSessionStatus(value) {
	if (!isRecord(value)) return null;
	const tokens = value["tokens"];
	if (!isRecord(tokens) || typeof tokens["input"] !== "number") return null;
	return {
		tokens: parseUsage(tokens),
		contextUsage: parseContextUsage(value["contextUsage"]),
		isStreaming: value["isStreaming"] === true,
		modelKey: parseModelKey(value["model"])
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
		case "agent.start": return { type: "agent.start" };
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
			const stopReason = message["stopReason"];
			const reportedStopReason = typeof stopReason === "string" ? stopReason : void 0;
			const contentToolCall = toolCallPresence(message["content"]);
			return {
				type: "message.end",
				message: {
					role: typeof role === "string" ? role : void 0,
					usage: parseUsage(message["usage"]),
					stopReason: reportedStopReason,
					hasToolCall: contentToolCall === true || reportedStopReason === "toolUse" ? true : contentToolCall
				}
			};
		}
		case "agent.end": return { type: "agent.end" };
		case "session.tree.changed": return { type: "session.tree.changed" };
		default: return null;
	}
}
// src/metrics.ts
/** Trailing window for the live rate. Long enough to smooth bursts, short enough to react. */
var RATE_WINDOW_MS = 3e3;
/** Accepted provider/estimate ratio; outside this the two sides count different things. */
var MIN_CALIBRATION_RATIO = .5;
var CALIBRATION_ALPHA = .3;
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
/**
* Trailing-window throughput with a first-chunk baseline and burst credit.
*
* The first delta only opens the window: its generation time happened before the meter could
* observe it, so crediting it would either inflate a buffered chunk or dilute the rate with TTFT.
* Every later interval credits at most a plausible multiple of the window's own raw pace. `total`
* remains the full estimate so the output counter never loses tokens.
*/
var RateWindow = class {
	windowMs;
	samples = [];
	rawTotal = 0;
	creditedTotal = 0;
	lastTokenAt = null;
	constructor(windowMs = RATE_WINDOW_MS) {
		this.windowMs = windowMs;
	}
	/** Full estimated output for the current message, including uncredited burst tokens. */
	get total() {
		return this.rawTotal;
	}
	clear() {
		this.samples = [];
		this.rawTotal = 0;
		this.creditedTotal = 0;
		this.lastTokenAt = null;
	}
	add(delta, now) {
		if (!(delta > 0) || !Number.isFinite(delta) || !Number.isFinite(now)) return;
		const last = this.samples[this.samples.length - 1];
		if (last === void 0) {
			this.rawTotal = delta;
			this.creditedTotal = delta;
			this.lastTokenAt = now;
			this.samples.push({
				at: now,
				raw: delta,
				credited: delta
			});
			return;
		}
		if (now <= last.at) {
			this.rawTotal += delta;
			return;
		}
		const elapsed = now - last.at;
		const rawPace = this.rawRate(now);
		const ceiling = Math.max(100, (rawPace ?? 0) * 2);
		const credit = Math.min(delta, ceiling * elapsed / 1e3);
		this.rawTotal += delta;
		this.creditedTotal += credit;
		this.lastTokenAt = now;
		this.samples.push({
			at: now,
			raw: last.raw + delta,
			credited: this.creditedTotal
		});
		this.prune(now);
	}
	value(now) {
		if (this.samples.length === 0 || this.lastTokenAt === null) return null;
		const at = Math.max(now, this.lastTokenAt);
		if (at - this.lastTokenAt > 3e3) return 0;
		this.prune(at);
		const baseline = this.baselineAt(at);
		if (baseline === null) return null;
		const span = at - baseline.at;
		if (span < 1e3) return null;
		const generated = this.creditedTotal - baseline.credited;
		if (generated <= 0) return null;
		const rate = generated * 1e3 / span;
		if (!Number.isFinite(rate) || rate > 5e3) return null;
		return Math.max(0, rate);
	}
	/** The oldest checkpoint still inside the trailing window. */
	baselineAt(now) {
		const cutoff = now - this.windowMs;
		for (const sample of this.samples) if (sample.at >= cutoff) return sample;
		return null;
	}
	rawRate(now) {
		const current = this.samples[this.samples.length - 1];
		if (current === void 0) return null;
		const baseline = this.baselineAt(now);
		if (baseline === null) return null;
		const span = now - baseline.at;
		if (span < 1e3) return null;
		const generated = current.raw - baseline.raw;
		if (generated <= 0) return null;
		const rate = generated * 1e3 / span;
		return Number.isFinite(rate) ? rate : null;
	}
	prune(now) {
		const cutoff = now - this.windowMs;
		while (this.samples.length > 1) {
			const first = this.samples[0];
			if (first === void 0 || first.at >= cutoff) break;
			this.samples.shift();
		}
	}
};
/** Exact final rate when the message permits one, otherwise the last live estimate. */
function computeFinalReading(input) {
	if (input.stopReason === "aborted" || input.stopReason === "error") return null;
	const output = input.usage.output ?? 0;
	if (output > 0) {
		const decodeMs = input.firstDeltaAt === null ? 0 : input.endAt - input.firstDeltaAt;
		const endToEndMs = input.assistantStartAt === null ? 0 : input.endAt - input.assistantStartAt;
		const hiddenReasoning = (input.usage.reasoning ?? 0) > 0 && input.thinkingCharacters === 0;
		if (input.hasToolCall === false && !hiddenReasoning && input.firstDeltaAt !== null && decodeMs >= 200) {
			const reading = exactReading("finalDecode", output, decodeMs);
			if (reading !== null) return reading;
		}
		if (endToEndMs >= 200) {
			const reading = exactReading("finalEndToEnd", output, endToEndMs);
			if (reading !== null) return reading;
		}
	}
	return input.lastLive !== null && input.lastLive > 0 && input.lastLive <= 5e3 ? {
		kind: "finalEstimate",
		value: input.lastLive
	} : null;
}
function exactReading(kind, tokens, elapsedMs) {
	if (!(elapsedMs > 0)) return null;
	const value = tokens * 1e3 / elapsedMs;
	return Number.isFinite(value) && value > 0 && value <= 5e3 ? {
		kind,
		value
	} : null;
}
/**
* Updates the per-model character-to-token factor from a completed, fully observable message.
* Tool-call, hidden-reasoning, and end-to-end fallback messages are excluded because their delta
* windows do not cover the same output the provider counted.
*/
function nextCalibration(current, usageOutput, rawEstimate, reading) {
	if (reading?.kind !== "finalDecode") return current;
	const output = usageOutput ?? 0;
	if (output < 32 || rawEstimate < 32) return current;
	const ratio = output / rawEstimate;
	if (!Number.isFinite(ratio) || ratio < .5 || ratio > 2) return current;
	const next = current * .7 + ratio * CALIBRATION_ALPHA;
	return Math.min(2, Math.max(MIN_CALIBRATION_RATIO, next));
}
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
/** Compact rate formatting: one decimal below ten, whole tokens above it. */
function formatRate(value) {
	if (!Number.isFinite(value) || value < 0) return "--";
	if (value < .05) return "0";
	if (value < 9.95) return value.toFixed(1);
	return String(Math.round(value));
}
/** The TPS value text, marking estimates without hiding a stalled zero. */
function formatRateReading(reading) {
	if (reading === null) return "--";
	const value = formatRate(reading.value);
	return reading.kind === "live" || reading.kind === "finalEstimate" ? reading.value > 0 ? `~${value}` : value : value;
}
/** Produces plain text. Never display data from model output in the footer. */
function formatFooter({ status, reading = null, liveOutput = 0, pendingOutput = 0, lastContext = null } = {}) {
	const tokens = status?.tokens;
	const input = tokens?.input ?? 0;
	const output = Math.max(tokens?.output ?? 0, liveOutput, pendingOutput);
	const cacheRead = tokens?.cacheRead ?? 0;
	const cacheWrite = tokens?.cacheWrite ?? 0;
	const context = status?.contextUsage ?? null;
	const contextWindow = context?.contextWindow ?? 0;
	const contextTokens = context === null ? lastContext ?? null : context.tokens;
	const currentContext = contextTokens === null ? "--" : formatCount(contextTokens);
	const maxContext = contextWindow > 0 ? `/${formatCount(contextWindow)}` : "";
	return `TPS ${formatRateReading(reading)} tok/s${reading?.kind === "finalEndToEnd" ? " avg" : ""}  ·  Ctx ${currentContext}${maxContext}  ·  In ${formatCount(input)}  ·  Out ${formatCount(output)}  ·  Cache R ${formatCount(cacheRead)}  ·  W ${formatCount(cacheWrite)}`;
}
/** Keeps CSS-generated content safe, quoting exactly one CSS string token. */
function cssString(value) {
	return JSON.stringify(value.replace(/[\x00-\x1f\x7f]/gu, " "));
}
// src/pi-web-plugin.ts
var CSS_VALUE = "--pi-tokenline-content";
var CSS_NATIVE_DISPLAY = "--pi-tokenline-native-display";
var UPDATE_INTERVAL_MS = 180;
var TICK_INTERVAL_MS = 250;
var STATUS_REFRESH_DELAY_MS = 100;
var MAX_CALIBRATION_MODELS = 16;
var FRAME_DECODER = new TextDecoder();
/**
* Text of one event frame, or `null` for a payload this transport cannot carry. The host delivers
* JSON text as binary frames (see `host-contract.ts`), so decoding stays synchronous here to keep
* frames in wire order.
*/
function frameText(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return FRAME_DECODER.decode(data);
	if (ArrayBuffer.isView(data)) return FRAME_DECODER.decode(data);
	return null;
}
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
	calibrationByModel = /* @__PURE__ */ new Map();
	version = 0;
	key = "";
	active = false;
	disposed = false;
	status = null;
	statusRevision = 0;
	statusFingerprint = "";
	lastContext = null;
	streaming = false;
	assistantStartAt = null;
	firstDeltaAt = null;
	lastDeltaAt = null;
	thinkingCharacters = 0;
	rawEstimate = 0;
	messageCalibration = 1;
	messageModelKey = null;
	lastFinal = null;
	liveBaseline = 0;
	pendingOutput = 0;
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
		}, TICK_INTERVAL_MS);
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
		this.statusFingerprint = "";
		this.lastContext = null;
		this.rate.clear();
		this.streaming = false;
		this.assistantStartAt = null;
		this.firstDeltaAt = null;
		this.lastDeltaAt = null;
		this.thinkingCharacters = 0;
		this.rawEstimate = 0;
		this.messageCalibration = 1;
		this.messageModelKey = null;
		this.lastFinal = null;
		this.liveBaseline = 0;
		this.pendingOutput = 0;
		this.lastPaintAt = 0;
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
		const now = performance.now();
		const fingerprint = JSON.stringify([
			status.tokens.totalTokens,
			status.tokens.input,
			status.tokens.output,
			status.tokens.cacheRead,
			status.tokens.cacheWrite,
			status.contextUsage?.tokens ?? "none",
			status.contextUsage?.contextWindow ?? 0,
			status.isStreaming,
			status.modelKey
		]);
		const changed = fingerprint !== this.statusFingerprint;
		this.status = status;
		this.statusRevision += 1;
		this.statusFingerprint = fingerprint;
		if (this.pendingOutput <= (status.tokens.output ?? 0)) this.pendingOutput = 0;
		if (!status.isStreaming && this.streaming && this.lastDeltaAt !== null && now - this.lastDeltaAt > 3e3) {
			const lastLive = this.rate.value(now);
			if (this.lastFinal === null && lastLive !== null && lastLive > 0) this.lastFinal = {
				kind: "finalEstimate",
				value: lastLive
			};
			this.streaming = false;
			this.rate.clear();
		}
		this.active = true;
		this.paint(changed);
	}
	connect(version) {
		const urls = this.urls;
		if (this.disposed || this.version !== version || urls === void 0) return;
		const socket = new WebSocket(urls.eventsUrl);
		socket.binaryType = "arraybuffer";
		this.socket = socket;
		socket.onopen = () => {
			if (this.socket !== socket || this.version !== version) return;
			this.retryMs = 500;
			this.scheduleStatusRefresh(version);
		};
		socket.onmessage = (event) => {
			if (this.socket !== socket || this.version !== version) return;
			const frame = frameText(event.data);
			if (frame === null) {
				this.logOnce("Unsupported session event frame", typeof event.data);
				return;
			}
			try {
				const sessionEvent = parseSessionEvent(JSON.parse(frame));
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
			case "agent.start":
				this.streaming = false;
				this.rate.clear();
				this.lastFinal = null;
				this.assistantStartAt = null;
				this.firstDeltaAt = null;
				this.lastDeltaAt = null;
				this.thinkingCharacters = 0;
				this.rawEstimate = 0;
				this.messageModelKey = null;
				this.paint(true);
				break;
			case "assistant.start":
				this.streaming = true;
				this.rate.clear();
				this.lastFinal = null;
				this.assistantStartAt = now;
				this.firstDeltaAt = null;
				this.lastDeltaAt = null;
				this.thinkingCharacters = 0;
				this.rawEstimate = 0;
				this.messageCalibration = 1;
				this.messageModelKey = null;
				this.liveBaseline = Math.max(this.status?.tokens.output ?? 0, this.pendingOutput);
				this.paint(true);
				break;
			case "assistant.delta":
			case "assistant.thinking.delta": {
				if (!this.streaming) {
					this.streaming = true;
					this.rate.clear();
					this.lastFinal = null;
					this.assistantStartAt = null;
					this.firstDeltaAt = null;
					this.lastDeltaAt = null;
					this.thinkingCharacters = 0;
					this.rawEstimate = 0;
					this.messageCalibration = 1;
					this.messageModelKey = null;
					this.liveBaseline = Math.max(this.status?.tokens.output ?? 0, this.pendingOutput);
				}
				if (this.firstDeltaAt === null) {
					this.firstDeltaAt = now;
					this.messageModelKey = this.status?.modelKey ?? null;
					this.messageCalibration = this.calibrationFor(this.messageModelKey);
				}
				const raw = approximateTokens(event.text);
				this.rawEstimate += raw;
				if (event.type === "assistant.thinking.delta") this.thinkingCharacters += event.text.length;
				this.rate.add(raw * this.messageCalibration, now);
				this.lastDeltaAt = now;
				this.paint();
				break;
			}
			case "message.end":
				if (event.message.role === "assistant") this.finishMessage(event.message, now);
				break;
			case "agent.end":
				if (this.streaming) {
					const lastLive = this.rate.value(now);
					if (this.lastFinal === null && lastLive !== null && lastLive > 0) this.lastFinal = {
						kind: "finalEstimate",
						value: lastLive
					};
				}
				this.streaming = false;
				this.rate.clear();
				this.paint(true);
				this.scheduleStatusRefresh(this.version);
				break;
			case "session.tree.changed":
				this.streaming = false;
				this.rate.clear();
				this.lastFinal = null;
				this.assistantStartAt = null;
				this.firstDeltaAt = null;
				this.lastDeltaAt = null;
				this.thinkingCharacters = 0;
				this.rawEstimate = 0;
				this.messageModelKey = null;
				this.pendingOutput = 0;
				this.lastContext = null;
				this.statusFingerprint = "";
				this.restoreNative();
				this.active = false;
				this.scheduleStatusRefresh(this.version);
		}
	}
	/**
	* Replace the live estimate with the exact per-message reading. A tool-call message's usage
	* includes argument tokens the browser never streamed, so the final-rate helper falls back to
	* whole-message time and the footer labels it `avg` rather than pretending it is decode speed.
	*/
	finishMessage(message, now) {
		const usage = message.usage;
		const fromMessage = reportedContext(usage);
		if (fromMessage !== null) this.lastContext = fromMessage;
		const lastLive = this.rate.value(now);
		const final = computeFinalReading({
			usage,
			stopReason: message.stopReason,
			hasToolCall: message.hasToolCall,
			assistantStartAt: this.assistantStartAt,
			firstDeltaAt: this.firstDeltaAt,
			endAt: now,
			thinkingCharacters: this.thinkingCharacters,
			lastLive
		});
		if (final !== null) this.lastFinal = final;
		const modelKey = this.messageModelKey ?? this.status?.modelKey ?? null;
		if (modelKey !== null) {
			const current = this.calibrationByModel.get(modelKey) ?? 1;
			this.calibrationByModel.set(modelKey, nextCalibration(current, usage.output, this.rawEstimate, final));
			this.trimCalibrations();
		}
		this.pendingOutput = Math.max(this.pendingOutput, this.liveBaseline + (usage.output ?? this.rate.total));
		this.streaming = false;
		this.rate.clear();
		this.assistantStartAt = null;
		this.firstDeltaAt = null;
		this.lastDeltaAt = null;
		this.thinkingCharacters = 0;
		this.rawEstimate = 0;
		this.messageModelKey = null;
		this.paint(true);
		this.scheduleStatusRefresh(this.version);
	}
	calibrationFor(modelKey) {
		return modelKey === null ? 1 : this.calibrationByModel.get(modelKey) ?? 1;
	}
	trimCalibrations() {
		while (this.calibrationByModel.size > MAX_CALIBRATION_MODELS) {
			const oldest = this.calibrationByModel.keys().next().value;
			if (oldest === void 0) break;
			this.calibrationByModel.delete(oldest);
		}
	}
	paint(force = false) {
		const status = this.status;
		if (!this.active || status === null || this.key.length === 0) return;
		const now = performance.now();
		if (!force && now - this.lastPaintAt < UPDATE_INTERVAL_MS) return;
		this.lastPaintAt = now;
		const liveOutput = this.streaming ? this.liveBaseline + this.rate.total : 0;
		const live = this.streaming ? this.rate.value(now) : null;
		const line = formatFooter({
			status,
			reading: live === null ? this.lastFinal : {
				kind: "live",
				value: live
			},
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
		this.calibrationByModel.clear();
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
