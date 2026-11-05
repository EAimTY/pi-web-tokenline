/**
 * The subset of PI WEB's public browser plugin contract this package implements.
 *
 * Mirrors `@jmfederico/pi-web@1.202611.0` (`dist/plugin-api.d.ts`, entrypoint
 * `@jmfederico/pi-web/plugin-api`). The host package ships its whole web application, so a
 * type-only dependency would install Fastify, Lit, CodeMirror, xterm, and the Pi peer packages
 * for a plugin that touches three host types. Keep this file aligned with the host version
 * above whenever the plugin adopts a newer contract.
 */

export type MachineKind = "local" | "remote";

/** A machine registered with the host. `id` is the routing key used by session URLs. */
export interface PluginMachine {
    readonly id: string;
    readonly name: string;
    readonly kind: MachineKind;
}

/** Selected conversation snapshot. `pending` is true while session creation is unfinished. */
export interface PluginSelectedSession {
    readonly id: string;
    /** Workspace working directory. */
    readonly cwd: string;
    readonly name?: string;
    readonly archived: boolean;
    readonly pending: boolean;
}

export interface PluginSelectionSnapshot {
    readonly selectedMachine?: Readonly<PluginMachine>;
    readonly selectedSession?: Readonly<PluginSelectedSession>;
}

export interface PluginSelectionService {
    /** Read a fresh, detached snapshot synchronously. */
    getSnapshot(): PluginSelectionSnapshot;
    /** Notify after the host commits a selection change; does not call immediately. */
    subscribe(listener: (snapshot: PluginSelectionSnapshot) => void | Promise<void>): () => void;
}

/** A CSS file served from the package's `browserRoot`. */
export interface StylesheetContribution {
    id: string;
    /** Absolute HTTP(S) URL. Assets resolve relative to the CSS file. */
    url: string;
    /** Lower numbers load first; default 1000. Ties use qualified contribution IDs. */
    order?: number;
}

export interface PluginContributionsV5 {
    stylesheets?: StylesheetContribution[];
}

export interface PluginActivationContextV5 {
    readonly apiVersion: 5;
    /** Stable package/source identity, including on federated machines. */
    readonly pluginId: string;
    /** Host-unique identity for qualified contribution references in this runtime. */
    readonly runtimePluginId: string;
    /** Signal for this bounded activation invocation, not the plugin lifetime. */
    readonly signal: AbortSignal;
    /** Aborted before failed-start rollback or browser-host shutdown disposal. */
    readonly lifetimeSignal: AbortSignal;
    /** Current browser selection, independent of panel mounting. Omitted by older hosts. */
    readonly selection?: PluginSelectionService;
}

export interface PluginStartContext {
    /** Signal for this bounded start invocation, not the plugin lifetime. */
    readonly signal: AbortSignal;
}

export interface PluginActivationResultV5 {
    readonly contributions: PluginContributionsV5;
    /** Initialize resources after every declared capability requirement is active. */
    start?(context: PluginStartContext): void | Promise<void>;
    /** Release resources within one host-bounded disposal invocation. */
    dispose?(signal: AbortSignal): void | Promise<void>;
}

/** Current browser entrypoint. */
export interface PiWebPluginV5 {
    readonly apiVersion: 5;
    readonly name: string;
    activate(
        context: PluginActivationContextV5,
    ): PluginActivationResultV5 | Promise<PluginActivationResultV5>;
}
