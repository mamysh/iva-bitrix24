# Rich task approval through existing Iva delivery

Status: accepted for prerelease 0.7.0-rc.6; end-to-end live approval pending.
Supersedes ADR0008’s native-only presentation choice for supported private Telegram-poll.

Native ask_question bypasses rich outbox. Iva already supports rich callback buttons in
ordinary final replies; Telegram-poll turns a trusted owner click into the next message
in the same private session. The plugin uses that route without a host patch or a second sender.

Prepare has presentation=native (default for API compatibility) or rich. Skill selects rich
in supported private Telegram-poll. The server escapes all task values and builds a frozen,
complete markdown preview with exactly two buttons for one draft/batch. Related lines have
hard line breaks; action blocks are separated. Callback data contains a random per-offer
confirmation reply or a draft-specific cancellation reply, both under 64 UTF-8 bytes.

The model must end the preview turn, then use only the actual incoming owner message.
Rich apply requires that exact confirmationReply; native requires structured optionId=confirm.
No generic assent, forwarded content, task data or model-generated reply authorizes writes.
Edits replace the full draft; expiry, owner/portal, snapshots, file hashes and receipts remain.
Pending schema3 offers are invalidated on upgrade. Receipts remain readable and prevent replay.

The plugin cannot independently prove a human clicked: the model sees the expected reply.
This remains the existing model-mediated approval boundary, not a cryptographic gate.
Webhook-only, groups and other channels use native ask_question. Rich fallback that loses
buttons requires a new native preview, not an inferred confirmation. Old buttons can remain
visible but cannot approve a replacement or replay a completed operation.
