import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { ModuleStateSchema } from './modules.ts';

export const MachineModuleSettingSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  state: ModuleStateSchema,
  reason: z.string().optional(),
  reloadRequired: z.boolean().default(false),
});
export type MachineModuleSetting = z.infer<typeof MachineModuleSettingSchema>;

export const MachineSettingsSnapshotSchema = z.strictObject({
  configPath: z.string(),
  source: z.enum(['file', 'default']),
  machine: z.string().nullable(),
  errors: z.array(z.string()),
  modules: z.array(MachineModuleSettingSchema),
  pausedAll: z.boolean(),
  reloadInProgress: z.boolean().default(false),
});
export type MachineSettingsSnapshot = z.infer<typeof MachineSettingsSnapshotSchema>;

export const machineSettingsSnapshot = defineRpc({
  name: 'machine.settings.snapshot',
  input: z.object({}),
  output: MachineSettingsSnapshotSchema,
});

export const machineSettingsToggleModule = defineRpc({
  name: 'machine.settings.toggle-module',
  input: z.strictObject({
    id: z.string().min(1),
    enabled: z.boolean(),
  }),
  output: MachineSettingsSnapshotSchema,
});

export const machineSettingsPauseAll = defineRpc({
  name: 'machine.settings.pause-all',
  input: z.strictObject({
    paused: z.boolean(),
  }),
  output: z.strictObject({
    paused: z.boolean(),
  }),
});

export const machineSettingsExportBackup = defineRpc({
  name: 'machine.settings.export-backup',
  input: z.object({}),
  output: z.strictObject({
    backupPath: z.string(),
    createdAt: z.string(),
    files: z.array(z.string()),
  }),
});
