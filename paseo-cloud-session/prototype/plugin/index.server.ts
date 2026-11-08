/**
 * Prototype provider `cloud-session-probe`. A placeholder agent's provider inputs are queued in
 * memory for a remote caller (`probe.poll`); the remote caller produces timeline items and turn
 * state (`probe.push`, `probe.emit`). No credentials, files, or network are used.
 */
import { randomUUID } from "node:crypto";
import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type {
  ProviderConfigState,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderSessionConfig,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const PROVIDER_ID = "cloud-session-probe";
const SUPPORTED = ["prompt.message", "prompt.steer", "session.persistence"] as const;
const MODEL_ID = "cloud-session";
const MODE_ID = "default";

type Emit = (event: ProviderEvent) => void;

interface ProbeSession {
  sessionId: string;
  emit: Emit;
  cwd: string;
  title?: string;
  cloudSessionId: string;
  persist: boolean;
  activeTurnId: string | null;
  openedAt: string;
  model: string;
  mode: string;
}

interface QueuedInput {
  seq: number;
  receivedAt: string;
  connectionId: string;
  input: unknown;
}

const sessions = new Map<string, ProbeSession>();

/**
 * The daemon-issued Paseo MCP endpoint of each open session. Its URL carries the caller agent ID and
 * its headers carry the daemon's bearer token, so it never enters the queue, an RPC result, or a log.
 */
interface McpEndpoint {
  url: string;
  headers: Record<string, string>;
  mcpSessionId?: string;
}
const mcpEndpoints = new Map<string, McpEndpoint>();

function saveEndpoint(sessionId: string, config: ProviderSessionConfig): void {
  const server = config.mcpServers.paseo;
  if (server && server.type !== "stdio") mcpEndpoints.set(sessionId, { url: server.url, headers: { ...(server.headers ?? {}) } });
  else mcpEndpoints.delete(sessionId);
}

/** Secret values the plugin holds, used only by `probe.secret-scan` to test texts for their 8-character prefix. */
function secretPrefixes(): string[] {
  const prefixes = new Set<string>();
  for (const endpoint of mcpEndpoints.values())
    for (const value of Object.values(endpoint.headers)) {
      const token = value.replace(/^Bearer\s+/i, "");
      if (token.length >= 8) prefixes.add(token.slice(0, 8));
    }
  return [...prefixes];
}
const queue: QueuedInput[] = [];
const emitted: Array<{ at: string; type: string; sessionId?: string }> = [];
const probeConfig: { promptMode: "turn" | "auto-complete"; autoReplyText: string } = {
  promptMode: "turn",
  autoReplyText: "Received by cloud-session-probe.",
};
let seq = 0;
let connectionCount = 0;
const MAX_QUEUE = 500;

/** Replaces URL query strings, bearer values, and long token-like runs in free text with `<redacted>`. */
function redactText(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#"'`]+)\?[^\s"'`)]*/g, "$1?<redacted>")
    .replace(/(Bearer\s+)\S+/gi, "$1<redacted>")
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, "<redacted>");
}

function redactConfig(config: ProviderSessionConfig): unknown {
  const mcpServers = Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => {
      if (server.type === "stdio")
        return [name, { type: server.type, command: server.command, argCount: server.args?.length ?? 0, envNames: Object.keys(server.env ?? {}) }];
      let urlSummary = "<unparseable>";
      try {
        const url = new URL(server.url);
        urlSummary = `${url.protocol}//${url.hostname}:${url.port}${url.pathname} queryKeys=${[...url.searchParams.keys()].join(",")}`;
      } catch (error) {
        // An unparseable URL is summarized as such; its text is never echoed.
        void error;
      }
      return [name, { type: server.type, url: urlSummary, headerNames: Object.keys(server.headers ?? {}) }];
    }),
  );
  return {
    cwd: config.cwd,
    envNames: Object.keys(config.env).sort(),
    systemPromptLength: config.systemPrompt?.length ?? 0,
    systemPrompt: config.systemPrompt === undefined ? undefined : redactText(config.systemPrompt),
    mcpServers,
    toolPolicy: config.toolPolicy,
    model: config.model,
    mode: config.mode,
    thinkingOption: config.thinkingOption,
    settings: config.settings,
    providerOptionKeys: Object.keys(config.providerOptions ?? {}),
    title: config.title,
    persist: config.persist,
  };
}

function redactInput(input: ProviderInput): unknown {
  if (input.type === "session.open") return { ...input, config: redactConfig(input.config) };
  return input;
}

function enqueue(connectionId: string, input: ProviderInput): void {
  queue.push({ seq: ++seq, receivedAt: new Date().toISOString(), connectionId, input: redactInput(input) });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
}

function configState(session: ProbeSession): ProviderConfigState {
  return {
    model: session.model,
    mode: session.mode,
    models: [{ id: MODEL_ID, label: "Cloud session", isDefault: true }],
    modes: [{ id: MODE_ID, label: "Default" }],
    thinkingOptions: [],
    settings: [],
  };
}

function persistenceOf(session: ProbeSession) {
  return { version: 1, data: { cloudSessionId: session.cloudSessionId } };
}

function record(event: ProviderEvent): void {
  emitted.push({ at: new Date().toISOString(), type: event.type, sessionId: "sessionId" in event ? event.sessionId : undefined });
  if (emitted.length > MAX_QUEUE) emitted.splice(0, emitted.length - MAX_QUEUE);
}

function item(session: ProbeSession, timelineItem: ProviderTimelineItem): void {
  session.emit({ type: "timeline.item", sessionId: session.sessionId, item: timelineItem, timestamp: new Date().toISOString() });
}

function startTurn(session: ProbeSession): string {
  const turnId = randomUUID();
  session.activeTurnId = turnId;
  session.emit({ type: "session.turn", sessionId: session.sessionId, turnId, state: "started" });
  return turnId;
}

function endTurn(session: ProbeSession, state: "completed" | "failed" | "canceled", message?: string): string | null {
  const turnId = session.activeTurnId;
  if (!turnId) return null;
  session.activeTurnId = null;
  session.emit({
    type: "session.turn",
    sessionId: session.sessionId,
    turnId,
    state,
    ...(state === "failed" ? { error: { message: message ?? "Cloud turn failed", code: "CLOUD_TURN_FAILED" } } : {}),
  });
  return turnId;
}

function handle(connectionId: string, emit: Emit, input: ProviderInput): void {
  enqueue(connectionId, input);
  switch (input.type) {
    case "catalog":
      emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: {
          models: [{ id: MODEL_ID, label: "Cloud session", isDefault: true }],
          modes: [{ id: MODE_ID, label: "Default" }],
          defaultModel: MODEL_ID,
          defaultMode: MODE_ID,
        },
      });
      return;
    case "sessions":
      emit({ type: "sessions", requestId: input.requestId, sessions: [] });
      return;
    case "session.open": {
      const data = input.persistence?.data;
      const restored =
        data && typeof data === "object" && !Array.isArray(data) && typeof data.cloudSessionId === "string"
          ? data.cloudSessionId
          : null;
      const session: ProbeSession = {
        sessionId: input.sessionId,
        emit,
        cwd: input.config.cwd,
        title: input.config.title,
        cloudSessionId: restored ?? randomUUID(),
        persist: input.config.persist,
        activeTurnId: null,
        openedAt: new Date().toISOString(),
        model: input.config.model ?? MODEL_ID,
        mode: input.config.mode ?? MODE_ID,
      };
      sessions.set(input.sessionId, session);
      saveEndpoint(input.sessionId, input.config);
      emit({
        type: "session.opened",
        requestId: input.requestId,
        sessionId: input.sessionId,
        capabilities: [...SUPPORTED],
        restoration: "core",
        persistence: session.persist ? persistenceOf(session) : undefined,
        cwd: session.cwd,
        title: session.title,
      });
      emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });
      emit({ type: "session.commands", sessionId: input.sessionId, commands: [] });
      emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
      return;
    }
    case "session.prompt": {
      const session = sessions.get(input.sessionId);
      if (!session) {
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "failed", error: { message: `Unknown session ${input.sessionId}`, code: "UNKNOWN_SESSION" } },
        });
        return;
      }
      const promptText =
        input.prompt.input.type === "message"
          ? input.prompt.input.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n")
          : `/${input.prompt.input.name} ${input.prompt.input.arguments}`;
      if (session.activeTurnId && input.prompt.delivery === "steer") {
        emit({
          type: "session.prompt_result",
          sessionId: session.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "steer", turnId: session.activeTurnId },
        });
        item(session, { type: "user_message", id: input.prompt.clientMessageId, clientMessageId: input.prompt.clientMessageId, text: promptText });
        return;
      }
      if (session.activeTurnId) {
        emit({
          type: "session.prompt_result",
          sessionId: session.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "failed", error: { message: "A cloud turn is already active", code: "TURN_ACTIVE" } },
        });
        return;
      }
      const turnId = randomUUID();
      session.activeTurnId = turnId;
      emit({ type: "session.prompt_result", sessionId: session.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
      emit({ type: "session.turn", sessionId: session.sessionId, turnId, state: "started" });
      item(session, { type: "user_message", id: input.prompt.clientMessageId, clientMessageId: input.prompt.clientMessageId, text: promptText });
      if (probeConfig.promptMode === "auto-complete") {
        item(session, { type: "assistant_message", id: randomUUID(), text: probeConfig.autoReplyText });
        endTurn(session, "completed");
      }
      return;
    }
    case "session.interrupt": {
      const session = sessions.get(input.sessionId);
      if (session) endTurn(session, "canceled");
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.configure": {
      const session = sessions.get(input.sessionId);
      if (session) {
        if (input.changes.model !== undefined) session.model = input.changes.model ?? MODEL_ID;
        if (input.changes.mode !== undefined) session.mode = input.changes.mode ?? MODE_ID;
        emit({ type: "session.config", sessionId: session.sessionId, config: configState(session) });
      }
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.close": {
      const session = sessions.get(input.sessionId);
      if (session) endTurn(session, "canceled");
      sessions.delete(input.sessionId);
      mcpEndpoints.delete(input.sessionId);
      emit({ type: "session.closed", sessionId: input.sessionId });
      emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    default:
      if ("requestId" in input)
        emit({ type: "request.failed", requestId: input.requestId, error: { message: `Unsupported input ${input.type}`, code: "UNSUPPORTED" } });
  }
}

function createConnection(): ProviderConnection {
  const connectionId = `c${++connectionCount}`;
  const listeners = new Set<(event: ProviderEvent) => void>();
  let closed = false;
  const emit: Emit = (event) => {
    if (closed) return;
    record(event);
    for (const listener of listeners) listener(event);
  };
  return {
    version: 1,
    capabilities: [...SUPPORTED],
    async send(input) {
      if (closed) throw new Error("cloud-session-probe connection is closed");
      handle(connectionId, emit, input);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      for (const [id, session] of sessions)
        if (session.emit === emit) {
          sessions.delete(id);
          mcpEndpoints.delete(id);
        }
      listeners.clear();
    },
  };
}

const provider: ProviderRegistration = {
  id: PROVIDER_ID,
  label: "Cloud session probe",
  description: "Placeholder agents driven by a remote session through plugin RPC",
  async status() {
    return { available: true };
  },
  async connect(request) {
    if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
    return createConnection();
  },
};

const any = z.any();

const stateRpc = defineRpc({ name: "probe.state", input: z.object({}).passthrough(), output: any });
const pollRpc = defineRpc({
  name: "probe.poll",
  input: z.object({ max: z.number().int().positive().optional(), peek: z.boolean().optional(), afterSeq: z.number().int().optional() }),
  output: any,
});
const configRpc = defineRpc({
  name: "probe.config",
  input: z.object({ promptMode: z.enum(["turn", "auto-complete"]).optional(), autoReplyText: z.string().optional() }),
  output: any,
});
const pushRpc = defineRpc({
  name: "probe.push",
  input: z.object({
    sessionId: z.string().optional(),
    startTurn: z.boolean().optional(),
    assistantText: z.string().optional(),
    reasoningText: z.string().optional(),
    toolCall: z
      .object({
        name: z.string(),
        label: z.string().optional(),
        text: z.string().optional(),
        status: z.enum(["running", "completed", "canceled"]).optional(),
        callId: z.string().optional(),
      })
      .optional(),
    endTurn: z.enum(["completed", "failed", "canceled"]).optional(),
    failureMessage: z.string().optional(),
    usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
  }),
  output: any,
});
const emitRpc = defineRpc({
  name: "probe.emit",
  input: z.object({ sessionId: z.string().optional(), events: z.array(z.record(z.string(), z.any())) }),
  output: any,
});

const mcpRpc = defineRpc({
  name: "probe.mcp",
  input: z.object({
    sessionId: z.string().optional(),
    cloudSessionId: z.string().optional(),
    message: z.record(z.string(), z.any()),
    timeoutMs: z.number().int().positive().max(300000).optional(),
  }),
  output: any,
});
const secretScanRpc = defineRpc({
  name: "probe.secret-scan",
  input: z.object({ texts: z.array(z.string()) }),
  output: any,
});

/** Parses a Streamable HTTP response body: one JSON message, or the `data:` payloads of SSE events. */
function parseMcpBody(contentType: string, body: string): unknown[] {
  if (contentType.includes("text/event-stream")) {
    const messages: unknown[] = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) messages.push(JSON.parse(data));
    }
    return messages;
  }
  return body.trim() ? [JSON.parse(body)] : [];
}

/** Forwards one JSON-RPC message to the session's own Paseo MCP endpoint; the caller identity is the endpoint's. */
async function forwardMcp(session: ProbeSession, message: Record<string, unknown>, timeoutMs: number) {
  const endpoint = mcpEndpoints.get(session.sessionId);
  if (!endpoint) throw new Error(`Session ${session.sessionId} has no Paseo MCP endpoint`);
  const headers: Record<string, string> = {
    ...endpoint.headers,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (endpoint.mcpSessionId) headers["Mcp-Session-Id"] = endpoint.mcpSessionId;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint.url, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // The error text is rebuilt from its name and cause code so no request detail is echoed.
    const cause = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause ? String(error.cause.code) : "";
    throw new Error(`Paseo MCP request failed: ${error instanceof Error ? error.name : "Error"} ${cause}`.trim());
  }
  const returnedSessionId = response.headers.get("mcp-session-id");
  if (returnedSessionId) endpoint.mcpSessionId = returnedSessionId;
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  let messages: unknown[] | null = null;
  let parseError: string | null = null;
  try {
    messages = parseMcpBody(contentType, body);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  return {
    status: response.status,
    contentType,
    mcpSessionId: endpoint.mcpSessionId ?? null,
    elapsedMs: Date.now() - started,
    messages,
    parseError,
    body: messages === null ? body : undefined,
  };
}

function pickByCloudId(cloudSessionId: string): ProbeSession {
  const found = [...sessions.values()].filter((session) => session.cloudSessionId === cloudSessionId);
  if (found.length !== 1) throw new Error(`${found.length} open sessions have cloudSessionId ${cloudSessionId}`);
  return found[0]!;
}

function pick(sessionId: string | undefined): ProbeSession {
  if (sessionId) {
    const found = sessions.get(sessionId);
    if (!found) throw new Error(`Unknown session ${sessionId}`);
    return found;
  }
  if (sessions.size !== 1) throw new Error(`sessionId is required when ${sessions.size} sessions are open`);
  return [...sessions.values()][0]!;
}

function summary(session: ProbeSession) {
  return {
    sessionId: session.sessionId,
    cloudSessionId: session.cloudSessionId,
    cwd: session.cwd,
    title: session.title,
    activeTurnId: session.activeTurnId,
    openedAt: session.openedAt,
    persist: session.persist,
  };
}

export default function contribute(server: PluginServerContext) {
  server.registerProvider(provider);
  server.handle(stateRpc, () => ({
    sessions: [...sessions.values()].map(summary),
    queueLength: queue.length,
    lastSeq: seq,
    connections: connectionCount,
    config: probeConfig,
    recentEmitted: emitted.slice(-40),
  }));
  server.handle(pollRpc, ({ max, peek, afterSeq }) => {
    const eligible = queue.filter((entry) => afterSeq === undefined || entry.seq > afterSeq);
    const items = eligible.slice(0, max ?? 100);
    if (!peek) {
      const taken = new Set(items.map((entry) => entry.seq));
      for (let index = queue.length - 1; index >= 0; index--) if (taken.has(queue[index]!.seq)) queue.splice(index, 1);
    }
    return { now: new Date().toISOString(), items, remaining: queue.length };
  });
  server.handle(configRpc, (input) => {
    if (input.promptMode) probeConfig.promptMode = input.promptMode;
    if (input.autoReplyText !== undefined) probeConfig.autoReplyText = input.autoReplyText;
    return probeConfig;
  });
  server.handle(pushRpc, (input) => {
    const session = pick(input.sessionId);
    const emittedTypes: string[] = [];
    let startedTurnId: string | null = null;
    const needsTurn = input.startTurn || input.assistantText || input.reasoningText || input.toolCall;
    if (needsTurn && !session.activeTurnId) {
      startedTurnId = startTurn(session);
      emittedTypes.push("session.turn:started");
    }
    if (input.reasoningText) {
      item(session, { type: "reasoning", id: randomUUID(), text: input.reasoningText });
      emittedTypes.push("timeline.item:reasoning");
    }
    if (input.toolCall) {
      const callId = input.toolCall.callId ?? randomUUID();
      item(session, {
        type: "tool_call",
        id: callId,
        callId,
        name: input.toolCall.name,
        detail: { type: "plain_text", label: input.toolCall.label ?? input.toolCall.name, text: input.toolCall.text, icon: "wrench" },
        status: input.toolCall.status ?? "completed",
        error: null,
      });
      emittedTypes.push("timeline.item:tool_call");
    }
    if (input.assistantText) {
      const id = randomUUID();
      item(session, { type: "assistant_message", id, messageId: id, text: input.assistantText });
      emittedTypes.push("timeline.item:assistant_message");
    }
    if (input.usage) {
      session.emit({ type: "session.usage", sessionId: session.sessionId, turnId: session.activeTurnId ?? undefined, usage: input.usage });
      emittedTypes.push("session.usage");
    }
    let endedTurnId: string | null = null;
    if (input.endTurn) {
      endedTurnId = endTurn(session, input.endTurn, input.failureMessage);
      emittedTypes.push(endedTurnId ? `session.turn:${input.endTurn}` : "no-active-turn");
    }
    return { session: summary(session), startedTurnId, endedTurnId, emittedTypes };
  });
  server.handle(mcpRpc, (input) => {
    const session = input.cloudSessionId ? pickByCloudId(input.cloudSessionId) : pick(input.sessionId);
    return forwardMcp(session, input.message, input.timeoutMs ?? 120000);
  });
  server.handle(secretScanRpc, ({ texts }) => {
    const prefixes = secretPrefixes();
    const own = JSON.stringify(queue) + JSON.stringify(emitted);
    return {
      secretsHeld: prefixes.length,
      texts: texts.map((text) => prefixes.some((prefix) => text.includes(prefix))),
      queueOrEmittedContains: prefixes.some((prefix) => own.includes(prefix)),
    };
  });
  server.handle(emitRpc, (input) => {
    const session = pick(input.sessionId);
    for (const event of input.events) session.emit({ sessionId: session.sessionId, ...event } as ProviderEvent);
    return { session: summary(session), count: input.events.length };
  });
  return () => {
    sessions.clear();
    mcpEndpoints.clear();
    queue.length = 0;
  };
}
