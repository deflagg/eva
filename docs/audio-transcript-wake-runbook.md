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
1) Run STT on the utterance.
2) Match transcript against `wake.phrases`.
3) If match succeeds → accept (`accept_reason=wake_phrase`).
4) Otherwise → reject (no transcript emitted).

Audio runtime does not query Executive `/presence`.

Active-window continuation behavior remains unchanged (`accept_reason=active`).

## Verification checklist (operator)

1. Start Audio runtime.
2. **Idle, no wake phrase**
   - Trigger utterance without wake phrase.
   - Expect utterance rejected (no transcript emitted).
3. **Idle, wake phrase present**
   - Trigger utterance containing configured wake phrase.
   - Expect transcript emitted with `accept_reason=wake_phrase`.
4. Validate active continuation:
   - After a successful wake activation, follow-up utterance in active window should pass with `accept_reason=active`.

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
