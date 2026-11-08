# Claude Code transcript sample

`transcript-sample.jsonl` is a synthetic Claude Code session transcript for the cloud session forwarder's tests. Its field names and value sets come from a real cloud session transcript (Claude Code 2.1.319, 2026-11-08); every text, id, path, and number is invented.

Facts it encodes, observed in that real transcript:

- A prompt that starts a turn is a `type: "user"` line whose `message.content` is a string. `turnOrigin` and `origin.kind` were `human` or `peer`; `promptSource` was `sdk` or `system`.
- `type: "user"` lines with `isMeta: true`, and `type: "attachment"` lines, carry reminders and hook output, not prompts.
- One API message (`message.id`) is split across several `type: "assistant"` lines, one content block each: `thinking`, `text`, or `tool_use`. Most `thinking` blocks have empty text in cloud sessions.
- A tool result is a `type: "user"` line whose content is a list with a `tool_result` block; its `content` is a string or a list of text blocks, and `is_error` is true, false, or absent.
- A turn ends with an assistant line whose `stop_reason` is `end_turn` (once `stop_sequence`), followed by a `type: "system"` line with `subtype: "stop_hook_summary"`.
- Other line types (`queue-operation`, `last-prompt`, `cost-state`, `mode`, `tools-used`, `frame-link`, `atis-latch`) carry no timeline content.
