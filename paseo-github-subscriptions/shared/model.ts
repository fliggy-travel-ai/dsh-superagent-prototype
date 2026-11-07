import { z } from 'zod';

export const eventTypes = ['opened', 'comment', 'review', 'review_comment', 'push', 'ci', 'state'] as const;
export const EventTypeSchema = z.enum(eventTypes);
export type EventType = z.infer<typeof EventTypeSchema>;
export const PreferencesSchema = z.object({
  enabled: z.boolean().default(true),
  shadow: z.boolean().default(true),
  organization: z.string().regex(/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i).default('fliggy-travel-ai'),
  excludedRepos: z.array(z.string().min(1)).default(['rea', 'dsh-superagent-prototype', 'hypit', 'content-wx', 'harness2']),
  extraRepos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).default([]),
  providerPolicies: z.record(z.string(), z.enum(['interrupt', 'skip'])).default({}),
});
export type Preferences = z.infer<typeof PreferencesSchema>;
export const SubscriptionSchema = z.object({
  id: z.string(), agentId: z.string(), workspaceId: z.string().nullable(),
  agentTitle: z.string().nullable(), parentAgentId: z.string().nullable(),
  key: z.string(), scope: z.enum(['thread', 'repo']), owner: z.string(), repo: z.string(),
  number: z.number().int().positive().nullable(), isPr: z.boolean().nullable(), title: z.string().nullable(),
  events: z.array(EventTypeSchema), note: z.string().max(200).nullable(),
  createdAt: z.string(), updatedAt: z.string(), expiresAt: z.string().nullable(),
  lastEventAt: z.string().nullable(), lastEventId: z.string().nullable(), delivered: z.number(),
  lastDelivery: z.object({ at: z.string(), ok: z.boolean(), error: z.string().optional() }).nullable(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;
export const GithubEventSchema = z.object({
  id: z.string(), repo: z.string(), number: z.number().nullable(), isPr: z.boolean().nullable(),
  title: z.string().nullable(), type: EventTypeSchema, actor: z.string(), at: z.string(),
  url: z.string(), text: z.string(), markerAgentId: z.string().nullable(),
  revision: z.string().optional(), closed: z.boolean().optional(),
  ci: z.object({ failed: z.array(z.string()), running: z.boolean(), summary: z.string() }).optional(),
});
export type GithubEvent = z.infer<typeof GithubEventSchema>;
export const DeliverySchema = z.object({
  id: z.string(), agentId: z.string(), eventIds: z.array(z.string()), at: z.string(),
  status: z.enum(['pending', 'delivered', 'shadow', 'skipped', 'unknown', 'failed']), error: z.string().nullable(),
});
export type Delivery = z.infer<typeof DeliverySchema>;
export const RepositoryStatusSchema = z.object({
  repo: z.string(), lastPollAt: z.string().nullable(), error: z.string().nullable(),
  remaining: z.number().nullable(), resetAt: z.string().nullable(),
});
export type RepositoryStatus = z.infer<typeof RepositoryStatusSchema>;
export const TokenStatusSchema = z.object({
  configured: z.boolean(), prefix: z.string().nullable(), login: z.string().nullable(),
  remaining: z.number().nullable(), resetAt: z.string().nullable(), error: z.string().nullable(),
});
export type TokenStatus = z.infer<typeof TokenStatusSchema>;
export const SnapshotSchema = z.object({
  preferences: PreferencesSchema, subscriptions: z.array(SubscriptionSchema),
  events: z.array(GithubEventSchema), deliveries: z.array(DeliverySchema),
  repositories: z.array(RepositoryStatusSchema), token: TokenStatusSchema,
  polling: z.boolean(), lastPollAt: z.string().nullable(), toolInjection: z.boolean(),
  error: z.string().nullable(), intervalSeconds: z.literal(60),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
