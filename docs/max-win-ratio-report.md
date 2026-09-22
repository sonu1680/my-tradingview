# Maximum Win Ratio Search — Big Body Retest on XAUUSD

**Data:** XAUUSDm, 2021-09-21 → 2026-09-18, MT5 M1/M15/H1/H4 candles with tick volume and spread
**Payoff:** fixed 1:2 (risk = 0.5 × impulse body, target = 2 × risk), 100-bar timeout
**Question asked:** *test every indicator and price-action confirmation, try combinations, keep iterating, and report what generates the maximum win ratio.*

---

## 1. The answer, in one table

| Constraint you accept | Max win rate found | n | Combination | Same search on **shuffled outcomes** (95th pct) | p |
|---|---:|---:|---|---:|---:|
| at least 50 trades | **58.6%** | 70 | impulse vol high · close-position low · BB-width mid | 60.8% | 0.137 |
| at least 100 trades | **54.5%** | 101 | impulse vol high · prior-day-extreme distance mid · ATR regime high | 54.3% | 0.046 |
| at least 200 trades | **47.3%** | 204 | impulse vol high · BB-width mid | 48.4% | 0.178 |
| at least 500 trades | **41.4%** | 541 | impulse vol > 2.0× | 42.1% | 0.164 |

Breakeven at 1:2 is 33.3% gross; **35.0% after spread** on H1.

**What generates the maximum win ratio is the minimum sample size you are willing to accept, not any indicator.** At every tier the real maximum sits inside the range the identical search produces on data where the outcomes have been shuffled. The 54.5% at n ≥ 100 is the single number that touches the edge of chance (p ≈ 0.046) — and it is one of four headline statistics, on a table whose *unfiltered* base rate is already 35.4%, after searching two directions. It does not survive that accounting.

**1196 combinations were evaluated.** Expected best-of-1196 z under pure chance ≈ 3.76. Observed best: 4.49. Going from the earlier 46 hand-picked combinations to 1196 raised the best z by +0.97; chance predicts +0.99. **The maximum kept pace with the size of the search, not with the data.**

---

## 2. Method — and why the earlier "great" results were wrong

### 2.1 Two look-ahead bugs that this method removes
1. **Entry-bar bias.** The original simulator entered intrabar at the level and then tested that same bar's high/low. The bar qualified *because* it reached the level, so from a fill at that extreme the rest of the bar was a free favourable ride. This accounted for **93% of the strategy's "profit"** (+1305R → −99R once fixed).
2. **Closed-candle filters on an open candle.** Filtering on the touch bar's close ("did it close back up?", RSI, EMA position) produced a **66% win rate**. The touch bar had not closed at the moment of entry, so those features were reading the future — and they were exactly the features that decided whether the target got hit on that bar.

### 2.2 The confirmation-entry model used here
- A level is created by a big-body impulse candle (body ≥ 1.0 × ATR(14), Wilder), at its low if bullish / high if bearish (Pine "impulse origin").
- The first later bar whose range contains the level is the **touch bar `ti`**. It is allowed to **close**.
- **Every feature is measured on `ti` or earlier.** Entry is at the **open of `ti+1`**. At the moment of entry, every feature is history by construction.
- Stop = entry − side × 0.5 × impulse body; target = entry + side × 2 × that risk.
- Bars walked from `ti+1`; a bar containing both stop and target is resolved by replaying the **M1** minutes inside it (stop-first if one minute holds both).
- Spread charged: half the bar's recorded spread at entry, half at exit (1 point = $0.001).
- Two directions tested on the **same 1932 H1 touches**: `with` the impulse (buy the retest of a bullish candle's low) and `against` it (trade through the level). They are mirror images, not independent tests.

### 2.3 Definitions
- **Win rate** = wins / (wins + losses); timeouts excluded from the denominator (1 of 1932 on H1).
- **z** = (win rate − 33.33%) / √(p(1−p)/(w+l)).
- **Expectancy R** = mean realised R over all trades, timeouts included.
- **Permutation null**: shuffle the outcome columns against the feature columns and re-run the *entire* staged search (including re-selecting the top singles). 300 runs (spec) + 2000 (tail resolution). The empirical p-value is the share of null runs whose best statistic ≥ the real one. **This is the authoritative test**; √(2 ln N) is only a rule of thumb.

---

## 3. What was tested

**72 causal features** across every family in `docs/indicators-and-price-action.md`, turned into **188 binary predicates** (each 0/1 feature as `==1` and `==0`; each continuous feature as terciles fixed on H1_against plus canonical cuts such as RSI 30/50/70, ADX 20/25, %B 0/1, ATR-regime 0.8/1.2, CHOP 38.2/61.8, impulse volume 1.0/1.5/2.0). Exact duplicates were removed (e.g. Williams %R ≡ Stochastic − 100).

| Family | Features |
|---|---|
| Trend | EMA 20/50/100/200 position, MA stack, EMA200 slope, HMA slope, ADX, ±DI, Aroon, **SuperTrend** (real, see §10), Parabolic SAR, Ichimoku cloud (correctly lagged 26), Tenkan/Kijun, Chikou, distance to EMA200 in ATR |
| Momentum | RSI(14), Stochastic %K, MACD histogram sign & slope, CCI(20), Williams %R, ROC(10), Awesome Oscillator, Fisher(10) |
| Volatility | ATR regime, Bollinger %B & bandwidth percentile, Keltner position, TTM squeeze, Choppiness, Donchian position, historical-vol percentile, touch-bar range/ATR |
| Volume (tick) | impulse-bar volume ratio, touch-bar volume ratio, OBV slope, CMF(20), MFI(14) |
| Structure | prior-day H/L/C, pivot P, level inside prior-day range, distance to prior-day extreme, round-number proximity (10/50) |
| Price action (closed touch bar) | close-back, close position in range, body/range, rejection-wick ratio, pin bar, marubozu, doji, engulfing, outside bar, tweezer, two-bar reversal, previous bar close-back |
| Level meta | bars from impulse to touch, impulse size in ATR, impulse body/range, impulse volume, impulse aligned with EMA200 |
| Time | hour, session (Asia/London/overlap/NY/late), day of week |

`inside_bar` is constant 0 and was dropped — structurally, the touch bar cannot be inside the prior bar or the prior bar would have been the touch.

**Staged search per direction:** all singles (n ≥ 100) → all pairs among the top-20 singles (n ≥ 100) → all triples among the top-12 (n ≥ 80). Every evaluation counted, passing the n rule or not.

| direction | singles | pairs | triples | evaluated |
|---|---:|---:|---:|---:|
| H1_against | 188 | 190 | 220 | 598 |
| H1_with | 188 | 190 | 220 | 598 |
| **total** | | | | **1196** |

---

## 4. Baselines (no filter)

| table | n | win% | z vs 33.3% | total R | exp R |
|---|---:|---:|---:|---:|---:|
| H1_with | 1932 | 33.5% | +0.16 | −88.0 | −0.046 |
| H1_against | 1932 | 35.4% | +1.89 | +20.8 | +0.011 |
| H4_with | 325 | 32.1% | −0.48 | −20.2 | −0.062 |
| H4_against | 325 | 38.3% | +1.83 | +40.2 | +0.124 |
| M15_with | 10611 | 33.1% | −0.61 | −1320.9 | −0.125 |
| M15_against | 10611 | 33.3% | −0.03 | −1238.3 | −0.117 |

Net-of-spread breakeven: **35.0% H1, 34.2% H4, 37.2% M15** (spread is a larger share of a smaller M15 risk). Read every M15 column against 37.2%.

---

## 5. Every family, tested — best single predicate per family

Best-single null on H1_against (best of ~180 singles on shuffled outcomes): mean z **3.12**, 95th pct **3.61**, 99th pct **3.95**.

### H1 · against the impulse (trade through the level)
| family | best predicate | n | win% | z | total R |
|---|---|---:|---:|---:|---:|
| **volume** | **impulse volume > 1.84× its 20-bar average** | 644 | **40.8%** | **+3.85** | +115.5 |
| price action | not an outside bar | 1585 | 36.8% | +2.88 | +87.3 |
| trend | SuperTrend aligned | 937 | 37.6% | +2.72 | +73.3 |
| volatility | ATR regime > 1.2 | 437 | 39.7% | +2.71 | +63.0 |
| structure | distance to prior-day extreme, middle tercile | 644 | 38.5% | +2.70 | +65.8 |
| level meta | impulse aligned with EMA200 | 741 | 37.9% | +2.57 | +63.2 |
| time | 12:00–16:00 server (London/NY overlap) | 749 | 37.7% | +2.46 | +56.4 |
| momentum | RSI in trade direction > 60 | 637 | 37.7% | +2.29 | +53.2 |

### H1 · with the impulse (buy the retest)
| family | best predicate | n | win% | z | total R |
|---|---|---:|---:|---:|---:|
| price action | outside bar | 347 | 40.3% | +2.66 | +53.5 |
| momentum | CCI middle tercile | 491 | 38.7% | +2.44 | +53.6 |
| trend | ADX 20–28 | 644 | 37.2% | +2.01 | +39.3 |
| structure | far from prior-day extreme | 644 | 36.5% | +1.66 | +31.0 |
| volatility | Keltner position mid | 242 | 38.4% | +1.63 | +23.7 |
| time | Asia session | 333 | 37.5% | +1.58 | +28.3 |
| volume | MFI mid | 643 | 35.8% | +1.29 | +12.5 |
| level meta | impulse body/range high | 644 | 34.8% | +0.80 | −2.8 |

**Reading:** on the `with` side nothing reaches even the null *mean* for a best single. On the `against` side the best of every family lands in a tight band, z +2.3 to +2.9 — precisely what selecting the best of ~20 predicates per family yields on no-signal data. **Impulse volume is the only predicate above the best-single null's 95th percentile** (p ≈ 0.02–0.03), and it is discussed in §9.

Trend filters — EMA20/50/100/200, MA stack, ADX, Aroon, SuperTrend, PSAR, Ichimoku — **all** sit in that band. Momentum filters — RSI, Stochastic, MACD, CCI, ROC, AO, Fisher — **all** sit in that band or below. Candle patterns measured on the *closed* touch bar — pin bar, engulfing, rejection wick, close-back — carry nothing once they can no longer read the entry bar.

---

## 6. Maximum win ratio vs minimum sample size

Maximum over **all** evaluated combinations with n ≥ tier; null columns from the same search on 2000 shuffled tables.

| direction | tier | real max | n | z | null mean | null p95 | null p99 | p |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| against | n≥50 | 58.6% | 70 | +4.29 | 54.5% | 60.8% | 63.5% | 0.137 |
| against | n≥100 | 54.5% | 101 | +4.26 | 50.2% | 54.3% | 56.3% | 0.046 |
| against | n≥200 | 47.3% | 204 | +3.98 | 46.0% | 48.4% | 49.8% | 0.178 |
| against | n≥500 | 41.4% | 541 | +3.79 | 40.6% | 42.1% | 42.9% | 0.164 |
| with | n≥50 | 50.5% | 93 | +3.32 | 53.4% | 59.3% | 62.3% | 0.816 |
| with | n≥100 | 49.5% | 111 | +3.42 | 47.9% | 51.9% | 53.8% | 0.206 |
| with | n≥200 | 45.1% | 205 | +3.38 | 43.4% | 45.7% | 47.2% | 0.113 |
| with | n≥500 | 37.5% | 644 | +2.17 | 38.0% | 39.6% | 40.5% | 0.665 |

The `with` maxima are at or *below* their null means. The `against` maxima track the null mean at every tier.

---

## 7. Top combinations

### 7.1 H1 · against — top 10 (ranked by z; identical trade-sets collapsed)
| id | predicates | n | win% | z | total R | exp R | years + |
|---|---|---:|---:|---:|---:|---:|---:|
| A1 | close-pos low · BB-width mid | 199 | 49.2% | +4.49 | +85.2 | +0.428 | 5/6 |
| A2 | SuperTrend ok · close-pos low · BB-width mid | 82 | 57.3% | +4.39 | +55.0 | +0.671 | 5/6 |
| A3 | imp vol > 1.5 · not outside bar · SuperTrend ok | 373 | 44.5% | +4.32 | +107.5 | +0.288 | 6/6 |
| A4 | imp vol high · prior-day-extreme dist mid | 198 | 48.5% | +4.27 | +81.0 | +0.409 | 6/6 |
| A5 | A4 · ATR regime high | 101 | 54.5% | +4.26 | +59.3 | +0.587 | 6/6 |
| A6 | imp vol > 1.5 · close-pos low · BB-width mid | 99 | 54.5% | +4.24 | +58.6 | +0.592 | 6/6 |
| A7 | imp vol > 2.0 · not outside bar · far above EMA200 | 167 | 49.1% | +4.08 | +71.8 | +0.430 | 5/6 |
| A8 | imp vol high · not outside bar · far above EMA200 | 194 | 47.9% | +4.07 | +76.5 | +0.394 | 6/6 |
| A9 | not outside bar · close-pos low · BB-width mid | 158 | 49.4% | +4.03 | +68.3 | +0.432 | 5/6 |
| A10 | imp vol high · not outside bar · prior-day dist mid | 161 | 49.1% | +3.99 | +68.9 | +0.428 | 6/6 |

**8 of 10 are the same 644 impulse-volume trades carved down to 100–200 by one or two extra terciles.** The permutation test (§8) says that carving buys nothing beyond what shuffled outcomes give.

### 7.2 Per year (n / win% / total R) — against top 5
| id | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|
| A1 | 5 / 20% / −2.4 | 35 / 49% / +13.7 | 45 / 49% / +17.7 | 43 / 47% / +14.7 | 39 / 56% / +26.0 | 32 / 50% / +15.5 |
| A2 | 1 / 0% / −1.1 | 14 / 57% / +9.2 | 19 / 58% / +12.6 | 18 / 50% / +8.0 | 18 / 67% / +17.5 | 12 / 58% / +8.8 |
| A3 | 19 / 37% / +0.8 | 74 / 43% / +17.4 | 81 / 52% / +40.0 | 68 / 44% / +19.3 | 79 / 39% / +12.2 | 52 / 46% / +17.8 |
| A4 | 14 / 57% / +9.2 | 46 / 54% / +26.3 | 38 / 47% / +13.6 | 38 / 42% / +8.2 | 45 / 47% / +16.9 | 17 / 47% / +6.7 |
| A5 | 8 / 63% / +6.6 | 27 / 59% / +19.4 | 21 / 48% / +7.7 | 24 / 50% / +11.0 | 16 / 56% / +10.7 | 5 / 60% / +3.9 |

Per-year positivity looks reassuring until you notice the cell sizes: 5–45 trades per year. A coin with a 50% edge would show the same table.

### 7.3 Cross-timeframe — identical predicates and cut-points on H4 and M15
| id | H1 n / win% / z | H4 n / win% / z | **M15 n / win% / z / R** | verdict |
|---|---|---|---|---|
| A1 | 199 / 49.2% / +4.49 | 22 / 31.8% / −0.15 | 1093 / 34.6% / +0.87 / −90.7 | flat on M15 |
| A2 | 82 / 57.3% / +4.39 | 7 / 28.6% / −0.28 | 526 / 34.4% / +0.52 / −43.3 | flat on M15 |
| A3 | 373 / 44.5% / +4.32 | 42 / 40.5% / +0.94 | **2186 / 31.8% / −1.53 / −300.7** | **fragile — negative on M15** |
| A4 | 198 / 48.5% / +4.27 | 34 / 41.2% / +0.93 | 569 / 32.4% / −0.48 / −59.9 | flat on M15 |
| A5 | 101 / 54.5% / +4.26 | 15 / 66.7% / +2.74 | 380 / 32.7% / −0.26 / −34.9 | flat on M15 |
| A6 | 99 / 54.5% / +4.24 | 12 / 41.7% / +0.59 | 453 / 35.1% / +0.79 / −22.7 | flat on M15 |
| A7 | 167 / 49.1% / +4.08 | 22 / 50.0% / +1.56 | 612 / 35.6% / +1.18 / −1.7 | weakly supported |
| A8 | 194 / 47.9% / +4.07 | 29 / 51.7% / +1.98 | 819 / 34.8% / +0.88 / −28.4 | flat on M15 |
| A9 | 158 / 49.4% / +4.03 | 15 / 26.7% / −0.58 | 939 / 35.4% / +1.30 / −54.9 | weakly supported |
| A10 | 161 / 49.1% / +3.99 | 31 / 38.7% / +0.61 | 505 / 32.5% / −0.38 / −50.4 | flat on M15 |

**Not one of the top 10 has positive total R on M15.** M15 has 4–5× the trades. A real effect gets clearer with more data; these get flatter.

### 7.4 H1 · with — top 5
| id | predicates | n | win% | z | M15 n / win% / R | verdict |
|---|---|---:|---:|---:|---|---|
| W1 | body/range mid · ADX 20–28 · SuperTrend ok | 111 | 49.5% | +3.42 | — | thin |
| W2 | body/range mid · ADX 20–28 | 205 | 45.1% | +3.38 | 1174 / 33.4% / −133.9 | flat |
| W3 | W2 · Chikou ok | 93 | 50.5% | +3.32 | 418 / 30.9% / −82.2 | **fragile** |
| W4 | outside bar · ADX 20–28 | 108 | 49.1% | +3.27 | 484 / 32.0% / — | flat |
| W5 | SuperTrend ok · far from prior-day extreme · Asia | 98 | 48.0% | +2.90 | — | thin |

The `with` direction's best combination (z 3.42) equals the null's *average* best (3.35). It is noise.

---

## 8. Permutation test — how much of this is luck

Outcome rows shuffled against feature rows; the entire staged search re-run on each shuffle.

### H1 · against
| statistic | REAL | null mean | null p95 | null p99 | null max | **p (2000)** |
|---|---:|---:|---:|---:|---:|---:|
| best z, n≥100, all stages | +4.49 | +4.08 | +4.81 | +5.19 | +5.71 | **0.145** |
| best win%, n≥100, all stages | 54.5% | 50.3% | 54.3% | 56.3% | 57.9% | **0.047** |
| best z under stage rules | +4.49 | +4.10 | +4.81 | +5.25 | +5.71 | 0.157 |
| best win% under stage rules | 57.3% | 51.5% | 56.3% | 58.5% | 60.2% | 0.024 |
| best **single**-predicate z | +3.85 | +3.12 | +3.72 | +4.06 | +4.09 | **0.030** |

### H1 · with
| statistic | REAL | null mean | null p95 | null p99 | null max | **p (2000)** |
|---|---:|---:|---:|---:|---:|---:|
| best z, n≥100, all stages | +3.42 | +3.35 | +4.08 | +4.42 | +4.70 | **0.404** |
| best win%, n≥100, all stages | 49.5% | 48.0% | 51.9% | 53.8% | 54.2% | 0.206 |
| best single-predicate z | +2.66 | +2.14 | +2.86 | +3.23 | +3.45 | 0.088 |

Two statistics reach nominal significance on `against`: the best win rate at n≥100 (p 0.047) and the best single predicate (p 0.030). Those are two of ten headline statistics across two directions, on a table whose unfiltered base rate already carries z +1.89. **After that accounting, nothing here is distinguishable from an exhaustive search of no-signal data.**

---

## 9. The one component with any standalone evidence: impulse-bar volume

`imp_vol_ratio` = the impulse candle's tick volume ÷ its 20-bar average. Measured on the impulse bar, which closed long before the trade — clean by construction.

| | n | win% | z | total R | notes |
|---|---:|---:|---:|---:|---|
| H1 against, > 1.84× (top tercile) | 644 | 40.8% | +3.85 | +115.5 | p ≈ 0.03 vs best-single null |
| H1 against, > 2.0× | 541 | 41.4% | +3.79 | +105.9 | |
| H1 against, > 1.5× | 910 | 38.8% | +3.36 | +108.4 | |
| **H1 against, 2026 year-to-date** | 77 | **30.7%** | — | **−7.6** | negative in the most recent data |
| H4 against, > 1.84× | 87 | 41.9% | +1.60 | +20.4 | thin; 2026: 14 trades, 30.8% |
| **M15 against, > 1.84×** | **2634** | **33.5%** | +0.18 | **−196.8** | flat vs 37.2% net breakeven; 2026: 480 trades, 32.7% |
| H1 with, > 1.84× (same touches, opposite side) | 644 | 30.2% | — | — | mirror image, as it must be |

Economically it is coherent: a level created by a high-volume impulse behaves differently on revisit — price tends to *continue through* it (consistent with the entry-bar finding that same-bar trades resolved at 20% against a ~33% random baseline). But it is **H1-only**, **absent on the timeframe with four times the sample**, and **negative in 2026**. That is a hypothesis for genuinely new data, not a filter to trade.

---

## 10. SuperTrend — bug found and fixed during this work

The first search run reported `supertrend_ok` as identical to `side==1` on every table. Investigation: the harness's SuperTrend seeded its bands from NaN during warm-up, every comparison against NaN was False, and the direction stayed +1 on all 29 534 H1 bars. **That run did not test a real SuperTrend.** The bug was fixed (bands seeded at the first valid ATR), the tables rebuilt, and the search re-run: SuperTrend is now 52% bullish / 48% bearish with 722 regime flips on H1, and agrees with `side` only 51.3% of the time.

Result with the real indicator: **37.6% on 937 against-trades (z +2.72)** — inside the null and in the same band as every other trend filter. It appears in A2, A3 and W1 above; A3 (n = 373, 44.5%) is the largest, and it is **clearly negative on M15** (31.8%, −300.7R, 2186 trades).

---

## 11. Independent audit

> **PENDING** — a separate agent is (a) reconstructing each trade's touch bar and recomputing 16 features from the raw CSV with the arrays physically truncated at that bar, to prove no feature can see the future; (b) independently recomputing every outcome; and (c) running walk-forward logistic regression and gradient boosting by calendar year with a shuffled-label null, as a model-based answer to "is there *any* learnable signal here?". This section will be filled in when it completes. Note that any leak it finds would mean the true numbers are **lower** than those above, so it cannot reverse the verdict — only strengthen it.

---

## 12. Verdict

1. **No indicator, price-action pattern, or combination of up to three of them produces a win ratio at 1:2 that is distinguishable from what an exhaustive search finds on data with no edge.** The maximum win ratio is a mechanical function of the minimum sample size accepted: 58.6% at n≥50, 54.5% at n≥100, 47.3% at n≥200, 41.4% at n≥500 — each sitting inside the shuffled-outcome distribution.
2. **The `with`-impulse retest — the original strategy — is pure noise** in every family tested. Its best combination equals the null's average best.
3. **The `against`-impulse direction is marginally better and still does not clear the bar.** Best z 4.49, p ≈ 0.15. Two of ten headline statistics reach p < 0.05 before any correction for multiple statistics or for having searched two directions.
4. **Impulse-bar volume is the only feature with standalone evidence** (p ≈ 0.03), giving ~40–41% on ~600 H1 trades — H1-only, flat on M15, negative in 2026.
5. **Every candle-pattern and closed-bar-indicator filter that looked spectacular was reading the entry bar.** Measured honestly, none of them carries information.
6. **Going from 46 to 1196 combinations raised the best z by exactly the amount chance predicts.** Searching harder found more noise, not more signal.

**What generates the maximum win ratio: accepting fewer trades.** Nothing else in this dataset does.

---

## 13. If you want to keep going

- **Genuinely new data.** The only honest test of impulse-volume is data none of this touched: another year of XAUUSD as it arrives, or another instrument's history. If it holds ~40% there, it is worth another look.
- **Different payoff.** A 1:1 target changes the question entirely (breakeven 50%). The continuation finding suggests testing tight-target trades *through* high-volume levels, but that is a new hypothesis, to be pre-registered before looking.
- **Different level definition.** Everything here inherits the Pine "big body" level. Volume-profile POC, session extremes, or prior-day levels are cheap to swap in.
- **Stop searching this table.** Every additional combination evaluated on these 1932 trades makes the next "discovery" less credible, not more.

---

## Appendix — files
- Feature table builder: `scratchpad/features_v2.py` (causal; SuperTrend fixed)
- Tables: `scratchpad/tables_v2/table_{H1,H4,M15}_{with,against}.json`
- Search + permutation: `scratchpad/run_search_v2.py`, `search_lib_v2.py` → `v2_search_results.json`, `v2_search_report.md`
- Reference for every indicator: `docs/indicators-and-price-action.md`
- Design/engine documentation: `docs/superpowers/specs/2026-09-20-bigbody-strategy-tester-design.md`
