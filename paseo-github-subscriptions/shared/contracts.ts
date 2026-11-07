import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { PreferencesSchema, SnapshotSchema, TokenStatusSchema } from './model.ts';

export const snapshot = defineRpc({ name: 'subscriptions.snapshot', input: z.object({}), output: SnapshotSchema });
export const unsubscribe = defineRpc({ name: 'subscriptions.remove', input: z.object({ id: z.string() }), output: z.object({ removed: z.boolean() }) });
export const savePreferences = defineRpc({ name: 'subscriptions.preferences', input: PreferencesSchema, output: PreferencesSchema });
export const saveToken = defineRpc({ name: 'subscriptions.token.save', input: z.object({ token: z.string().min(1).max(512) }), output: TokenStatusSchema });
export const removeToken = defineRpc({ name: 'subscriptions.token.remove', input: z.object({}), output: TokenStatusSchema });
export const pollNow = defineRpc({ name: 'subscriptions.poll', input: z.object({}), output: SnapshotSchema });
