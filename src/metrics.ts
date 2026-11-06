/**
 * Pure model for the PI WEB live TPS footer.
 *
 * Live text and thinking deltas only carry characters, so the live rate is an estimate until a
 * completed message reports provider usage. The live window therefore uses a conservative
 * character estimate, excludes the first chunk (the meter never saw how long it took to generate),
 * and caps burst credit. The final reading replaces it with an exact per-message rate: decode time
 * when the message is fully observable, otherwise the whole assistant-message wall clock.
 */

import type { SessionStatus, UsageTotals } from "./host-contract.ts";

/** Trailing window for the live rate. Long enough to smooth bursts, short enough to react. */
export const RATE_WINDOW_MS = 3000;
/** Minimum history and denominator. Prevents a single buffered flush from defining a rate. */
export const MIN_RATE_SPAN_MS = 1000;
/** A stream with no token for this long is stalled, not slow. */
export const IDLE_RATE_MS = 3000;
/** A single interval may credit at most this multiple of the stream's own raw pace. */
export const BURST_TOLERANCE = 2;
/** Credit floor while a window has no pace of its own yet, in tokens per second. */
export const MIN_CREDIT_TPS = 100;
/** Faster than any production model streams; anything above is a delivery artifact. */
export const MAX_PLAUSIBLE_TPS = 5000;
/** Shortest final measurement window; anything shorter is noise. */
export const MIN_FINAL_WINDOW_MS = 200;
/** A calibration sample must carry enough tokens to mean something. */
export const MIN_CALIBRATION_TOKENS = 32;
/** Accepted provider/estimate ratio; outside this the two sides count different things. */
export const MIN_CALIBRATION_RATIO = 0.5;
export const MAX_CALIBRATION_RATIO = 2;
const CALIBRATION_ALPHA = 0.3;

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Estimates generated tokens from streamed text; never a provider-reported count. */
export function approximateTokens(text: string): number {
    if (text.length === 0) return 0;
    // English and code average about four bytes per token; most CJK glyphs are one token each.
    // Iterating code points instead of UTF-16 units keeps surrogate pairs (emoji) intact.
    let cjk = 0;
    let otherBytes = 0;
    for (const character of text) {
        if (CJK_PATTERN.test(character)) {
            cjk += 1;
            continue;
        }
        const codePoint = character.codePointAt(0) ?? 0;
        otherBytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    }
    return cjk + otherBytes / 4;
}

interface RateSample {
    readonly at: number;
    /** Cumulative rated raw tokens at this checkpoint. */
    raw: number;
    /** Cumulative burst-guarded tokens at this checkpoint; the rate uses this scale. */
    credited: number;
}

/**
 * Trailing-window throughput with a first-chunk baseline and burst credit.
 *
 * The first delta only opens the window: its generation time happened before the meter could
 * observe it, so crediting it would either inflate a buffered chunk or dilute the rate with TTFT.
 * Every later interval credits at most a plausible multiple of the window's own raw pace. `total`
 * remains the full estimate so the output counter never loses tokens.
 */
export class RateWindow {
    readonly windowMs: number;
    private samples: RateSample[] = [];
    private rawTotal = 0;
    private creditedTotal = 0;
    private lastTokenAt: number | null = null;

    constructor(windowMs = RATE_WINDOW_MS) {
        this.windowMs = windowMs;
    }

    /** Full estimated output for the current message, including uncredited burst tokens. */
    get total(): number {
        return this.rawTotal;
    }

    clear(): void {
        this.samples = [];
        this.rawTotal = 0;
        this.creditedTotal = 0;
        this.lastTokenAt = null;
    }

    add(delta: number, now: number): void {
        if (!(delta > 0) || !Number.isFinite(delta) || !Number.isFinite(now)) return;
        const last = this.samples[this.samples.length - 1];
        if (last === undefined) {
            this.rawTotal = delta;
            this.creditedTotal = delta;
            this.lastTokenAt = now;
            this.samples.push({
                at: now,
                raw: delta,
                credited: delta,
            });
            return;
        }
        // A timestamp that does not move cannot define a rate. Count it in the output total and
        // drop it from the window instead of letting a same-millisecond burst raise the pace.
        if (now <= last.at) {
            this.rawTotal += delta;
            return;
        }
        const elapsed = now - last.at;
        const rawPace = this.rawRate(now);
        const ceiling = Math.max(MIN_CREDIT_TPS, (rawPace ?? 0) * BURST_TOLERANCE);
        const credit = Math.min(delta, (ceiling * elapsed) / 1000);
        this.rawTotal += delta;
        this.creditedTotal += credit;
        this.lastTokenAt = now;
        this.samples.push({
            at: now,
            raw: last.raw + delta,
            credited: this.creditedTotal,
        });
        this.prune(now);
    }

    value(now: number): number | null {
        if (this.samples.length === 0 || this.lastTokenAt === null) return null;
        const at = Math.max(now, this.lastTokenAt);
        if (at - this.lastTokenAt > IDLE_RATE_MS) return 0;
        this.prune(at);
        const baseline = this.baselineAt(at);
        if (baseline === null) return null;
        const span = at - baseline.at;
        if (span < MIN_RATE_SPAN_MS) return null;
        const generated = this.creditedTotal - baseline.credited;
        if (generated <= 0) return null;
        const rate = (generated * 1000) / span;
        if (!Number.isFinite(rate) || rate > MAX_PLAUSIBLE_TPS) return null;
        return Math.max(0, rate);
    }

    /** The oldest checkpoint still inside the trailing window. */
    private baselineAt(now: number): RateSample | null {
        const cutoff = now - this.windowMs;
        for (const sample of this.samples) {
            if (sample.at >= cutoff) return sample;
        }
        return null;
    }

    private rawRate(now: number): number | null {
        const current = this.samples[this.samples.length - 1];
        if (current === undefined) return null;
        const baseline = this.baselineAt(now);
        if (baseline === null) return null;
        const span = now - baseline.at;
        if (span < MIN_RATE_SPAN_MS) return null;
        const generated = current.raw - baseline.raw;
        if (generated <= 0) return null;
        const rate = (generated * 1000) / span;
        return Number.isFinite(rate) ? rate : null;
    }

    private prune(now: number): void {
        const cutoff = now - this.windowMs;
        while (this.samples.length > 1) {
            const first = this.samples[0];
            if (first === undefined || first.at >= cutoff) break;
            this.samples.shift();
        }
    }
}

/** Where one displayed rate came from. */
export type RateKind = "live" | "finalDecode" | "finalEndToEnd" | "finalEstimate";

export interface RateReading {
    readonly kind: RateKind;
    readonly value: number;
}

export interface FinalReadingInput {
    readonly usage: UsageTotals;
    readonly stopReason: string | undefined;
    readonly hasToolCall: boolean | null;
    readonly assistantStartAt: number | null;
    readonly firstDeltaAt: number | null;
    readonly endAt: number;
    /** Characters streamed as thinking; zero means any reported reasoning was not observed. */
    readonly thinkingCharacters: number;
    readonly lastLive: number | null;
}

/** Exact final rate when the message permits one, otherwise the last live estimate. */
export function computeFinalReading(input: FinalReadingInput): RateReading | null {
    // An interrupted or failed response is not a sustained reading.
    if (input.stopReason === "aborted" || input.stopReason === "error") return null;
    const output = input.usage.output ?? 0;
    if (output > 0) {
        const decodeMs = input.firstDeltaAt === null ? 0 : input.endAt - input.firstDeltaAt;
        const endToEndMs =
            input.assistantStartAt === null ? 0 : input.endAt - input.assistantStartAt;
        const hiddenReasoning = (input.usage.reasoning ?? 0) > 0 && input.thinkingCharacters === 0;
        const observable =
            input.hasToolCall === false && !hiddenReasoning && input.firstDeltaAt !== null;
        if (observable && decodeMs >= MIN_FINAL_WINDOW_MS) {
            const reading = exactReading("finalDecode", output, decodeMs);
            if (reading !== null) return reading;
        }
        if (endToEndMs >= MIN_FINAL_WINDOW_MS) {
            const reading = exactReading("finalEndToEnd", output, endToEndMs);
            if (reading !== null) return reading;
        }
    }
    return input.lastLive !== null && input.lastLive > 0 && input.lastLive <= MAX_PLAUSIBLE_TPS
        ? {
              kind: "finalEstimate",
              value: input.lastLive,
          }
        : null;
}

function exactReading(
    kind: "finalDecode" | "finalEndToEnd",
    tokens: number,
    elapsedMs: number,
): RateReading | null {
    if (!(elapsedMs > 0)) return null;
    const value = (tokens * 1000) / elapsedMs;
    return Number.isFinite(value) && value > 0 && value <= MAX_PLAUSIBLE_TPS
        ? {
              kind,
              value,
          }
        : null;
}

/**
 * Updates the per-model character-to-token factor from a completed, fully observable message.
 * Tool-call, hidden-reasoning, and end-to-end fallback messages are excluded because their delta
 * windows do not cover the same output the provider counted.
 */
export function nextCalibration(
    current: number,
    usageOutput: number | undefined,
    rawEstimate: number,
    reading: RateReading | null,
): number {
    if (reading?.kind !== "finalDecode") return current;
    const output = usageOutput ?? 0;
    if (output < MIN_CALIBRATION_TOKENS || rawEstimate < MIN_CALIBRATION_TOKENS) return current;
    const ratio = output / rawEstimate;
    if (!Number.isFinite(ratio) || ratio < MIN_CALIBRATION_RATIO || ratio > MAX_CALIBRATION_RATIO) {
        return current;
    }
    const next = current * (1 - CALIBRATION_ALPHA) + ratio * CALIBRATION_ALPHA;
    return Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, next));
}

/** Best available context size for one completed request, or `null` when none is reported. */
export function reportedContext(usage: UsageTotals | null | undefined): number | null {
    if (usage === null || usage === undefined) return null;
    const total = usage.totalTokens ?? 0;
    if (total > 0) return total;
    const sum =
        (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    return sum > 0 ? sum : null;
}

export function formatCount(count: number): string {
    if (count < 1000) return String(Math.round(count));
    const scale = count >= 1_000_000 ? 1_000_000 : 1000;
    const suffix = scale === 1_000_000 ? "M" : "K";
    const value = count / scale;
    const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value
        .toFixed(digits)
        .replace(/(\.\d*?)0+$/u, "$1")
        .replace(/\.$/u, "")}${suffix}`;
}

/** Compact rate formatting: one decimal below ten, whole tokens above it. */
export function formatRate(value: number): string {
    if (!Number.isFinite(value) || value < 0) return "--";
    if (value < 0.05) return "0";
    if (value < 9.95) return value.toFixed(1);
    return String(Math.round(value));
}

/** The TPS value text, marking estimates without hiding a stalled zero. */
function formatRateReading(reading: RateReading | null): string {
    if (reading === null) return "--";
    const value = formatRate(reading.value);
    return reading.kind === "live" || reading.kind === "finalEstimate"
        ? reading.value > 0
            ? `~${value}`
            : value
        : value;
}

export interface FooterInput {
    readonly status?: SessionStatus | null;
    /** The selected live or final reading; `null` before anything is measurable. */
    readonly reading?: RateReading | null;
    /** Output tokens generated during the current assistant turn. */
    readonly liveOutput?: number;
    /** Output tokens estimated for a turn the host has not counted yet. */
    readonly pendingOutput?: number;
    /** Context size from the last completed request, when the host status omits it. */
    readonly lastContext?: number | null;
}

/** Produces plain text. Never display data from model output in the footer. */
export function formatFooter({
    status,
    reading = null,
    liveOutput = 0,
    pendingOutput = 0,
    lastContext = null,
}: FooterInput = {}): string {
    const tokens = status?.tokens;
    const input = tokens?.input ?? 0;
    const output = Math.max(tokens?.output ?? 0, liveOutput, pendingOutput);
    const cacheRead = tokens?.cacheRead ?? 0;
    const cacheWrite = tokens?.cacheWrite ?? 0;
    const context = status?.contextUsage ?? null;
    const contextWindow = context?.contextWindow ?? 0;
    // `null` is meaningful: PI WEB deliberately reports unknown after compaction.
    // A host status that omits context accounting entirely falls back to the last completed
    // request; a counter the host did report always wins over that derived value.
    const contextTokens = context === null ? (lastContext ?? null) : context.tokens;
    const currentContext = contextTokens === null ? "--" : formatCount(contextTokens);
    const maxContext = contextWindow > 0 ? `/${formatCount(contextWindow)}` : "";
    const rateText = formatRateReading(reading);
    const rateSuffix = reading?.kind === "finalEndToEnd" ? " avg" : "";
    return `TPS ${rateText} tok/s${rateSuffix}  ·  Ctx ${currentContext}${maxContext}  ·  In ${formatCount(input)}  ·  Out ${formatCount(output)}  ·  Cache R ${formatCount(cacheRead)}  ·  W ${formatCount(cacheWrite)}`;
}

/** Keeps CSS-generated content safe, quoting exactly one CSS string token. */
export function cssString(value: string): string {
    return JSON.stringify(value.replace(/[\x00-\x1f\x7f]/gu, " "));
}
