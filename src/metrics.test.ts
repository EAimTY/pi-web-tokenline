import { expect, test } from "vitest";
import type { SessionStatus } from "./host-contract.ts";
import {
    approximateTokens,
    cssString,
    formatCount,
    formatFooter,
    RateWindow,
    reportedContext,
} from "./metrics.ts";

test("token estimation handles Latin, CJK, and empty text", () => {
    expect(approximateTokens("")).toBe(0);
    expect(approximateTokens("abcdefgh")).toBe(2);
    // Han, kana, and Hangul count as one token per code point.
    expect(approximateTokens("你好世界")).toBe(4);
    expect(approximateTokens("汉abc")).toBe(1.75);
});

test("windowed TPS decays to zero after a stall and clamps bursts", () => {
    const rate = new RateWindow(2500);
    rate.start(1000);
    rate.add(40, 1500);
    rate.add(40, 2000);
    const measured = rate.value(2000) ?? 0;
    expect(measured).toBeGreaterThan(60);
    expect(measured).toBeLessThan(90);
    expect(rate.value(6000)).toBe(0);
    const burst = new RateWindow(2500);
    burst.start(0);
    burst.add(40, 10000);
    // A buffered burst must include the preceding stall in its elapsed time.
    expect(burst.value(10000) ?? 0).toBeLessThanOrEqual(5);
});

test("usage context prefers the reported total and falls back to the sum", () => {
    expect(
        reportedContext({
            totalTokens: 987,
            input: 1,
        }),
    ).toBe(987);
    expect(
        reportedContext({
            input: 5,
            output: 3,
            cacheRead: 10,
            cacheWrite: 2,
        }),
    ).toBe(20);
    expect(
        reportedContext({
            input: 0,
            output: 0,
        }),
    ).toBeNull();
    expect(reportedContext(null)).toBeNull();
});

test("counts and footer preserve zero values and unknown context after compaction", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1700)).toBe("1.7K");
    expect(formatCount(1_500_000)).toBe("1.5M");
    const status: SessionStatus = {
        tokens: {
            input: 120,
            output: 56,
            cacheRead: 22000,
            cacheWrite: 0,
        },
        contextUsage: {
            tokens: 50600,
            contextWindow: 272000,
        },
        isStreaming: false,
    };
    const displayed = formatFooter({
        status,
        rate: 68.25,
        streaming: true,
        liveOutput: 70,
    });
    expect(displayed).toMatch(/TPS 68\.3 tok\/s/u);
    expect(displayed).toMatch(/Ctx 50\.6K\/272K/u);
    expect(displayed).toMatch(/Out 70/u);
    expect(displayed).toMatch(/Cache R 22K/u);
    expect(displayed).toMatch(/W 0/u);
    expect(displayed).not.toMatch(/Cost|\$/u);
    const compacted: SessionStatus = {
        ...status,
        contextUsage: {
            tokens: null,
            contextWindow: 272000,
        },
    };
    expect(
        formatFooter({
            status: compacted,
            lastContext: 50600,
        }),
    ).toMatch(/Ctx --\/272K/u);
});

test("cssString escapes control codes and quotes", () => {
    expect(cssString('a"b\nc')).toBe('"a\\"b c"');
});
