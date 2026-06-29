# Grain separability — does operation-shape × temporality-tag pick the grain?

**Mode:** analysis only (read-only). No code, no pipeline change.
**Sources:** `eval/results/benchmark-1782511248.json` (gold SQL), `eval/fixtures/ontologies/formula1-1781704520.jsonld` (`qsl:temporality`).
**Question:** can grain (cumulative-snapshot vs per-event) be resolved deterministically from the
question's **operation shape** (derived from gold *structure*, no wording) against the column's
generated `qsl:temporality` tag — with **no lexical cue**?

**Verdict: NO.** Operation shape is not a function of correct grain — there is a clean structural
collision (**869 vs 950**), and the tag does not break it. A second, independent failure: the
discriminating columns for the `position` family are **untagged**, so the tag leg carries no signal
there at all. The naive Route B (operation × tag, lexicon-free) is contradicted by the data.

---

## Operation-shape vocabulary (derived from gold STRUCTURE only)

- **AGG_OVER_EVENTS** — SUM/AVG of the *grain column itself* across multiple events (multi-event scope, GROUP BY entity).
- **ASOF_EVENT_FILTER** — grain column read/filtered on a row pinned to a **single specific event** (`raceId = const`, or the one event selected by order-by-then-LIMIT 1).
- **MAX_OR_LATEST** — superlative/extreme over the grain column with **no single-event pin** (global or per-season max).
- **COUNT_EVENTS_BY_VALUE** — grain column filtered to a value, then COUNT of events (grouped). Boundary case: looks like AGG_OVER_EVENTS but the aggregate is over `raceId`, not the grain column.

## Tag facts from the ontology (the generated signal)

| column | `qsl:temporality` |
|---|---|
| `driverstandings.points` | **cumulative-snapshot** |
| `driverstandings.wins` | **cumulative-snapshot** |
| `constructorstandings.points` | **cumulative-snapshot** |
| `constructorstandings.wins` | **cumulative-snapshot** |
| `constructorresults.points` | *(none → per-event)* |
| `results.points` | *(none → per-event)* |
| `driverstandings.position` | *(none)* ← standings col, **but not tagged** |
| `constructorstandings.position` | *(none)* ← standings col, **but not tagged** |
| `results.position` | *(none → per-event)* |

So for **points/wins** the tag does mark the cumulative sibling; for **position** the cumulative
standings column is **untagged**, identical to its per-event sibling.

---

## Per-case table

| id | question (short) | gold table.col (correct grain) | operation shape (from gold structure) | implied grain (op⇒grain) | tag-matched sibling = gold? | notes |
|---|---|---|---|---|---|---|
| 994 | most points from Monaco 1980–2010 | `constructorResults.points` (**per-event**) | `AGG_OVER_EVENTS` — SUM(points) GROUP BY team | per-event | ✅ yes | control: AGG ⇒ per-event holds |
| 892 | driver with the most points | `driverStandings.points` (**cumulative**) | `MAX_OR_LATEST` — ORDER BY points DESC LIMIT 1, **no event pin** | cumulative | ✅ yes | control: MAX (unpinned) ⇒ cumulative holds |
| 906 | Hamilton's first race + points | `driverStandings.points` (**cumulative**) | `ASOF_EVENT_FILTER` — earliest event (ORDER BY year ASC LIMIT 1) | cumulative | ✅ yes | ASOF ⇒ cumulative holds here |
| 950 | constructors with 0 points **at race 291** | `constructorStandings.points` (**cumulative**) | `ASOF_EVENT_FILTER` — `points=0 AND raceId=291` | cumulative | ✅ yes | ASOF ⇒ cumulative holds here |
| **869** | constructor with **highest point in race 9** | `constructorResults.points` (**PER-EVENT**) | `ASOF_EVENT_FILTER` — `raceId=9` ORDER BY points DESC LIMIT 1 | cumulative (rule) | ❌ **no** | **COLLISION with 950** — same shape, opposite grain |
| 902 | race where Yoong was position < 20 | `driverStandings.position` (**cumulative**) | range filter on position at standings rows | (n/a) | ⚠️ **no signal** | both `position` siblings untagged — tag leg blind |
| 896 | Hamilton % not 1st since 2010 | `driverStandings.position` (**cumulative**) | `COUNT`/ratio over standings rows, year≥2010 | (n/a) | ⚠️ **no signal** | `position` untagged → tag carries nothing |
| 951 | Japanese constructors with 0 points in 2 races | `constructorStandings.points` (**cumulative**) | `COUNT_EVENTS_BY_VALUE` (`points=0`, COUNT raceId) ≈ AGG_OVER_EVENTS | per-event (if read as AGG) | ❌ if classified AGG | **secondary collision with 994** |

---

## Step C — is operation-shape a function of correct grain?

Group the cases by shape:

- `AGG_OVER_EVENTS`: 994 → **per-event**. *(951, if its grouped COUNT-across-races is read as AGG → cumulative ⇒ collision.)*
- `ASOF_EVENT_FILTER`: 906 → cumulative, 950 → cumulative, **869 → per-event**. → **not a function.**
- `MAX_OR_LATEST`: 892 → cumulative.

**The mapping is NOT a function.** The decisive, unambiguous collision:

> **869** `... constructorResults WHERE raceId = 9 ORDER BY points DESC LIMIT 1` → **per-event**
> **950** `... constructorStandings WHERE points = 0 AND raceId = 291` → **cumulative**

Both are *"read `points` on a row pinned to a single specific race."* Structurally indistinguishable —
same table-pair available (a `…results.points` and a `…standings.points`), same single-event filter,
same column name. The only thing that separates them is the **question's intent**: "highest point
**in** race 9" (the points *scored at* that event → per-event result) vs "0 points **at** race 291"
(the championship *standing as of* that event → cumulative). That is a **lexical/semantic** distinction,
exactly the cue Route B was supposed to avoid.

(951 vs 994 is a softer second collision: whether "COUNT the races where standings points = 0" counts
as an aggregation-over-events is itself undefined by the vocabulary — the boundary of the shape
classifier is fuzzy, which is its own problem.)

## Step D — does the temporality tag rescue the collision?

No. The tag is a property of the *column*, and in both 869 and 950 the **same pair of options exists**
(one cumulative-tagged standings sibling + one untagged per-event sibling). Because the operation shape
is identical, `operation ⇒ implied grain` yields the *same* implied grain for both cases, so the
tag-match rule binds both to the *same* sibling — but gold wants opposite siblings. The tag cannot
encode information the operation didn't already carry.

Separately, for the **`position`** family (896, 902) the tag leg is simply **blind**:
`driverstandings.position` / `constructorstandings.position` are **untagged**, identical to
`results.position`. Even if operation implied a grain, there is no tag to select the matching sibling.

## Cross-domain check

The imagined rule uses only generated fields (`qsl:temporality`) + IR/gold operation structure — that
part is genuinely lexicon-free. **But it fails**, for two reasons that no amount of generated metadata
fixes:

1. **Structural identity (869/950):** the SQL shapes are the same; only question wording differs. Any
   resolver that gets both right *must* read a lexical/semantic cue → that is an F1-flavored patch, not
   a general brick.
2. **Tag gaps (position family):** the cumulative `position` columns aren't tagged, so the generated
   signal is absent precisely where it's needed.

---

## Go / No-go on the naive Route B

**NO-GO** for "resolve grain from IR operation shape against the temporality tag, lexicon-free." The
869/950 collision is a direct counterexample, and the position-family tag gap is a second independent
hole.

What a working approach would actually need (not forced here — recorded for the rethink):

- **A real lexical/semantic signal** to separate "scored at/in the event" (per-event) from "as of /
  standing at the event" (cumulative). This is unavoidable for the 869/950 pair — there is no
  structural surrogate. (This is the [[sibling-survival]] split restated: surfacing both columns is
  necessary but not sufficient; the chooser needs intent.)
- **Generator enrichment** so the per-event sibling and the standings `position` columns are tagged
  too (symmetric grain tags), which would at least make the tag leg non-blind for the position family —
  but it still won't separate 869/950.
- **Failing that, an interactive single-candidate guard / disambiguation** when two grain siblings both
  bind validly and operation shape does not separate them — i.e. treat irreducible grain ambiguity as a
  clarify-point rather than a deterministic pick.

**Bottom line:** operation × temporality-tag is *not* a deterministic, lexicon-free function over these
cases. Route B as currently imagined cannot stand on the generated signal alone; it needs the very
lexical cue it was meant to avoid. Rethink before building.
