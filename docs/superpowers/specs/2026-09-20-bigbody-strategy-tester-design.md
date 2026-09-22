# Big Body Retest Strategy Tester — Design

**Date:** 2026-09-20
**Status:** Awaiting review
**Symbol:** XAUUSDm, 2021-09-21 → 2026-09-18, 21 timeframes already on disk

## 1. What this tests

The Big Body indicator marks an impulse candle and projects a horizontal level
from its origin. When price later returns and touches that level, we take a
trade **with the impulse** and manage it at a fixed 1:2 risk:reward.

- A **bullish** impulse leaves a level at its **low** → a retest is a **long**.
- A **bearish** impulse leaves a level at its **high** → a retest is a **short**.

Confirmed decisions:

| Decision | Choice |
|---|---|
| Level source | Indicator levels only (not hand-drawn lines) |
| 1R definition | A fraction of the impulse candle's body (default 0.5×) |
| Same-bar stop/target collision | Replay M1 bars to find which came first |
| Trade direction | With the impulse |

## 2. Why the intrabar rule is the whole design

A feasibility run over H1 (530 touched levels, 5 years) gave these results for a
$5 stop, changing **nothing** but the same-bar assumption:

| Assumption | Win rate | Expectancy | Total |
|---|---:|---:|---:|
| Target first | 90.9% | +1.683R | +892R |
| Stop first | 34.3% | −0.015R | −7.8R |

300 of 530 touches were same-bar ambiguous. An OHLC bar records the high and the
low but not their order, so with a tight stop and a nearby level most trades hit
both inside one candle. A tester that silently resolves these optimistically —
the easiest way to write one — reports a 90% win rate that does not exist.

**This is the primary correctness requirement of the whole system**, not a
refinement. Everything else is bookkeeping.

Secondary finding, which is why the stop rule is body-relative: under the
pessimistic assumption a $5 stop collapses to −7.8R while `0.5×body` holds
+165R. A stop close to entry mostly measures intrabar noise.

Reference point: at 1:2 the breakeven win rate is **33.3%**.

## 3. Architecture

This is layer 2 of the original stack and sits on the existing data layer.
Nothing here needs a database.

```
                  ┌────────────────────────────────┐
                  │ components/backtest/  (UI)     │
                  │  panel · equity · trade list   │
                  └───────────────┬────────────────┘
                                  │ GET /api/backtest
                  ┌───────────────▼────────────────┐
                  │ lib/backtest/                  │
                  │  strategy → simulate → metrics │
                  └───────┬───────────────┬────────┘
                          │               │
        lib/indicators/bigBody      lib/candles/store
        (level lifecycle events)    (test TF + M1 for intrabar)
```

### 3.1 New: level lifecycle events

`computeBigBody` currently emits shapes for drawing. The tester needs the same
state machine's output as data. Add an **additional** output, without changing
the existing shape contract:

```ts
export interface LevelEvent {
  price: number;
  side: 'long' | 'short';      // from the impulse candle's direction
  createdIndex: number;
  createdTime: number;
  impulseBody: number;         // |close - open| of the impulse candle
  outcome: 'touched' | 'expired' | 'pending';
  touchedIndex?: number;       // present only when outcome === 'touched'
  touchedTime?: number;
}
```

This is purely additive: `boxes`, `labels` and `segments` keep their current
meaning, and the renderer is untouched. It is also the natural seam for any
future strategy built on the same indicator.

### 3.2 `lib/backtest/`

| File | Responsibility |
|---|---|
| `types.ts` | `Trade`, `TradeOutcome`, `BacktestParams`, `BacktestResult` — the frozen contract |
| `strategy.ts` | `LevelEvent[]` → planned trades (side, entry, stop, target). Pure. |
| `simulate.ts` | Walks bars forward, resolves exits, applies costs. Pure given its inputs. |
| `intrabar.ts` | M1 replay for same-bar collisions |
| `metrics.ts` | Win rate, expectancy, profit factor, drawdown, streaks. Pure. |
| `cache.ts` | Memoised per (timeframe, params), mirroring the store and indicator caches |

Splitting `strategy` / `simulate` / `metrics` as pure functions is what makes
this testable at all — each takes data and returns data, with no I/O.

## 4. The trade model

For a level with `outcome === 'touched'`:

```
side    = level.side
risk    = riskMultiple × level.impulseBody        (default riskMultiple = 0.5)
entry   = level.price
stop    = entry − side × risk
target  = entry + side × rewardMultiple × risk    (default rewardMultiple = 2)
```

Entry is assumed filled at the level: the touch bar traded through that price by
definition. Execution then walks from the touch bar forward for at most
`timeoutBars` (default 100); a trade still open at the limit closes at the last
bar's close and is reported separately as `timeout`, never silently dropped.

### 4.1 Costs

Spread comes from the bar's own `spread` column (mean 197 points = **$0.197** on
H1, max $1.96). The model is explicit: **half a spread against you at entry and
half at exit**, i.e. one full spread per round trip. At the default stop this is
roughly 1.5% of 1R — small but not zero, and it must never be omitted.

Commission and swap are **out of scope** and will be stated as such in the
output, so the numbers are not mistaken for net-of-all-costs.

### 4.2 Intrabar resolution (the important part)

When a bar's range contains both stop and target:

1. Load the M1 slice covering `[bar.time, nextBar.time)` from the existing store.
2. Replay those minutes in order; the first of stop/target touched decides.
3. If a single M1 bar still contains both, fall back to **stop first** and
   increment `unresolvedMinutes`.

`unresolvedMinutes` and `resolvedByM1` are reported as first-class result
fields. If a run resolves a large share of its trades this way, the reader
should know how much of the result rests on minute-level replay.

M1 is 1.76M bars and ~85MB; the store already caches it, so the cost is one
parse shared with the chart.

## 5. Metrics

Trades, wins, losses, win rate, expectancy in R, total R, profit factor, max
drawdown in R, longest winning and losing streaks, average bars held, and
breakdowns **by side** and **by calendar year**.

The per-year breakdown is not decoration: gold ran 1800 → 4400 over this period,
so a strategy that only works in a trending regime will show it there and
nowhere else.

Accounting is in **R**, not dollars. R is sizing-independent, so the result
measures the edge rather than a position-sizing choice. Dollar figures are a
display option using the same 100 oz/lot contract size the position tool uses.

## 6. Look-ahead safety

The failure mode that makes a backtest profitable and a live account not.

The design is causal by construction: a level is created from a completed
candle, the touch that triggers entry uses only bars up to that point, and M1
replay reads only minutes inside the bar being evaluated.

This will be **enforced by a test**, not asserted in prose: truncating the series
at bar *N* must produce byte-identical trades for every trade entered before *N*.
That single property catches most accidental look-ahead.

## 7. Validation

1. **Anchor (implemented as `lib/backtest/anchor.test.ts`):** the engine must
   agree with an independent Python port written from this spec, on the real H1
   series at `riskMultiple 0.5`, `rewardMultiple 2`, `timeoutBars 100`,
   spread on. Both must give **530 trades** and:

   | policy | wins | losses | timeouts | win rate | total R | expectancy |
   |---|---:|---:|---:|---:|---:|---:|
   | pessimistic | 234 | 295 | 1 | 44.234% | +164.450R | +0.310R |
   | optimistic | 330 | 199 | 1 | 62.382% | +452.450R | +0.854R |

   NOTE: the earlier draft of this section specified a flat $5 stop, which the
   engine does not implement (risk is always a fraction of the impulse body).
   The anchor above replaces it and is reproducible as written.

   The test also asserts the `m1` result falls between those two bounds, and
   that spread costs vary per trade — a flat default would give every trade an
   identical cost, which is how a dropped spread column would hide.

2. **Truncation invariance** (§6).
3. **Hand-computed fixtures** for `metrics.ts`: a known sequence of R outcomes
   with drawdown, profit factor and streaks worked out by hand.
4. **Intrabar unit tests:** a bar whose M1 slice hits the stop first, one that
   hits the target first, and one that is unresolvable at M1.
5. An **independent implementation** cross-check, as was done for the indicator
   port — the Python probe already exists and can be extended.

## 8. UI

- **`BacktestPanel`** — parameters, Run, and summary tiles.
- **`EquityCurve`** — cumulative R over time.
- **`TradeList`** — sortable table; selecting a trade scrolls the chart to it and
  draws its entry/stop/target, reusing the drawings primitive.
- Results appear with the ambiguity stats visible, never hidden behind a toggle.

## 9. Phasing

| Phase | Deliverable |
|---|---|
| 1 | `LevelEvent` output, strategy, simulator with M1 resolution, metrics, API. Headless and fully tested. |
| 2 | Panel, equity curve, trade list, chart markers. |
| 3 | Parameter sweep across threshold / riskMultiple / timeframe, reported as a grid. |

Phase 1 is the whole substance; phases 2–3 make it usable and guard against
reading too much into one parameter set.

## 10. Explicitly out of scope

Multiple symbols, portfolio-level sizing, commission and swap, partial exits and
breakeven stops, pyramiding, Monte Carlo, and live execution. Each is a separate
decision, and folding any of them in now would make the first result harder to
trust rather than easier.

## 11. Open risk

The feasibility probe shows a positive expectancy under pessimistic assumptions
(+0.31R at `0.5×body` on H1), but that is **one parameter set on one symbol over
one five-year window that contained a historic gold bull run**. Phase 3's sweep
and the per-year breakdown exist to test whether the edge survives outside that
regime. Treat nothing here as validated until they run.

---

# Addendum — Manual Mode (hand-drawn positions)

**Added:** 2026-09-20, after the Phase 1 dispatch.

## Purpose

Evaluate the long/short positions the user draws by hand, through the same
honest execution engine as the indicator strategy. This turns the position
drawing tool into a trade journal: draw the setups you would have taken, and
find out what they actually did.

Confirmed decisions:

| Decision | Choice |
|---|---|
| Entry | When price first touches the entry line at or after the drawing's start |
| Deadline | The position band's own right edge (`endTime`) |
| Reported | Win rate / wins / losses, pips won and lost, R multiples and expectancy |
| Not reported | Dollar P&L (deliberately excluded) |

## Why this is mostly reuse

A `PositionDrawing` already carries `side`, `entry`, `stop`, `target`, `time`
and `endTime`. The only new logic is *when the trade starts* and *when it is
abandoned*; the stop-versus-target question is the one the simulator already
answers.

**Manual positions are evaluated directly on M1.** Indicator trades run on a
higher timeframe and need M1 replay to break same-bar ties. A hand-drawn
position has an absolute time and price, so walking the minute series from the
start is both simpler and the most accurate answer the data supports. Ambiguity
shrinks to the inside of a single minute.

Using the band's right edge as the deadline means the setting is already on the
chart and adjustable by dragging, rather than being a hidden number.

## Evaluation, per position

1. **Validate geometry.** For a long the stop must be below entry and the target
   above; short is the mirror. A drawing that fails this is `invalid` and is
   excluded from the win rate rather than silently scored.
2. **Find the entry.** The first M1 bar at or after `time` whose range contains
   `entry`. If none occurs before `endTime`, the outcome is `never_triggered` —
   reported, never counted as a loss. Drawing an entry price that price never
   reached is a planning observation, not a losing trade.
3. **Walk forward** from that minute to `endTime`, testing stop and target with
   the side-dependent comparisons.
4. **Same-minute collision** → resolve pessimistically (stop first) and flag it
   as `assumed`. This is as fine as the data goes.
5. **Neither hit by the deadline** → `expired`, marked to market at the close of
   the last minute in the window.
6. **Costs** — the same model as the main engine: half the M1 bar's spread
   against the trade at entry and half at exit.

## Outputs

```ts
export type ManualOutcome =
  | 'win' | 'loss' | 'expired' | 'never_triggered' | 'invalid';

export interface ManualTrade {
  id: string;                 // the drawing's id, so the UI can select it
  side: Side;
  entry: number; stop: number; target: number;
  riskPips: number; rewardPips: number;
  plannedRR: number | null;   // null at zero risk
  outcome: ManualOutcome;
  resolution: Resolution;
  entryTime?: number; exitTime?: number; exitPrice?: number;
  pips?: number;              // realised, signed, net of spread
  r?: number;                 // realised R, net of spread
  minutesHeld?: number;
  reason?: string;            // why invalid / never triggered, in plain words
}

export interface ManualSummary {
  total: number;
  evaluated: number;          // wins + losses
  wins: number; losses: number;
  expired: number; neverTriggered: number; invalid: number;
  winRate: number;            // percent over wins + losses only
  totalPips: number; avgPips: number;
  totalR: number; expectancyR: number;
  avgPlannedRR: number | null;
}
```

`winRate` uses the same denominator rule as the main engine — wins plus losses
only — and the excluded categories are reported beside it so nothing is hidden.
Pips use 1 pip = **0.01**, matching the indicator, so a $1 move is 100 pips.

There is no single breakeven win rate here: each hand-drawn position has its own
risk:reward, so `avgPlannedRR` is reported instead and the reader compares
against that.

## Transport

Positions live in the browser's `localStorage`, so the server cannot read them.
`POST /api/manual-eval` with `{ positions: PositionDrawing[] }`.

This is the first POST in the app and the first time the server accepts client
data, so every field is re-validated server-side. Client input is untrusted
regardless of who wrote the client: reject non-finite numbers, bad sides,
`endTime <= time`, and cap the number of positions per request.

## Files

| File | Responsibility |
|---|---|
| `lib/backtest/manual.ts` | `evaluateManualPositions(m1, positions, params)` — pure |
| `lib/backtest/manual.test.ts` | Hand-built fixtures per outcome |
| `app/api/manual-eval/route.ts` | POST, validation, M1 load |
| `components/backtest/ManualPanel.tsx` | Per-position verdicts + summary |

`lib/backtest/manual.ts` is pure and takes the M1 series as an argument, exactly
like the rest of the engine, so it is testable without any I/O.

## Tests

One fixture per outcome — clean win, clean loss, same-minute ambiguity, expiry
at the deadline, an entry price never touched, and an invalid geometry — plus
the pip and R arithmetic verified by hand, and a check that spread makes a
2R win land slightly under +2.000R.
