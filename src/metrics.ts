/**
 * Pure model for the PI WEB live TPS footer.
 *
 * TPS is an approximation while text and thinking deltas stream. Usage totals and context-window
 * accounting come from the host's authoritative session status, narrowed at the boundary in
 * `host-contract.ts`.
 */

import type { SessionStatus, UsageTotals } from "./host-contract.ts";

export const RATE_WINDOW_MS = 2500;

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
    readonly total: number;
}

/** Trailing-window throughput that includes idle gaps instead of inflating bursts. */
export class RateWindow {
    readonly windowMs: number;
    total = 0;
    private samples: RateSample[] = [];
    private startedAt: number | null = null;
    private lastTokenAt: number | null = null;

    constructor(windowMs = RATE_WINDOW_MS) {
        this.windowMs = windowMs;
    }

    clear(): void {
        this.samples = [];
        this.total = 0;
        this.startedAt = null;
        this.lastTokenAt = null;
    }

    start(now: number): void {
        this.clear();
        this.startedAt = now;
        this.samples.push({
            at: now,
            total: 0,
        });
    }

    add(delta: number, now: number): void {
        if (this.startedAt === null) this.start(now);
        if (!(delta > 0)) return;
        this.total += delta;
        this.lastTokenAt = now;
        this.samples.push({
            at: now,
            total: this.total,
        });
        this.prune(now);
    }

    private prune(now: number): void {
        const cutoff = now - this.windowMs;
        // Keep one predecessor, so the first delta inside the window is counted.
        while (this.samples.length > 2) {
            const second = this.samples[1];
            if (second === undefined || second.at >= cutoff) break;
            this.samples.shift();
        }
    }

    value(now: number): number | null {
        if (this.startedAt === null || this.lastTokenAt === null) return null;
        if (now - this.lastTokenAt > this.windowMs) return 0;
        this.prune(now);
        const cutoff = Math.max(this.startedAt, now - this.windowMs);
        const first = this.samples[0];
        if (first === undefined) return null;
        let before = first;
        for (const sample of this.samples) {
            if (sample.at >= cutoff) break;
            before = sample;
        }
        const generated = this.total - before.total;
        // A lone burst after a long quiet gap should include the whole gap in its measured
        // throughput, not pretend it arrived within a fraction of a second.
        const elapsed = Math.max(600, now - before.at);
        return Math.max(0, (generated * 1000) / elapsed);
    }
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

export interface FooterInput {
    readonly status?: SessionStatus | null;
    /** Tokens per second, or `null` when no sample is available yet. */
    readonly rate?: number | null;
    readonly streaming?: boolean;
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
    rate = null,
    streaming = false,
    liveOutput = 0,
    pendingOutput = 0,
    lastContext = null,
}: FooterInput = {}): string {
    const tokens = status?.tokens;
    const input = tokens?.input ?? 0;
    const output = Math.max(tokens?.output ?? 0, liveOutput, pendingOutput);
    const cacheRead = tokens?.cacheRead ?? 0;
    const cacheWrite = tokens?.cacheWrite ?? 0;
    const context = status?.contextUsage;
    const contextWindow = context?.contextWindow ?? 0;
    // `null` is meaningful: PI WEB deliberately reports unknown after compaction.
    const contextTokens =
        context?.tokens === null ? null : (lastContext ?? context?.tokens ?? null);
    const currentContext = contextTokens === null ? "--" : formatCount(contextTokens);
    const maxContext = contextWindow > 0 ? `/${formatCount(contextWindow)}` : "";
    const rateText = streaming ? (rate === null ? "--" : Math.min(rate, 9999).toFixed(1)) : "--";
    return `TPS ${rateText} tok/s  ·  Ctx ${currentContext}${maxContext}  ·  In ${formatCount(input)}  ·  Out ${formatCount(output)}  ·  Cache R ${formatCount(cacheRead)}  ·  W ${formatCount(cacheWrite)}`;
}

/** Keeps CSS-generated content safe, quoting exactly one CSS string token. */
export function cssString(value: string): string {
    return JSON.stringify(value.replace(/[\x00-\x1f\x7f]/gu, " "));
}
