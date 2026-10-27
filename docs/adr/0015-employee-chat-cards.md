# ADR 0015: employee approval in the conversation

Supersedes ADR 0014 only for navigation: the final proposal appears directly in the chat.
The trusted Panels callback and plugin-owned validation/queue/effect boundary are preserved.

Candidates include escaped rich text and numbered, short button labels. Choice replies carry
real candidate IDs and only select data. Incomplete searches remain explicitly incomplete.
A complete preview is followed by MCP draft op=present, which may only ask the generic
Panels chat transport to prepare and deliver that saved draft. It cannot confirm or write.
The transport receives an action ID, store revision and deterministic request ID; it never
receives a webhook or employee payload. The plugin socket constructs the actual proposal.

Presentation may be presented, already presented, unavailable or delivery unknown. These
states are distinct from queued/applied. Missing transport retains the draft; it does not
fall back to a model-mediated apply. Real message-bound buttons still authorize the queue.
