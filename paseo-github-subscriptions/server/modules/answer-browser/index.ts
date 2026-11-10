import * as browserRpc from '../../../shared/browser-contracts.ts';
import { webRequestAudit } from '../../../shared/web-request.ts';
import { registerBrowserUsage } from '../../browser-usage.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

/** 网页版 claude.ai：浏览器扩展桥接、网页提问、`claude-browser` 额度来源。 */
export const browserModule: Module = {
  id: 'answer.browser',
  label: '网页版 claude.ai',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const { server } = context;
    const services = mainOf(context);
    const ready = () => services.readyBrowser();
    void ready().catch(() => {});
    const usageStore = registerBrowserUsage(server, ready, context.stateDirectory);
    server.handle(browserRpc.browserSnapshot, async () => (await ready()).snapshot());
    server.handle(browserRpc.browserConfigure, async input => (await ready()).configure(input));
    server.handle(browserRpc.browserBind, async input => (await ready()).bind(input));
    server.handle(browserRpc.browserPairing, async () => (await ready()).pairing());
    server.handle(browserRpc.browserUsageSnapshot, async () => usageStore.settings());
    server.handle(browserRpc.browserUsageSaveApiKey, async ({ apiKey }) => usageStore.saveApiKey(apiKey));
    server.handle(browserRpc.browserUsageRemoveApiKey, async () => usageStore.removeApiKey());
    server.handle(webRequestAudit, async () => services.webExecutor.audit());
    return () => usageStore.stop();
  },
};
