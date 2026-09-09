# Model routing

The router answers one question: _given this task and the providers that are up
right now, which model should run it, and what is the fallback order?_

Two properties matter more than cleverness:

1. **It is explainable.** Every decision returns the per-axis score breakdown
   that produced it, and the UI shows it. A router you cannot audit is one you
   will override blindly.
2. **It is data, not code.** The policy is a JSON document you edit in Settings.
   "Send UI work to Gemini" must never require a release.

Implementation: [`packages/core/src/routing.ts`](../packages/core/src/routing.ts).

## The policy schema

```jsonc
{
  "id": "default",
  "name": "Balanced (default)",
  "description": "shown in the picker",

  // Base weights. Each axis is normalised to 0–1, then multiplied by its weight.
  "weights": {
    "capability": 3, // does this model claim the capability the task needs
    "cost": 2, // cheaper is better; free scores 1
    "latency": 1, // faster tokens/sec is better
    "context": 1.5, // headroom past what the packed context needs
    "quota": 1.5, // has request headroom left, is not cooling down
    "tier": 1, // local < free-cloud < subscription < byok
    "reliability": 1, // observed success rate for this capability
  },

  // Evaluated in order. Later matches merge over earlier ones.
  "rules": [
    {
      "name": "Oversized context wins outright",
      "when": { "contextTokensAtLeast": 120000 },
      "prefer": ["google", "anthropic", "openai", "openrouter"],
      "weights": { "context": 6, "cost": 0.5 },
      "stop": true, // skip the remaining rules
    },
  ],

  "disabledProviders": [], // never used, whatever the rules say
  "maxTaskCostUsd": 1.5, // drop candidates above this per task
  "cooldownMs": 600000, // how long a 429'd provider sits out
}
```

### Rule conditions

All present conditions must match; an empty `when` matches every task.

| Field                                    | Meaning                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| `capability`                             | Task needs one of these capabilities                   |
| `role`                                   | Professional-mode role (`architect`, `qa-engineer`, …) |
| `complexityAtLeast` / `complexityAtMost` | Inclusive 1–5 range                                    |
| `titleMatches`                           | Case-insensitive regex over title + description        |
| `contextTokensAtLeast`                   | Only when the packed context exceeds this              |
| `mode`                                   | `instant` or `professional`                            |

### Rule actions

| Field     | Meaning                                                            |
| --------- | ------------------------------------------------------------------ |
| `prefer`  | Provider ids to favour, in order. Unlisted providers stay eligible |
| `exclude` | Providers this rule refuses outright                               |
| `model`   | Pin a model, applied only if the chosen provider offers it         |
| `weights` | Per-rule weight overrides merged over the base                     |
| `stop`    | Stop evaluating rules once this one matches                        |

A rule naming a provider you have not connected is **inert, not an error**.
That is what lets one default policy work for a user with one key and a user
with six.

## How a candidate is scored

Every (provider, model) pair is scored on seven normalised axes:

| Axis          | Score                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `capability`  | 1 on an exact match; 0.45 on a sensible fallback (a strong reasoner can do `code`); 0 otherwise, which is a rejection            |
| `cost`        | 1 when free, otherwise `0.05 / (0.05 + estimatedUsd)`                                                                            |
| `latency`     | Derived from the model's tokens/sec estimate                                                                                     |
| `context`     | Headroom past the requirement, saturating at 2x — a 1M window is not twice as good as 400k for a 200k pack                       |
| `quota`       | 1 with headroom, 0.1 when rate-limited, 0 while cooling down                                                                     |
| `tier`        | `1 - tier / maxTier`                                                                                                             |
| `reliability` | Observed success rate for `provider:capability`; an unused provider scores a neutral 0.5, because unknown is not the same as bad |

Then three nudges:

- Position in a matched rule's `prefer` list adds a small bonus. It is a nudge,
  not an override — a preferred provider that is out of quota should still lose
  to an available one.
- The planner's suggested provider adds `+3`. Advisory by design: a planner
  naming an exhausted model costs nothing.
- **Your pin adds `+1000`.** A pin wins, and it is the only thing that bypasses
  the per-task cost ceiling — at which point the budget guard asks you rather
  than the router silently rerouting.

## Hard rejections

A candidate is dropped, with the reason recorded and shown on demand, when:

- the provider is in `disabledProviders` or a rule's `exclude`;
- the model's context window cannot hold the pack plus the expected output;
- the model has no usable capability for the task;
- the provider is cooling down after a usage limit (with minutes remaining);
- the provider is out of requests for the current window;
- the estimate exceeds `maxTaskCostUsd` — unless you pinned it.

## The ladder

The result is not one model, it is an ordered **ladder** with one entry per
provider. Failover walks it.

One entry per provider is deliberate: failing over from a provider's best model
to its second-best rarely helps, and it burns a retry against the same quota
that just refused us.

## Shipped policies

| Policy                 | For                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Balanced** (default) | Free and local capacity for routine work; the strongest reasoner for architecture and security; long-context models when the pack is large |
| **Free first**         | Never spend money unless nothing free can do the job. `maxTaskCostUsd` is $0.25                                                            |
| **Quality first**      | Most capable model available for every task, cost heavily discounted                                                                       |

## Worked examples

Against a typical set — Ollama (local), Groq (free), Claude Code (subscription),
Anthropic and Google (BYOK):

| Task                                                                        | Routed to      | Why                                                                                                                  |
| --------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| "Rename a variable", `cheap-ok`, complexity 1                               | Ollama or Groq | The cheap-work rule raises `cost` to 4 and `latency` to 3; both score 1 on cost                                      |
| "Design the data model", `strong-reasoning`, complexity 5, role `architect` | Claude Code    | The architecture rule raises `capability` to 5 and drops `cost` to 0.5; the subscription is free, so it wins on both |
| Any task with a 400k-token pack                                             | Google         | The oversized-context rule fires first and stops; every other model is rejected outright for window size             |
| Anything, with Groq cooling down after a 429                                | Next rung      | Groq scores 0 on quota and is rejected with "cooling down (~5 min left)"                                             |

These four cases are asserted in
[`packages/core/test/routing.test.ts`](../packages/core/test/routing.test.ts).

## Editing the policy

Settings → Routing has a form editor and a raw JSON editor. `validatePolicy()`
returns every problem at once with a JSON path, so the editor shows them all
next to the fields rather than failing on the first one. An invalid regex in a
rule disables that rule; it never takes the router down.
