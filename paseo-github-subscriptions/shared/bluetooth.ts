import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const BluetoothTargetSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/),
  address: z.string().regex(/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/).nullable(),
});
export const BluetoothConfigSchema = BluetoothTargetSchema.extend({ revision: z.string().min(1).max(100) });
export const BluetoothSnapshotSchema = z.strictObject({
  target: BluetoothConfigSchema,
  devices: z.array(BluetoothTargetSchema.extend({ connected: z.boolean(), rssi: z.number().nullable() })),
  error: z.string().nullable(),
});
export type BluetoothTarget = z.infer<typeof BluetoothTargetSchema>;
export type BluetoothConfig = z.infer<typeof BluetoothConfigSchema>;
export type BluetoothSnapshot = z.infer<typeof BluetoothSnapshotSchema>;
const host = { hostId: z.string().max(200).nullable() };
export const bluetoothList = defineRpc({ name: 'bluetooth.list', input: z.strictObject(host), output: BluetoothSnapshotSchema });
export const bluetoothSelect = defineRpc({ name: 'bluetooth.select', input: z.strictObject({ ...host, target: BluetoothTargetSchema }), output: BluetoothConfigSchema });
export const bluetoothLocalList = defineRpc({ name: 'bluetooth.local-list', input: z.object({}), output: BluetoothSnapshotSchema });
export const bluetoothLocalSelect = defineRpc({ name: 'bluetooth.local-select', input: BluetoothTargetSchema, output: BluetoothConfigSchema });
