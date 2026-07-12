import { openBusSession, sessionStartContext, inboxGuardReason, midTurnContext } from './index.js';
export const AgentcommPlugin = async ({ directory, client }) => {
    // Context the bus wants the model to see on its next turn (OpenCode pulls
    // system-prompt additions via system.transform rather than us pushing).
    const pending = [];
    let session = null;
    // OpenCode calls the factory per project with the directory; register + brief
    // here since `session.created` never fires in `run` mode.
    try {
        session = await openBusSession(directory);
        if (session) {
            const ctx = await sessionStartContext(session);
            if (ctx)
                pending.push(ctx);
        }
    }
    catch {
        /* fail open */
    }
    return {
        async event({ event }) {
            if (!session || event.type !== 'session.idle')
                return;
            try {
                const reason = await inboxGuardReason(session);
                if (reason) {
                    // Can't veto idle — re-engage the session with the guard's reason.
                    const sessionID = event.properties?.sessionID;
                    if (sessionID) {
                        await client.session
                            .prompt({ path: { id: sessionID }, body: { parts: [{ type: 'text', text: reason }] } })
                            .catch(() => { });
                    }
                }
            }
            catch {
                /* fail open */
            }
        },
        async 'tool.execute.after'() {
            if (!session)
                return;
            try {
                const ctx = await midTurnContext(session);
                if (ctx)
                    pending.push(ctx);
            }
            catch {
                /* fail open */
            }
        },
        async 'experimental.chat.system.transform'(_input, output) {
            if (pending.length)
                output.system.push(...pending.splice(0));
        },
        async dispose() {
            await session?.close().catch(() => { });
        },
    };
};
export default AgentcommPlugin;
//# sourceMappingURL=opencode-plugin.js.map