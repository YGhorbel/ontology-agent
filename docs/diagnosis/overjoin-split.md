# Over-join split — referenced vs unreferenced (back-prune lift estimate)

**Status:** analysis only. No code, no runs. Recomputed from
`eval/results/benchmark-1782480844.json` by parsing each failure's predicted SQL.
Purpose: size the expected lift of the planned **back-prune-the-FROM-to-IR-referenced-
tables** brick *before* building it, so the post-fix re-benchmark confirms a prediction.

## Method (recomputed, not trusting prior numbers)

1. **Over-join set:** every `match=false` question whose `payloadTables` set is strictly
   larger than the gold SQL's FROM table set → **39**. Restrict to those whose extra
   tables include a **population-changing fact table** (`laptimes, qualifying, pitstops,
   results, driverStandings, constructorResults, constructorStandings`) → **33** with a
   parseable predicted SQL. (The 3 fan-out execute-errors 879/959/972 have
   `predictedSql=null` — not classifiable here; see caveat below.)
2. **Bad table** = a population fact table in the payload but not in gold's FROM.
3. **REFERENCED** = some non-join-key position in the predicted SQL names a column on
   that table (SELECT / WHERE / GROUP BY / ORDER BY / aggregate). **UNREFERENCED** = the
   table appears *only* in `FROM`/`JOIN … ON` (pure connective tissue) — exactly what
   back-prune targets.
4. **back-prune fixes the over-join?** = **Y** iff *all* bad tables are UNREFERENCED
   **and** dropping them leaves the referenced tables still connected (no articulation-
   point dependency). **N** otherwise.

## Headline counts

| metric | count |
|---|---|
| population-corrupting over-joins (N) | **33** |
| **back-prune fixes the over-join** (all bad unref + stays connected) | **12** |
| residual — ≥1 bad table **REFERENCED** by the IR (wrong-grain, bucket 2) | **12** |
| residual — all bad unref but a bad table is an **articulation point** (bridge structurally required) | **9** |
| (cross-check) rows where ≥1 bad table is a Steiner **bridge** | 19 |

**Expected lift of the brick = 12 over-joins whose population corruption is removed.**
The remaining **21 (12 + 9)** are *not* cleanly fixable by join-trimming: in 12 the IR
names the bad table, and in 9 the referenced tables (e.g. `drivers`+`races`, which have
no direct FK) can only be connected *through* a fact table — back-prune keeps a fact
bridge, it just can't guarantee the *right* one. Both residual classes are bucket 2
(grain), not bucket 1.

### ⚠️ Population-fix ≠ match-flip

Removing the over-join is **necessary but not sufficient**. Of the 12, only **2**
(915, 971) have *no other defect* and would flip to a match. The other 10 still fail on a
co-occurring defect (wrong column, dropped filter, IR-expressiveness, DISTINCT, ordering).
So the brick's **direct accuracy lift ≈ 2–3 matches**; its real value is infrastructural —
it removes population corruption so the *other* buckets become measurable in isolation.

## Per-row table

| id | bad (extra pop) table(s) | each: REF / UNREF | back-prune fixes over-join? | flips to match? | note |
|---|---|---|---|---|---|
| 847 | laptimes(term), pitstops(term), results(term) | all UNREF | **Y** | no | suspect-gold; predicted has no `ORDER BY q2` (drops the ranking) |
| 854 | laptimes(br), qualifying(br) | all UNREF | **Y** | no | wrong column: `location` vs gold `lat,lng` (bucket 4) |
| 859 | results(term) | UNREF | **Y** | no | dropped driver filter (Bruno Senna never anchored) |
| 868 | laptimes(br), qualifying(br) | all UNREF | **Y** | no | wrong column: `location` vs `lat,lng` (bucket 4) |
| 880 | laptimes(term), pitstops(term) | all UNREF | **Y** | no | percent-faster — IR can't express (bucket 6) |
| 894 | pitstops(term), qualifying(term), results(term) | all UNREF | **Y** | no | wrong projected columns (`driverref` vs `forename/surname`) + order |
| **915** | laptimes(br) | UNREF | **Y** | **YES** | clean: → `SELECT nationality FROM drivers ORDER BY dob ASC` |
| 964 | qualifying(br) | UNREF | **Y** | no | predicted `DISTINCT`; gold non-distinct (157 rows w/ dupes+nulls) |
| 967 | results(term) | UNREF | **Y** | no | needs top-3 subquery + count (bucket 6) |
| **971** | qualifying(br) | UNREF | **Y** | **YES** | clean: → `SELECT driverRef FROM drivers WHERE nationality='German' ORDER BY dob ASC` |
| 988 | results(term) | UNREF | **Y** | no | dropped dob-range filter; challenging |
| 1011 | pitstops(term), qualifying(term) | all UNREF | **Y** | no | top-20 + time-string parse (bucket 6) |
| 862 | laptimes(br) | UNREF | **N — ARTIC** | no | drivers↔races need a fact bridge; back-prune keeps one |
| 866 | qualifying(term) | UNREF | **N — ARTIC** | no | constructors↔laptimes only connect via qualifying |
| 877 | laptimes(br) | UNREF | **N — ARTIC** | no | drivers↔races bridge required |
| 931 | laptimes(term), pitstops(term) | all UNREF | **N — ARTIC** | no | suspect-gold; multi-fact bridge required |
| 940 | laptimes(br) | UNREF | **N — ARTIC** | no | drivers↔races bridge required (gold uses results) |
| 951 | laptimes(br), qualifying(br) | all UNREF | **N — ARTIC** | no | constructors↔races↔drivers chain needs a fact bridge |
| 960 | laptimes(term), pitstops(term) | all UNREF | **N — ARTIC** | no | bridge required between referenced tables |
| 990 | laptimes(br), qualifying(br) | all UNREF | **N — ARTIC** | no | circuits/constructors/drivers need fact bridge |
| 1002 | laptimes(br), qualifying(br) | all UNREF | **N — ARTIC** | no | drivers↔races bridge required |
| 865 | laptimes(br) | **REF** | **N** | no | planner put the race filter on `laptimes.raceid` → referenced |
| 881 | laptimes(br) | **REF** | **N** | no | `ORDER BY races.date` via laptimes path; laptimes referenced |
| 904 | pitstops(term), results(term) | results **REF**, pitstops unref | **N** | no | IR orders on `results.fastestlaptime` (wrong table; gold laptimes) |
| 928 | laptimes(br), qualifying(br) | qualifying **REF**, laptimes unref | **N** | no | IR aggregates `qualifying.position` (wrong grain; gold results.rank) |
| 937 | pitstops(term) | **REF** | **N** | no | IR selects `pitstops.time` (wrong table; gold results.time) |
| 944 | constructorstandings(term), laptimes(br), qualifying(br) | laptimes **REF** | **N** | no | challenging; aggregates on laptimes |
| 950 | constructorresults(term), qualifying(br) | constructorresults **REF** | **N** | no | wrong fact table: constructorResults vs gold constructorStandings |
| 954 | laptimes(br), qualifying(br) | laptimes **REF** | **N** | no | counts `laptimes.lap` (gold uses results.time completion) |
| 955 | laptimes(term), pitstops(term), qualifying(term) | laptimes **REF** | **N** | no | aggregates laptimes (gold parses results.time) |
| 963 | results(term) | **REF** | **N** | no | filters `results.fastestlaptime` (gold uses laptimes.time interval) |
| 989 | laptimes(br), qualifying(br) | laptimes **REF** | **N** | no | sums `laptimes.milliseconds` (gold uses results.time) |
| 1003 | laptimes(br), qualifying(br) | laptimes **REF** | **N** | no | counts laptimes (gold uses results+status accidents) |

(br = Steiner bridge, term = kept terminal, per `traceSummary.terminalsKept`.)

**Residual / wrong-grain worklist (≥1 referenced bad table) — 12 ids:**
865, 881, 904, 928, 937, 944, 950, 954, 955, 963, 989, 1003.

**Articulation-point risks — 9 ids:**
862, 866, 877, 931, 940, 951, 960, 990, 1002.

## Sanity read

- **vs the diagnosis's "~19/33 carry the population table as a Steiner bridge":**
  confirmed exactly — **19/33** rows have ≥1 bad table that is a bridge. But this is
  *not* the same cut as referenced/unreferenced, and that is the key lesson: **bridge ≠
  unreferenced** and **terminal ≠ referenced.**
  - *Referenced bridges* (865, 881, 928, 944, 954, 989, 1003): the planner anchored a
    filter/aggregate/order **onto the bridge fact table** (`laptimes.raceid`,
    `qualifying.position`, `laptimes.milliseconds`), making a pure-connector table
    referenced. Back-prune can't drop these — the IR names them. This is the strongest
    evidence that back-prune alone is insufficient and bucket 2 (grain) is real.
  - *Unreferenced terminals* (847, 880, 894, 931, 960, 1011): anchoring kept these fact
    tables as terminals but the planner **never used them** → cleanly droppable.
- **Surprising cases worth remembering:**
  - **865** — predicted writes `WHERE laptimes.raceid = 592` instead of filtering the
    grain table. The planner binds the raceId filter to *whatever* fact table is in
    scope; that act makes the wrong table referenced and immune to back-prune.
  - **950** — both `constructorResults` (referenced) and gold's `constructorStandings`
    exist; the planner filtered `points=0` correctly but on the wrong sibling fact table.
    A pure join-trim leaves it wrong — needs grain/table selection.
  - **915 / 971** — the *only* two clean wins: the bad fact table is an unreferenced
    bridge **and** the answer lives entirely on a single referenced table (`drivers`),
    so back-prune collapses the query to gold's single-table shape.

## Caveat on the 3 fan-out execute-errors (879, 959, 972)

Not in the 33 (no predicted SQL recorded). All three over-join `drivers`/`laptimes`/
`pitstops`/`results` on the shared `driverid`; the IR for each plausibly references only
one fact column, so they are *likely* fully back-prune-fixable (the fan-out tables are
unreferenced) — but this is **unverifiable** from the current JSON because the predicted
SQL was dropped on execute failure. If real, they add up to +3 beyond the 12.

## Bottom line for the brick

- **Over-joins whose population corruption back-prune removes: 12** (+ up to 3 unverifiable
  execute-errors). This is the predicted structural lift to confirm post-build.
- **Clean accuracy flips from the brick alone: ~2** (915, 971) — the rest carry a second
  defect, so the headline EA may barely move while the *over-join class shrinks
  measurably*. Re-benchmark should check **"over-join count drops by ~12"**, not "EA jumps".
- **21/33 need grain awareness, not join-trimming** (12 referenced + 9 articulation) —
  this is the sized bucket-2 worklist, and it is larger than bucket 1's clean wins.
