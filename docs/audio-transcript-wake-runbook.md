# Audio Transcript Wake Runbook

This runbook defines the **post-Porcupine** audio wake behavior.

## Wake model (current)

Audio wake is transcript-based and configured in `packages/eva/audio/settings.yaml`:

```yaml
wake:
  phrases:
    - hey eva
    - okay eva
  match_mode: word_boundary # contains|exact|word_boundary
  case_sensitive: false
  min_confidence: 0.0
```

There is **no** wake provider switch and no wake credential setup.

## Non-active utterance gating rules

When conversation is **not active**:

1. Check Executive `/presence`.
2. If `found && preson_present && person_facing_me` => accept immediately (`accept_reason=presence`).
3. Otherwise run STT and match transcript wake phrase.
4. Accept only when phrase match succeeds (`accept_reason=wake_phrase`).
5. No match => reject utterance.

Active-window continuation behavior remains unchanged (`accept_reason=active`).

## Verification checklist (operator)

1. Start Executive + Audio runtime.
2. **Presence TRUE + no wake phrase**
   - Trigger utterance without wake phrase while `/presence` is true/fresh.
   - Expect transcript emitted with `accept_reason=presence`.
3. **Presence FALSE + wake phrase**
   - Make `/presence` false/stale.
   - Trigger utterance containing configured wake phrase.
   - Expect transcript emitted with `accept_reason=wake_phrase`.
4. **Presence FALSE + no wake phrase**
   - Keep `/presence` false/stale.
   - Trigger utterance without wake phrase.
   - Expect utterance rejected (no transcript emitted).
5. Validate active continuation:
   - After a successful activation, follow-up utterance in active window should pass with `accept_reason=active`.

## Regression guardrails

Run the static audio guardrail check after wake-related changes:

```bash
cd packages/eva
npm run check:audio-wake-guardrails
```

It asserts:
- no `pvporcupine` dependency,
- no legacy wake keys in audio settings,
- no Porcupine credential/runtime references in active runtime/docs,
- runbook/README remain aligned with transcript wake behavior.
