import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { BrowserBindingInputSchema, BrowserPairingSchema, BrowserSettingsSchema, BrowserSnapshotSchema } from './browser.ts';

export const browserSnapshot = defineRpc({ name: 'browser.snapshot', input: z.object({}), output: BrowserSnapshotSchema });
export const browserConfigure = defineRpc({ name: 'browser.configure', input: BrowserSettingsSchema, output: BrowserSnapshotSchema });
export const browserBind = defineRpc({ name: 'browser.bind', input: BrowserBindingInputSchema, output: BrowserSnapshotSchema });
export const browserPairing = defineRpc({ name: 'browser.pairing', input: z.object({}), output: BrowserPairingSchema });
