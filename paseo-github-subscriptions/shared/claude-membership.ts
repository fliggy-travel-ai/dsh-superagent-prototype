import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const MembershipEmailSchema = z.email();
export const MembershipRenewalSchema = z.strictObject({
  day: z.number().int().min(1).max(31),
  time: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
});
export type MembershipRenewal = z.infer<typeof MembershipRenewalSchema>;

const MembershipAccountSchema = z.strictObject({
  email: MembershipEmailSchema,
  label: z.string(),
  renewal: MembershipRenewalSchema.nullable(),
});
export type MembershipAccount = z.infer<typeof MembershipAccountSchema>;

export const claudeMembershipList = defineRpc({
  name: 'claude-membership.list',
  input: z.strictObject({}),
  output: z.array(MembershipAccountSchema),
});

export const claudeMembershipSet = defineRpc({
  name: 'claude-membership.set',
  input: z.strictObject({ email: MembershipEmailSchema, renewal: MembershipRenewalSchema.nullable() }),
  output: MembershipRenewalSchema.nullable(),
});
