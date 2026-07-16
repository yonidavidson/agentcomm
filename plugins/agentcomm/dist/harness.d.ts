import { Bus } from './bus.js';
import { createBackend } from './backends/index.js';
/** Consent gate: act only where the repo opted in (AGENTCOMM_BACKEND, or a marked CLAUDE.md/AGENTS.md). */
export declare function onTheBus(cwd: string): Promise<boolean>;
export interface BusSession {
    bus: Bus;
    backend: Awaited<ReturnType<typeof createBackend>>;
    alias: string;
    busUri: string;
    /** The repo the session runs in — where the .agentcomm (telemetry) config lives. */
    cwd: string;
    close(): Promise<void>;
}
/** Open the bus for `cwd` and resolve this session's alias. Returns null if off-bus or on any error. */
export declare function openBusSession(cwd: string): Promise<BusSession | null>;
/** Register (heartbeat) + build the session-start briefing the model should see. */
export declare function sessionStartContext(s: BusSession): Promise<string | null>;
/** Inbox guard: non-consuming peek → a reason string when unread mail exists, else null. */
export declare function inboxGuardReason(s: BusSession): Promise<string | null>;
/** Mid-turn digest: register (heartbeat) + surface only actionable signals (unread mail, active asks). */
export declare function midTurnContext(s: BusSession): Promise<string | null>;
//# sourceMappingURL=harness.d.ts.map