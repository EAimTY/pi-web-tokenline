import { expect, test } from "vitest";
import type { SessionStatus } from "./host-contract.ts";
import {
    approximateTokens,
    computeFinalReading,
    cssString,
    formatCount,
    formatFooter,
    formatRate,
    nextCalibration,
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

test("the first chunk only opens the rate window", () => {
    const rate = new RateWindow();
    rate.add(1000, 0);
    rate.add(1000, 0);
    expect(rate.value(0)).toBeNull();
    expect(rate.value(1000)).toBeNull();
    // The output counter still receives every estimated token, even a same-millisecond burst.
    expect(rate.total).toBe(2000);
});

test("the live rate starts at the first token, not at message start", () => {
    const rate = new RateWindow();
    rate.add(10, 2000);
    rate.add(10, 2100);
    // A full second of history is required before a rate is published.
    expect(rate.value(2100)).toBeNull();
    rate.add(80, 3000);
    const measured = rate.value(3000);
    expect(measured).not.toBeNull();
    expect(measured ?? 0).toBeGreaterThan(80);
    expect(measured ?? 0).toBeLessThan(100);
});

test("a buffered burst is credited at a plausible pace, not at its arrival speed", () => {
    const rate = new RateWindow();
    rate.add(1, 0);
    rate.add(1000, 1000);
    const measured = rate.value(1000);
    expect(measured).not.toBeNull();
    expect(measured ?? 0).toBeCloseTo(100, 5);
    expect(rate.total).toBe(1001);
});

test("a burst after a paced stream is capped by the recent pace", () => {
    const rate = new RateWindow();
    rate.add(1, 0);
    rate.add(10, 1000);
    rate.add(1000, 1002);
    expect(rate.value(1002) ?? 0).toBeLessThan(20);
});

test("a genuinely fast stream reaches its real pace after the window turns over", () => {
    const rate = new RateWindow();
    rate.add(1, 0);
    for (let at = 100; at <= 4000; at += 100) rate.add(50, at);
    const measured = rate.value(4000);
    expect(measured).not.toBeNull();
    expect(measured ?? 0).toBeGreaterThan(400);
    expect(measured ?? 0).toBeLessThanOrEqual(500);
});

test("implausible rates are refused rather than clamped", () => {
    const rate = new RateWindow();
    rate.add(1, 0);
    for (let at = 100; at <= 2000; at += 100) rate.add(2000, at);
    expect(rate.value(2000)).toBeNull();
});

test("a stalled stream decays to zero instead of freezing its last value", () => {
    const rate = new RateWindow();
    rate.add(1, 0);
    rate.add(100, 1000);
    expect(rate.value(1000) ?? 0).toBeCloseTo(100, 5);
    expect(rate.value(4001)).toBe(0);
});

test("final readings choose decode or end-to-end time by what the message proves", () => {
    const base = {
        usage: {
            output: 100,
        },
        stopReason: "stop",
        hasToolCall: false,
        assistantStartAt: 0,
        firstDeltaAt: 1000,
        endAt: 3000,
        thinkingCharacters: 10,
        lastLive: null,
    } as const;
    expect(computeFinalReading(base)).toEqual({
        kind: "finalDecode",
        value: 50,
    });
    expect(
        computeFinalReading({
            ...base,
            hasToolCall: true,
        }),
    ).toEqual({
        kind: "finalEndToEnd",
        value: 100 / 3,
    });
    expect(
        computeFinalReading({
            ...base,
            hasToolCall: null,
        }),
    ).toEqual({
        kind: "finalEndToEnd",
        value: 100 / 3,
    });
    // Reasoning that never streamed cannot be timed from the first visible token.
    expect(
        computeFinalReading({
            ...base,
            usage: {
                output: 100,
                reasoning: 20,
            },
            thinkingCharacters: 0,
        }),
    ).toEqual({
        kind: "finalEndToEnd",
        value: 100 / 3,
    });
    // A buffered response has no usable decode window, so it falls back to whole-message time.
    expect(
        computeFinalReading({
            ...base,
            firstDeltaAt: 3000,
            assistantStartAt: 2000,
        }),
    ).toEqual({
        kind: "finalEndToEnd",
        value: 100,
    });
});

test("final readings reject interrupted or unmeasurable messages and fall back to live", () => {
    const base = {
        usage: {
            output: 100,
        },
        stopReason: "stop",
        hasToolCall: false,
        assistantStartAt: 0,
        firstDeltaAt: 1000,
        endAt: 3000,
        thinkingCharacters: 10,
        lastLive: null,
    } as const;
    expect(
        computeFinalReading({
            ...base,
            stopReason: "aborted",
        }),
    ).toBeNull();
    expect(
        computeFinalReading({
            ...base,
            stopReason: "error",
        }),
    ).toBeNull();
    expect(
        computeFinalReading({
            ...base,
            usage: {},
            lastLive: 42,
        }),
    ).toEqual({
        kind: "finalEstimate",
        value: 42,
    });
    expect(
        computeFinalReading({
            ...base,
            firstDeltaAt: 2950,
            endAt: 3000,
            assistantStartAt: 2950,
        }),
    ).toBeNull();
});

test("calibration learns only from fully observable messages", () => {
    expect(
        nextCalibration(1, 120, 100, {
            kind: "finalDecode",
            value: 50,
        }),
    ).toBeCloseTo(1.06, 5);
    expect(
        nextCalibration(1, 120, 100, {
            kind: "finalEndToEnd",
            value: 50,
        }),
    ).toBe(1);
    expect(
        nextCalibration(1, 500, 100, {
            kind: "finalDecode",
            value: 50,
        }),
    ).toBe(1);
    expect(
        nextCalibration(1, 120, 10, {
            kind: "finalDecode",
            value: 50,
        }),
    ).toBe(1);
    expect(
        nextCalibration(1.9, 200, 100, {
            kind: "finalDecode",
            value: 50,
        }),
    ).toBeCloseTo(1.93, 5);
});

test("rate formatting stays compact across magnitudes", () => {
    expect(formatRate(0)).toBe("0");
    expect(formatRate(8.25)).toBe("8.3");
    expect(formatRate(9.96)).toBe("10");
    expect(formatRate(68.25)).toBe("68");
    expect(formatRate(1234.5)).toBe("1235");
    expect(formatRate(Number.NaN)).toBe("--");
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
    modelKey: null,
};

test("counts and footer preserve zero values and unknown context after compaction", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1700)).toBe("1.7K");
    expect(formatCount(1_500_000)).toBe("1.5M");
    const displayed = formatFooter({
        status,
        reading: {
            kind: "live",
            value: 68.25,
        },
        liveOutput: 70,
        lastContext: 90000,
    });
    expect(displayed).toMatch(/TPS ~68 tok\/s/u);
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
    // A status without context accounting is the only case that falls back to completed usage.
    expect(
        formatFooter({
            status: {
                ...status,
                contextUsage: null,
            },
            lastContext: 50600,
        }),
    ).toContain("Ctx 50.6K  ·");
});

test("footer marks live, decode, end-to-end, and missing readings differently", () => {
    expect(
        formatFooter({
            status,
            reading: {
                kind: "live",
                value: 8.25,
            },
        }),
    ).toMatch(/TPS ~8\.3 tok\/s/u);
    expect(
        formatFooter({
            status,
            reading: {
                kind: "live",
                value: 0,
            },
        }),
    ).toMatch(/TPS 0 tok\/s/u);
    expect(
        formatFooter({
            status,
            reading: {
                kind: "finalDecode",
                value: 68.25,
            },
        }),
    ).toMatch(/TPS 68 tok\/s/u);
    expect(
        formatFooter({
            status,
            reading: {
                kind: "finalEndToEnd",
                value: 41.25,
            },
        }),
    ).toMatch(/TPS 41 tok\/s avg/u);
    expect(
        formatFooter({
            status,
            reading: {
                kind: "finalEstimate",
                value: 41.25,
            },
        }),
    ).toMatch(/TPS ~41 tok\/s/u);
    expect(
        formatFooter({
            status,
            reading: null,
        }),
    ).toMatch(/TPS -- tok\/s/u);
});

test("cssString escapes control codes and quotes", () => {
    expect(cssString('a"b\nc')).toBe('"a\\"b c"');
});
