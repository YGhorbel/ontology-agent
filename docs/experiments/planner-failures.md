# GPT-5-mini planner failure journal (Stage 3a)

This file logs real `planQuery` runs where the model's first output failed the payload leash — the
data we use to iterate `PLANNER_SYSTEM_V*`. It is empty until we run the planner against a live model
(unit tests use a deterministic fake and are not logged here).

## Logged-attempt schema

Each entry is one `PlannerTrace` ([src/query/planner.ts](../../src/query/planner.ts)):

| Field | Meaning |
|-------|---------|
| `promptVersion` | prompt tag in effect, e.g. `planner/v1` |
| `schema` | always `specializeIrSchema` — the leash authority |
| `attempts[]` | one entry per outer semantic-leash attempt (NOT inner transient retries) |
| `attempts[].attempt` | 1-based index |
| `attempts[].raw` | the raw object the model returned (shape-valid, leash UNchecked) |
| `attempts[].ok` | whether it passed the leash |
| `attempts[].issues[]` | leash errors (`path: message`) when `ok` is false |
| `outcome` | `ok` (repaired or first-try) or `repair-exhausted` |

## What to capture per real failure

- The question + the payload's terminal tables.
- The full `PlannerTrace` (so we can see whether repair fixed it and after how many attempts).
- A one-line diagnosis: hallucinated IRI? wrong capability vs aggExpr? off-by-grain? prompt fix?

## Entries

_(none yet)_
