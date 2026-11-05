import { defineConfig } from "vitest/config";

// The plugin is browser code, but the suite runs in Node. A module under test reaches
// browser globals only through the minimal host stubs its own test installs with
// `vi.stubGlobal` — never through a DOM or WebGL environment.
export default defineConfig({
    test: {
        environment: "node",
        include: [
            "src/**/*.test.ts",
        ],
    },
});
