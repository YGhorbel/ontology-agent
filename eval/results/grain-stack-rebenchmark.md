# Grain-stack re-benchmark — frozen-IR A/B across the full grain bucket

**The arc's measurement event.** Confirms or falsifies each pre-registered prediction for the four-brick grain
arc (Move-1 menu tag ADR-013 → sibling-survival ADR-014 → snapshot enrichment ADR-015 → tier-1
operation⇒grain resolver ADR-016), with the LLM run-to-run confound isolated where possible.

- **Script:** [`scripts/grain-stack-rebenchmark.ts`](../../scripts/grain-stack-rebenchmark.ts) (read-only on
  production; composes the existing exported stages into two pipeline variants and toggles the four bricks).
- **Raw results:** [`eval/results/grain-rebench-1782743659.json`](grain-rebench-1782743659.json)
- **DB:** live formula1 (`:54321`), 64-question draft gold (`eval/gold/_f1-draft.jsonl`).
- **Planner:** Azure `gpt-5-mini`. Baseline + treatment are **two independent LLM passes** (so their EA delta
  carries sampling noise); the resolver leg is frozen-IR (zero LLM variance).
- **Arms:**
  - **Baseline (stack OFF):** pre-ADR-015 artifact (`formula1-1781704520.pre-adr015.jsonld`, 0 snapshot tags)
    + sibling-survival OFF + Move-1 menu tag OFF (planner fed a temporality-stripped payload clone) +
    resolver OFF. The H2 cumulative de-cumulation (pre-arc infrastructure) stays ON in both arms so it is
    not a confound.
  - **Treatment (stack ON):** current artifact (2 `as-of-event-snapshot` tags) + full pipeline.
  - **Resolver frozen-IR leg:** the treatment planner IR, compiled+executed with `resolveGrain` OFF vs ON on
    the **same** IR — the clean isolation of ADR-016.

---

## Headline numbers

| Metric | Baseline (OFF) | Treatment (ON) | Note |
|---|---|---|---|
| **Whole-64 EA** | 9/64 = 14.1% | 10/64 = 15.6% | +1 case — **within LLM noise**, not frozen-IR-clean |
| Whole-64 EA, suspect-adjusted (n=57) | 9/57 = 15.8% | 10/57 = 17.5% | same +1 case |
| **Grain subset EA** (n=15) | 0/15 | 1/15 | the +1 is case 869 (see confound note) |
| Grain subset EA, no suspect (n=13) | 0/13 | 1/13 | — |
| **Resolver-isolated (frozen-IR, n=63)** | **off 10/63** | **on 10/63** | **Δ = 0; resolver rewrote 0 of 63 IRs** |
| Non-grain EA (n=49) | 9 | 9 | **identical set — zero regression, zero non-grain gain** |

**Flagged-irreducible:** `f1-bird-869`, `f1-bird-950` — **2/2 as pre-registered (the H4 headline).**

**Binding-constraint counts (hand-adjudicated, 15 grain cases):**

| Bucket | Count | Cases |
|---|---|---|
| **retrieval-gated** | **13** | 854, 868, 910, 892, 896, 902, 906, 928, 933, 937, 989, 990, 994 |
| **flagged (irreducible)** | **2** | 869, 950 |
| **choice-gated** | **0** | — |
| **resolved** | **0** | — |

> The auto-classifier reported `retrieval-gated:12 / flagged:2 / choice-gated:1`. The one "choice-gated"
> (910) is a classifier artifact — its gold SQL qualifies no columns, so the column-presence check passed
> vacuously. Hand-verified: 910's payload carries `circuits.name, circuits.location` but **not** `lat`/`lng`
> (the coordinates the gold needs), so it is retrieval-gated (column-trim) exactly like 854/868. Corrected
> count: **retrieval-gated 13 / flagged 2 / choice-gated 0**.

---

## The decision (the cross-cutting number that picks the next arc)

**Retrieval-gated (13) ≫ choice-gated (0).** On 13 of 15 grain cases the choice layer was **dark** — the
correct candidate (a dropped sibling table, a trimmed column, an un-anchored column) never reached the
payload, so neither the menu grain tag nor the resolver had anything to act on. On the only 2 cases where
both candidates *did* reach the payload (869, 950), the choice layer behaved **correctly**: it flagged the
irreducible ASOF collision rather than guessing. **Zero cases were choice-gated** (both candidates present
but ranked/resolved wrong).

> **Next arc = retrieval-completeness, not ranking/resolver work.** The justifying number: **13/15 grain
> cases are starved at retrieval; 0 are starved at choice.** Concretely the next targets are (a) hybrid /
> column-first anchoring for the column-trim family (854/868/910 — `lat`/`lng` never retained) and the
> un-anchored position family (896/902 — `driverstandings` never reached), and (b) retrieval depth /
> non-FK-symmetric sibling rescue for the `results`-family ex-2b cases (928/937/989/990) and the
> `driverstandings` points cases (892/906). The choice layer (menu tag + resolver) is built and correct, but
> it cannot be measured until retrieval delivers the candidates.

---

## Per-case table

Outcome legend: ✓ = execution-match to gold; ✗ = mismatch; ⚠ = pipeline failure (planner/compiler/execute).
"Resolver frozen" = match with `resolveGrain` off → on, on the same treatment planner IR.

| id | bucket | baseline | treatment | resolver frozen (off→on) | binding | notes |
|---|---|---|---|---|---|---|
| **869** | irreducible | ✗ | ✓ | ✓ → ✓ (no rewrite) | **flagged** | Resolver **flagged** `points` (per-event vs cumulative); kept planner's `constructorresults` binding, which == gold (per-event). Match is the **planner's default**, preserved by the flag — *not* a resolver rewrite (off==on). Both siblings reached payload (survival fired). |
| **950** | 2a-asof | ✗ | ✗ | ✗ → ✗ (no rewrite) | **flagged** | Mirror of 869: same structure, **opposite gold grain** (`constructorstandings`, cumulative). Resolver **flagged**, kept planner's per-event binding → mismatch. Correct behaviour — "flagged, not won" as pre-registered. Survival fired (both siblings present). |
| **994** | 2a-agg | ⚠ compiler | ⚠ execute-timeout | ✗ → ✗ | retrieval-gated | **Both** siblings *were* retrieved (survival fired). But the enlarged subgraph **over-joined** (8 tables) → treatment query hit the statement timeout; baseline failed `temporality-unreachable`. Dark in both arms via **different** failure modes. Sibling-drop caveat **falsified** (both arrived); resolve **untested** (no clean execution). |
| **892** | 2a-max | ✗ | ⚠ compiler | ✗ → ✗ | retrieval-gated | *Suspect-gold.* All fact tables pruned; payload = `[drivers]` only. `driverstandings` never reached — no sibling to rescue. As predicted. |
| **906** | 2a-asof | ✗ | ✗ | ✗ → ✗ | retrieval-gated | *Suspect-gold.* `driverstandings` absent (payload `[drivers, pitstops, races]`); gate-3 (neither sibling survived prune). Choice untested. |
| **896** | position | ✗ | ✗ | ✗ → ✗ | retrieval-gated | `driverstandings` absent (payload `[circuits, races, seasons]`). The ADR-015 position snapshot tag **never reached the menu** because the table carrying it never reached the payload. Tag-reach prediction **untested**. |
| **902** | position | ✗ | ✗ | ✗ → ✗ | retrieval-gated | `driverstandings` absent — S1 anchoring miss (`position` never anchored). Confirmed S1 miss. |
| **928** | ex2b | ✗ | ✗ | ✗ → ✗ | retrieval-gated | `results` table absent (payload `[constructors, drivers, laptimes, qualifying, races]`). Not an FK-symmetric same-name sibling → survival did not rescue it. As predicted. |
| **937** | ex2b | ✗ | ✗ | ✗ → ✗ | retrieval-gated | `results` absent. `{laptimes, pitstops}` both present (a harmless survival fire), but the gold's `results` is not reachable via FK-symmetry (extra `status` FK) → honest fire-set confirmed. |
| **989** | ex2b | ⚠ compiler | ⚠ compiler | ✗ → ✗ | retrieval-gated | `results` absent; both arms fail `capability-no-formula`. As predicted (needs predicate/retrieval work). |
| **990** | ex2b | ✗ | ✗ | ✗ → ✗ | retrieval-gated | `results` absent; predicate on `results.time` cannot fire. Projection cols present but the answer needs the dropped table. |
| **933** | predicate | ✗ | ✗ | ✗ → ✗ | retrieval-gated | **BOTH-PRESENT confirmed:** `results.position` *and* `results.positionorder` both reached the payload — the predicate choice the planner faces. But `drivers` is absent → the "Lewis Hamilton" filter can't bind. The predicted choice problem is **masked/untested** behind a retrieval gap on `drivers`. Stack no-op (baseline payload == treatment payload). |
| **854** | 2c-coltrim | ✗ | ✗ | ✗ → ✗ | retrieval-gated | **Unchanged by the stack** (baseline payload == treatment payload). `circuits.lat`/`lng` trimmed; only `name, location` retained. Column-trim — quantifies the next arc. |
| **868** | 2c-coltrim | ✗ | ✗ | ✗ → ✗ | retrieval-gated | Same as 854: lat/lng trimmed. Stack no-op, as predicted. |
| **910** | 2c-coltrim | ✗ | ✗ | ✗ → ✗ | retrieval-gated | Same: lat/lng trimmed. (Auto-classifier mislabeled choice-gated — see note above.) Stack no-op. |

---

## Confound honesty — which deltas are clean, which are noisy

- **Frozen-IR-clean (zero LLM variance):** the resolver leg. `resolveGrain` was run on the *same* treatment
  planner IR with the brick off vs on. Result: **off 10/63 == on 10/63, 0 of 63 IRs rewritten.** The
  resolver's deterministic rebind path (AGG⇒per-event / MAX⇒standings) **never fired** on the live set — no
  planner IR presented a separable aggregate over a grain column with a wrong-grain binding *and* a unique
  reachable sibling. Its only live effect was the 2 flags (869, 950). **ADR-016's measurable EA contribution
  on this set is exactly 0; its contribution is structural (the irreducibility flag + determinism).**

- **NOT frozen-IR-clean (carry LLM sampling noise) — do not attribute to the bricks:**
  - The whole-64 EA delta (+1) and the grain-subset delta (0→1) are **entirely** case 869. Baseline and
    treatment are independent gpt-5-mini samplings. Tellingly, baseline 869 had **only** `constructorresults`
    available for `points` (no ambiguity at all) yet still missed, while treatment matched — and the
    frozen-IR leg shows the treatment IR matches with the resolver **off and on**. So 869's flip is the
    planner sampling differently between two runs, **not** a brick effect. Reported, flagged, **not** claimed.
  - The Move-1 menu-tag and sibling-survival legs change what the planner *sees*, so any EA movement they
    cause is inseparable from sampling noise here. They are evaluated **structurally** below (did the candidate
    reach the payload?), which is deterministic, rather than by their noisy EA.

- **Deterministic structural wins (real, brick-attributable):**
  - **Sibling-survival** brought *both* grain siblings into the payload on the FK-symmetric constructor-points
    family: 869, 950, 994 each gained `constructorstandings`/`constructorresults` in treatment that baseline
    lacked. This is the "table-drop:S2 → 0" win — but **only within the honest fire-set** (same-name
    FK-symmetric siblings). It did **not** rescue `results` (928/937/989/990) or `driverstandings`
    (892/906/896) — those are not FK-symmetric same-name siblings, exactly as ADR-014 predicted.
  - **Zero regression:** the non-grain match set is **identical** across arms (9 == 9). The bricks are
    provable no-ops on the 49 non-grain questions.

---

## Pre-registration check (confirmed / falsified / untested)

| Prediction | Verdict | Evidence |
|---|---|---|
| 950 — ASOF collision → flagged, not won | **CONFIRMED** | flagged on `points`; treatment ✗ (gold is cumulative) |
| 994 — resolve IF both siblings retrieved, else retrieval-gated (sibling-drop caveat) | **caveat FALSIFIED / resolve UNTESTED** | both siblings *were* retrieved; query over-joined → execute timeout. Survival here *enlarged* the join to intractability. |
| 892 — lost (all fact tables pruned), suspect | **CONFIRMED** | payload `[drivers]`, compiler fail, suspect |
| 906 — resolve if retrieved, else gated; suspect | **RETRIEVAL-GATED (untested)** | `driverstandings` absent (gate-3) |
| 854 / 868 / 910 — UNCHANGED (column-trim, not stack territory) | **CONFIRMED (×3)** | baseline payload == treatment payload; `lat`/`lng` trimmed in both |
| 896 / 902 — position tagged; tag reaches menu; resolving needs both siblings + separable op; 902 also S1 miss | **tag-reach UNTESTED; 902 S1-miss CONFIRMED** | `driverstandings` never reached payload → the snapshot tag never reached the menu |
| 928 / 937 / 989 / 990 — sibling-survival fires IFF shared anchored same-name column; `results` never symmetric | **CONFIRMED** | `results` absent in all four; survival did not rescue it (937's `{laptimes,pitstops}` fire is harmless) |
| 933 — UNCHANGED (predicate; both position+positionorder present) | **BOTH-PRESENT CONFIRMED; choice UNTESTED** | `position`+`positionorder` both reached payload, but `drivers` absent masks the choice |
| 869 / 950 — BOTH flagged, neither won (success = both flags raised) | **CONFIRMED** | both flagged on `points`; 869's incidental match is the planner's default (off==on), not a resolver win |

**Pre-registered success criteria:** `table-drop:S2 → ~0` — **partially met** (achieved for the FK-symmetric
constructor-points family 869/950/994; not for the non-symmetric `results`/`driverstandings` families).
`869/950 flagged` — **met (2/2).** `determinism` — **met** (resolver leg off==on, 0 rewrites, zero variance).
`flat EA acceptable` — **met** (whole-64 +1 within noise; resolver clean Δ = 0).

> **Verdict: SUCCESS by the pre-registered criteria.** A flat EA was expected and obtained; the arc's value is
> structural — the 2 irreducibility flags (869/950), the deterministic resolver (provably zero-variance,
> zero silent rewrites), no regression on 49 non-grain questions, and table-survival within the honest
> FK-symmetric fire-set. The decisive output is the binding-constraint split — **13 retrieval-gated vs 0
> choice-gated** — which points the next arc squarely at retrieval-completeness.
