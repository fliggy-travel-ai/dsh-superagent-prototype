/**
 * Plugin RPC contract between the cloud session program and the cloud session provider in this plugin.
 *
 * A cloud session is one Claude Code session running in a claude.ai cloud container. The cloud program calls these
 * methods through the Paseo pairing link (`invokePluginRpc`); the provider maps each cloud session to one Paseo agent.
 * Every method keys its session by `cloudSessionId` (`CLAUDE_CODE_REMOTE_SESSION_ID`, stable across container rebuilds),
 * never by a Paseo session id, because the daemon may close and reopen a provider session with a new id.
 *
 * Specification: https://github.com/fliggy-travel-ai/deepseek-harness/issues/1707
 */
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/** Provider id that the plugin registers and that `session.ensure` imports agents with. */
export const CLOUD_SESSION_PROVIDER_ID = 'cloud-session';

/** Agent label that holds the cloud session id; the provider finds an existing agent by this label. */
export const CLOUD_SESSION_LABEL = 'cloud-session.id';

/** Value of `CLAUDE_CODE_REMOTE_SESSION_ID`, for example `cse_` followed by 24 characters. */
export const CloudSessionIdSchema = z.string().regex(/^cse_[A-Za-z0-9]{8,64}$/);

/**
 * Plugin process generation. It changes when the plugin or the daemon restarts, which discards the inbox; a caller that
 * sees a new epoch knows that messages queued before the restart and not yet taken are lost.
 */
export const EpochSchema = z.string().min(1);

/**
 * Finds the agent for a cloud session or imports a new one. A new agent gets its own local workspace in the resolved
 * Mac directory, pinned, titled like the agent; the cloud session renames that workspace itself (Paseo
 * `rename_workspace`) to `<Issue number>【<stage>】<demand name>` once it knows them. An existing agent keeps its workspace. Calls for the same `cloudSessionId` run one at a time, so
 * concurrent callers get the same agent. An archived agent does not count: the next call imports a new agent.
 * `title` is used only when a new agent is imported.
 *
 * The agent's working directory must exist on the Mac, so the provider does not use the cloud path itself:
 * - `cwd` is the cloud session's working directory; its last path segment is the repository name. The provider uses
 *   the directory of the Paseo project with that name. When several projects share the name, it prefers one that has
 *   an active workspace, then the first in the daemon's project list.
 * - With no matching project, it uses `fallbackCwd` (a Mac directory the member configures in the cloud environment)
 *   when that directory exists, otherwise the Mac user's home directory.
 * The provider creates no project. Errors carry the daemon's original message.
 */
export const ensureSession = defineRpc({
  name: 'cloud-session.ensure',
  input: z.object({ cloudSessionId: CloudSessionIdSchema, title: z.string().min(1).max(60), cwd: z.string().min(1), fallbackCwd: z.string().min(1).optional() }),
  output: z.object({ agentId: z.string(), serverId: z.string(), workspaceId: z.string(), epoch: EpochSchema, created: z.boolean() }),
});

/**
 * Pushes timeline items for the cloud session's agent.
 *
 * `items` are Paseo provider timeline items (`ProviderTimelineItem` from `@getpaseo/plugin/server`); the provider
 * validates each one with the Paseo provider event schema and rejects the whole call when one is invalid.
 * A tool call with the same `callId` replaces the earlier one. An assistant message or reasoning item with the same `id`
 * is a cumulative snapshot: push the complete text so far; text that does not start with the earlier text is appended.
 *
 * Turn rules:
 * - `startTurn: true` starts a turn when none is running; when a turn that a Paseo prompt opened is running, the items
 *   join that turn.
 * - `endTurn` ends the running turn with that state. Only the cloud program ends a turn: a Paseo prompt's turn stays
 *   running until the cloud session has handled it.
 */
export const pushTimeline = defineRpc({
  name: 'cloud-session.timeline.push',
  input: z.object({
    cloudSessionId: CloudSessionIdSchema,
    startTurn: z.boolean().default(false),
    items: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
    usage: z.object({
      inputTokens: z.number().int().nonnegative().optional(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      contextWindowMaxTokens: z.number().int().nonnegative().optional(),
      contextWindowUsedTokens: z.number().int().nonnegative().optional(),
    }).optional(),
    endTurn: z.enum(['completed', 'failed', 'canceled']).optional(),
  }),
  output: z.object({ accepted: z.number().int().nonnegative(), turnRunning: z.boolean(), epoch: EpochSchema }),
});

/** One message the daemon sent to the cloud session's agent, such as a completion notification or a panel message. */
export const InboxItemSchema = z.object({
  seq: z.number().int().positive(),
  /** Paseo client message id of the prompt, for recognizing a message taken twice. */
  messageId: z.string(),
  /** `auto` opened a new Paseo turn; `steer` arrived while a turn was running. */
  delivery: z.enum(['auto', 'steer']),
  /** Prompt text as the daemon sent it; several `<paseo-system>` blocks may be joined in one item. */
  text: z.string(),
  receivedAt: z.string(),
});

/**
 * Returns inbox items after `afterSeq`, waiting up to `waitMs` when none is queued. Items stay queued until acknowledged,
 * so an item taken before a disconnect is returned again.
 */
export const pollInbox = defineRpc({
  name: 'cloud-session.inbox.poll',
  input: z.object({ cloudSessionId: CloudSessionIdSchema, afterSeq: z.number().int().nonnegative().default(0), waitMs: z.number().int().min(0).max(25_000).default(20_000) }),
  output: z.object({ epoch: EpochSchema, items: z.array(InboxItemSchema), lastSeq: z.number().int().nonnegative() }),
});

/** Removes inbox items up to and including `seq`. */
export const ackInbox = defineRpc({
  name: 'cloud-session.inbox.ack',
  input: z.object({ cloudSessionId: CloudSessionIdSchema, seq: z.number().int().positive() }),
  output: z.object({ remaining: z.number().int().nonnegative() }),
});

/**
 * Forwards one MCP JSON-RPC message to the Paseo MCP endpoint of the cloud session's agent, with that agent as caller.
 * The caller identity, endpoint, and credentials come from the daemon's session configuration for that agent; the
 * cloud program cannot choose them, and they never appear in a response or a log. Every Paseo tool is forwarded.
 * Fails with `not_opened` until the daemon has opened the agent's provider session at least once in this epoch.
 * `timeoutMs` bounds the local MCP call. Its maximum stays below the Paseo client's 60-second plugin RPC request timeout,
 * so the plugin always answers before the cloud caller gives up while the tool keeps running.
 */
export const forwardMcp = defineRpc({
  name: 'cloud-session.mcp',
  input: z.object({ cloudSessionId: CloudSessionIdSchema, message: z.record(z.string(), z.unknown()), timeoutMs: z.number().int().min(1_000).max(50_000).default(45_000) }),
  output: z.object({ status: z.number().int(), messages: z.array(z.record(z.string(), z.unknown())) }),
});

/** A permission dialog or question that Claude Code is showing in claude.ai for the cloud session. */
export const PendingRequestSchema = z.object({
  /** Claude Code tool use id; it identifies the request until the tool result appears. */
  toolUseId: z.string().min(1),
  toolName: z.string().min(1),
  /** `question` for AskUserQuestion; `tool` for a tool permission dialog. */
  kind: z.enum(['question', 'tool']),
  /** Tool input as Claude Code shows it; for AskUserQuestion it holds `questions`. */
  input: z.record(z.string(), z.unknown()),
});

/**
 * Mirrors a pending claude.ai request onto the cloud session's agent as a Paseo permission request (the native question
 * or approval component). The cloud program calls it from a non-blocking Claude Code PermissionRequest hook and returns
 * no decision, so claude.ai shows its own dialog as usual. Repeating a call with the same `toolUseId` is a no-op.
 */
export const notifyPendingRequest = defineRpc({
  name: 'cloud-session.request.notify',
  input: z.object({ cloudSessionId: CloudSessionIdSchema, request: PendingRequestSchema }),
  output: z.object({ shown: z.boolean() }),
});

/**
 * Closes the Paseo request for `toolUseId` after the tool result appears in the cloud transcript, whichever side
 * answered. Closing an unknown or already closed request is a no-op.
 */
export const resolvePendingRequest = defineRpc({
  name: 'cloud-session.request.resolve',
  input: z.object({ cloudSessionId: CloudSessionIdSchema, toolUseId: z.string().min(1), outcome: z.enum(['answered', 'denied', 'canceled']) }),
  output: z.object({ closed: z.boolean() }),
});

/** Only an authoritative cloud-side observation may report an archived or missing session. */
export const reportEndedSession = defineRpc({
  name: 'cloud-session.ended',
  input: z.object({ cloudSessionId: CloudSessionIdSchema, reason: z.enum(['archived', 'not_found']) }),
  output: z.object({ closedRequests: z.number().int().nonnegative() }),
});
