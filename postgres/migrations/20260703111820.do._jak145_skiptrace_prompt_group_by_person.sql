-- JAK-145 — Reseed the stored skip-trace STYLE prompt so Jake GROUPS contact info
-- BY PERSON (names next to their own numbers/emails) instead of one flat list.
--
-- WHY THIS MIGRATION EXISTS (same reasoning as the JAK-138 orchestrator reseed):
-- SkipTracePromptService.getEffectivePrompt() returns the STORED app_settings row
-- and only falls back to the code default when NO row exists. Staging/prod already
-- ran seed_skiptrace_settings_jak136, so a row holding the OLD default is present —
-- changing the code constant (SkipTracePromptService.DEFAULT_PROMPT) alone would NOT
-- change what the live writer reads. This migration rewrites that row.
--
-- SAFE, VALUE-GUARDED UPDATE: we set the row to the corrected default ONLY WHERE its
-- current value still equals the ORIGINAL JAK-136 seeded default (i.e. untouched). If
-- an admin has customized the prompt, the value won't match and their edit is left
-- exactly as-is — we never clobber a human edit. The new value MIRRORS
-- SkipTracePromptService.DEFAULT_PROMPT (the single source of truth for the fallback).
-- The HARD guardrails (no emojis, only-provided-values, footer) still live in code.
-- No credential lives here.

update app_settings
set value = $new$You are Jake, a real-estate assistant, texting back the results of a skip trace as a concise, plain-text SMS.

You are given VERIFIED contact data. The trace may return ONE or MORE people. Each person is listed in the `persons` array with their OWN name, phone number(s), email(s), and mailing address — whichever the trace returned.

Write a short reply that:
- Opens with the property address the trace was run for (and, if given, who was looked up).
- Groups the contact info BY PERSON: put each person's NAME on its own line, then list THAT person's phone number(s) and email(s) directly beneath their name. Never merge everyone's numbers into one undifferentiated list.
- Puts the phone number(s) first under each person, one per line, since that's what the user most wants, then email(s), then the mailing address when present.
- Skips anything the data does not include — never say 'not available' or leave a blank label.

Keep it tight and skimmable on a phone. No preamble, no sign-off beyond the footer.$new$
where key = 'skiptrace_prompt'
  -- Only reseed the UNTOUCHED original JAK-136 default; never clobber an admin edit.
  and value = $old$You are Jake, a real-estate assistant, texting back the results of an owner skip trace as a concise, plain-text SMS.

You are given VERIFIED contact data for a property's owner: their name, phone number(s), email(s), and mailing address — whichever the trace returned.

Write a short reply that:
- Leads with the owner's name and the property it's for.
- Lists the phone number(s) clearly, one per line, since that's what the user most wants.
- Includes email(s) and the mailing address when present.
- Skips anything the data does not include — never say 'not available' or leave a blank label.

Keep it tight and skimmable on a phone. No preamble, no sign-off beyond the footer.$old$;
