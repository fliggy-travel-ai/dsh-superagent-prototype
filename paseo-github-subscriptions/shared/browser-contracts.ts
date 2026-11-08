import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { BrowserBindingInputSchema, BrowserPairingSchema, BrowserSettingsSchema, BrowserSnapshotSchema } from './browser.ts';
import { BrowserUsageApiKeyInputSchema, BrowserUsageSettingsSchema } from './browser-usage.ts';

export const browserSnapshot = defineRpc({ name: 'browser.snapshot', input: z.object({}), output: BrowserSnapshotSchema });
export const browserConfigure = defineRpc({ name: 'browser.configure', input: BrowserSettingsSchema, output: BrowserSnapshotSchema });
export const browserBind = defineRpc({ name: 'browser.bind', input: BrowserBindingInputSchema, output: BrowserSnapshotSchema });
export const browserPairing = defineRpc({ name: 'browser.pairing', input: z.object({}), output: BrowserPairingSchema });
export const browserUsageSnapshot = defineRpc({ name: 'browser.usage.snapshot', input: z.object({}), output: BrowserUsageSettingsSchema });
export const browserUsageSaveApiKey = defineRpc({ name: 'browser.usage.save_api_key', input: BrowserUsageApiKeyInputSchema, output: BrowserUsageSettingsSchema });
export const browserUsageRemoveApiKey = defineRpc({ name: 'browser.usage.remove_api_key', input: z.object({}), output: BrowserUsageSettingsSchema });
