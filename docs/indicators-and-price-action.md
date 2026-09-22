# Indicators & Price Action — Reference

A catalogue of what can be computed from the data in this project, what each
thing actually measures, and where it will lie to you in a backtest.

**Data available here:** XAUUSDm only, 2021-09 → 2026-09, OHLC + tick volume +
spread, on 21 timeframes from M1 to MN1. No tick data, no order book, no
real volume, no other symbols.

## How to read the tables

| Column | Meaning |
|---|---|
| **Needs** | Which fields it consumes. `C`=close `O`=open `H`=high `L`=low `V`=tick volume |
| **Here?** | ✅ computable from this data · ⚠️ approximation only · ❌ needs data we do not have |
| **LA** | Look-ahead risk when used as an entry filter — see the warning below |

### The look-ahead warning, once, because it governs everything

An indicator computed on bar *i* is only known **after bar *i* closes**. If your
entry happens *during* bar *i* — the moment price touches a level — then any
filter using bar *i*'s close, high or low is reading the future.

This is not theoretical. In this project, filtering on the touch bar's close
produced a **66% win rate at 1:2**. Rebuilt so the bar closes first and entry
happens at the next bar's open, the same filter gave **34%** — i.e. nothing.
Every impressive result came from contaminated features; every clean feature
said nothing.

**LA ratings below:** 🟢 safe (uses only closed prior bars) · 🟡 safe only if you
enter on the *next* bar's open · 🔴 commonly misused, will flatter you badly.

---

# 1. Trend / Moving Averages

| Indicator | What it measures | Needs | Here? | LA |
|---|---|---|---|---|
| SMA(n) | Arithmetic mean of last *n* closes | C | ✅ | 🟡 |
| EMA(n) | Exponentially weighted mean, α=2/(n+1) | C | ✅ | 🟡 |
| WMA(n) | Linearly weighted mean | C | ✅ | 🟡 |
| SMMA / RMA | Wilder's smoothing, α=1/n — used inside RSI and ATR | C | ✅ | 🟡 |
| HMA(n) | Hull MA: `WMA(2·WMA(n/2) − WMA(n), √n)` — fast, low lag | C | ✅ | 🟡 |
| DEMA / TEMA | Double/triple EMA, lag-reduced | C | ✅ | 🟡 |
| KAMA | Kaufman adaptive — speeds up in trends, slows in chop | C | ✅ | 🟡 |
| VWMA | Volume-weighted MA | C,V | ⚠️ tick volume | 🟡 |
| VWAP | Volume-weighted average price, usually session-anchored | HLC,V | ⚠️ tick volume | 🟡 |
| MA ribbon | Several MAs together; spacing = trend strength | C | ✅ | 🟡 |
| Guppy MMA | 3–15 short vs 30–60 long EMAs; separation = conviction | C | ✅ | 🟡 |
| Ichimoku Kinko Hyo | Tenkan/Kijun/Senkou A,B/Chikou — trend, S/R and momentum in one | HLC | ✅ | 🔴 |
| SuperTrend | ATR-banded trend flip line | HLC | ✅ | 🟡 |
| Parabolic SAR | Trailing stop-and-reverse dots | HL | ✅ | 🟡 |
| Linear regression / channel | Least-squares fit + σ bands | C | ✅ | 🟡 |
| ADX / DMI | Trend *strength* (ADX) and direction (+DI/−DI) | HLC | ✅ | 🟡 |
| Aroon | Bars since the highest high / lowest low | HL | ✅ | 🟡 |
| Vortex (VI+ / VI−) | Trend direction via true-range-normalised swings | HLC | ✅ | 🟡 |

> **Ichimoku is 🔴** because Senkou spans are plotted **26 bars into the future**
> and Chikou is shifted **26 bars back**. Reading "price above the cloud" at bar
> *i* on a chart means the cloud drawn from bar *i−26*. Naive implementations
> index the *displayed* value and read 26 bars ahead. This is the single most
> common look-ahead bug in retail backtests.

---

# 2. Momentum / Oscillators

| Indicator | What it measures | Needs | Here? | LA |
|---|---|---|---|---|
| RSI(n) | Ratio of average gain to average loss, 0–100 | C | ✅ | 🟡 |
| Stochastic %K/%D | Close's position within the *n*-bar high–low range | HLC | ✅ | 🟡 |
| Stochastic RSI | Stochastic applied to RSI — faster, noisier | C | ✅ | 🟡 |
| MACD | EMA(12)−EMA(26), signal EMA(9), histogram | C | ✅ | 🟡 |
| CCI | Deviation from the mean in units of mean deviation | HLC | ✅ | 🟡 |
| Williams %R | Inverted stochastic, −100 to 0 | HLC | ✅ | 🟡 |
| ROC / Momentum | `C[i]/C[i−n]−1` or `C[i]−C[i−n]` | C | ✅ | 🟡 |
| TRIX | Rate of change of a triple-smoothed EMA | C | ✅ | 🟡 |
| Awesome Oscillator | SMA(5)−SMA(34) of median price | HL | ✅ | 🟡 |
| Ultimate Oscillator | Weighted momentum across three lookbacks | HLC | ✅ | 🟡 |
| Money Flow Index | Volume-weighted RSI | HLC,V | ⚠️ | 🟡 |
| Fisher Transform | Gaussianises price to sharpen turns | HL | ✅ | 🟡 |
| Connors RSI | RSI + streak RSI + percent-rank composite | C | ✅ | 🟡 |
| **Divergence** | Price makes a new extreme, oscillator does not | C + any | ✅ | 🔴 |

> **Divergence is 🔴** because it is only confirmed once the second swing point
> is *complete* — which requires bars after it. Detecting divergence "at" the
> pivot uses future bars. Any divergence backtest must lag confirmation by the
> full right-hand swing width, and most do not.

---

# 3. Volatility

| Indicator | What it measures | Needs | Here? | LA |
|---|---|---|---|---|
| ATR (Wilder) | Mean true range; TR = max(H−L, \|H−C₋₁\|, \|L−C₋₁\|) | HLC | ✅ | 🟡 |
| Bollinger Bands | SMA ± k·σ of close | C | ✅ | 🟡 |
| Keltner Channels | EMA ± k·ATR | HLC | ✅ | 🟡 |
| Donchian Channels | Highest high / lowest low over *n* | HL | ✅ | 🟡 |
| Bollinger %B / Bandwidth | Position within, and width of, the bands | C | ✅ | 🟡 |
| Squeeze (TTM) | Bollinger inside Keltner = compression before expansion | HLC | ✅ | 🟡 |
| Historical volatility | Stdev of log returns, annualised | C | ✅ | 🟡 |
| Chaikin Volatility | Rate of change of the H−L EMA | HL | ✅ | 🟡 |
| Choppiness Index | Trending vs ranging, 0–100 | HLC | ✅ | 🟡 |
| Standard error bands | Regression ± standard error | C | ✅ | 🟡 |

> **ATR is the most useful thing in this table for you.** It makes thresholds
> scale-free. A fixed `$20` body threshold found 3 big candles in 2021 and 587
> in 2026 because gold tripled; the same threshold expressed in ATR found
> 98/361/409/406/423/245 — a real sample in every year.

---

# 4. Volume

⚠️ **Everything here uses MT5 *tick volume*, not traded contracts.** Tick volume
counts price updates, which correlates with real volume in FX/metals but is not
the same thing, and is broker-specific. Treat conclusions as indicative.

| Indicator | What it measures | Needs | Here? | LA |
|---|---|---|---|---|
| Volume SMA / ratio | Current vs average activity | V | ⚠️ | 🟢 if from a prior bar |
| OBV | Cumulative signed volume | C,V | ⚠️ | 🟡 |
| Accumulation/Distribution | Volume weighted by close position in range | HLC,V | ⚠️ | 🟡 |
| Chaikin Money Flow | A/D averaged over *n* | HLC,V | ⚠️ | 🟡 |
| Force Index | `(C−C₋₁)·V` | C,V | ⚠️ | 🟡 |
| Ease of Movement | Price move per unit volume | HL,V | ⚠️ | 🟡 |
| Klinger Oscillator | Long/short-term volume force | HLC,V | ⚠️ | 🟡 |
| VWAP + σ bands | Fair-value anchor with deviation bands | HLC,V | ⚠️ | 🟡 |
| Volume Profile / TPO | Volume by *price* rather than time; POC, VAH/VAL | HLC,V | ⚠️ approx from M1 | 🟡 |
| Delta / order-flow imbalance | Buy vs sell aggression | — | ❌ needs tick/DOM | — |
| Footprint / DOM | Per-price bid/ask execution | — | ❌ | — |

> **Impulse volume was the only clean feature that carried signal** in our tests:
> a level created by a >1.5× average-volume candle behaved measurably
> differently on retest. It is 🟢 because it is measured on the impulse bar,
> which closed long before entry.

---

# 5. Support, Resistance & Structure

| Concept | What it is | Needs | Here? | LA |
|---|---|---|---|---|
| Swing high/low (fractal) | Bar higher/lower than *k* neighbours each side | HL | ✅ | 🔴 |
| Horizontal S/R | Prices repeatedly reacted to | HL | ✅ | 🟡 |
| Trendlines / channels | Sloped S/R through swing points | HL | ✅ | 🔴 |
| Pivot points | Classic/Fibonacci/Camarilla/Woodie from prior period HLC | HLC | ✅ | 🟢 |
| Fibonacci retracement | 0/23.6/38.2/50/61.8/78.6% of a swing | HL | ✅ | 🔴 |
| Fibonacci extension | 127.2/161.8/261.8% projections | HL | ✅ | 🔴 |
| Round numbers | Psychological levels (4300, 4350…) | — | ✅ | 🟢 |
| Prior day/week/month H/L/C | Session boundaries | HLC | ✅ | 🟢 |
| Opening range | First *n* minutes' high/low | HL | ✅ | 🟢 |
| Gaps | Weekend/session discontinuities | OC | ✅ | 🟢 |
| **Order block** | Last opposing candle before an impulse | OHLC | ✅ | 🟡 |
| **Fair Value Gap / imbalance** | 3-bar pattern where wicks do not overlap | HL | ✅ | 🟢 |
| **Liquidity sweep / stop hunt** | Wick beyond a prior extreme, then reversal | HL | ✅ | 🔴 |
| **Break of structure (BOS)** | Close beyond the last swing in trend direction | C + swings | ✅ | 🔴 |
| **Change of character (CHoCH)** | First BOS against the prevailing trend | C + swings | ✅ | 🔴 |
| Supply/demand zones | Bases preceding strong departures | OHLC | ✅ | 🟡 |
| Volume profile POC / value area | Most-traded price and 70% band | HLC,V | ⚠️ | 🟡 |

> **Swing points, trendlines, fibs and BOS/CHoCH are all 🔴 for the same
> reason:** a swing high is only a swing high once *k* bars have printed to its
> right. Anything anchored to a swing is confirmed `k` bars late. Drawing fibs
> from a swing "as it happens" is impossible in real time, and a backtest that
> does it will look superb. Always lag pivot confirmation by the right-hand
> width.
>
> **This project's "big body candle" level is an order block** in the ICT sense:
> impulse origin, revisited later. Our finding was that price *continues through*
> these more often than it respects them.

---

# 6. Price Action — Single Candle

| Pattern | Shape | Conventional reading |
|---|---|---|
| Marubozu | Large body, negligible wicks | Strong one-sided conviction |
| Doji | Open ≈ close | Indecision |
| Dragonfly doji | Long lower wick, no upper | Rejection of lows |
| Gravestone doji | Long upper wick, no lower | Rejection of highs |
| Spinning top | Small body, wicks both sides | Balance |
| Hammer | Small body up top, lower wick ≥ 2× body | Bullish rejection |
| Hanging man | Hammer shape in an uptrend | Bearish warning |
| Inverted hammer | Small body low, long upper wick | Bullish reversal attempt |
| Shooting star | Inverted hammer in an uptrend | Bearish rejection |
| Pin bar | Any long-wick rejection candle | Rejection of a level |
| High/low wave | Very long wicks both sides | Volatility, no direction |
| Belt hold | Opens at the extreme, closes near the other | Momentum initiation |

**Measurable properties worth using instead of pattern names:** body/range ratio,
upper-wick %, lower-wick %, body vs ATR, close position within range
`(C−L)/(H−L)`, gap from previous close, range vs average range.

> These are strictly 🟡 — every one needs the candle to **close**. Using a
> hammer's shape to justify an entry *within* that hammer is the exact bug that
> produced our fake 66% win rate.

---

# 7. Price Action — Multi-Candle

| Pattern | Bars | Conventional reading |
|---|---|---|
| Engulfing (bull/bear) | 2 | Body fully covers the prior body |
| Harami | 2 | Small body inside the prior large body |
| Harami cross | 2 | Harami whose second bar is a doji |
| Piercing line | 2 | Closes above the midpoint of a prior down bar |
| Dark cloud cover | 2 | Closes below the midpoint of a prior up bar |
| Tweezer top/bottom | 2 | Matching highs or lows |
| Inside bar | 2 | Range contained by the prior bar — compression |
| Outside bar | 2 | Range engulfs the prior bar — expansion |
| Morning / evening star | 3 | Reversal via a small-bodied middle bar |
| Three white soldiers / black crows | 3 | Sustained directional closes |
| Three inside up/down | 3 | Harami plus confirmation |
| Rising / falling three methods | 5 | Continuation after a shallow pause |
| Fair value gap | 3 | Bar 1 and bar 3 wicks do not overlap |
| Two-bar reversal | 2 | Sharp thrust, immediate full retrace |
| Failed breakout / fakeout | 2+ | Breaks a level, closes back inside |

---

# 8. Price Action — Chart Patterns

| Pattern | Type | Notes |
|---|---|---|
| Head & shoulders (+ inverse) | Reversal | Neckline break is the trigger |
| Double / triple top & bottom | Reversal | Equal highs/lows = liquidity pools |
| Rounding top/bottom | Reversal | Slow transition |
| Ascending / descending / symmetric triangle | Continuation usually | Converging trendlines |
| Rising / falling wedge | Reversal usually | Converging, both sides same direction |
| Bull / bear flag | Continuation | Sharp pole, shallow counter-trend drift |
| Pennant | Continuation | Pole + small symmetric triangle |
| Rectangle / range | Either | Horizontal boundaries |
| Cup and handle | Continuation | Rounded base + small pullback |
| Broadening / megaphone | Volatility expansion | Widening swings |
| Diamond | Reversal | Broadening then narrowing |
| Harmonics (Gartley, Bat, Butterfly, Crab, Shark, Cypher) | Reversal | Fib-ratio XABCD structures |
| Elliott Wave | Framework | 5 impulse + 3 corrective; highly subjective |
| Wyckoff accumulation/distribution | Framework | Spring, test, SOS, LPS phases |

> All of these require complete swing structure, so **all are 🔴**. They are also
> the hardest to specify unambiguously — if you cannot write the rule as code
> without a human eye, you cannot backtest it honestly.

---

# 9. Time, Session & Seasonality

| Factor | Notes | Here? |
|---|---|---|
| Session (Sydney/Tokyo/London/NY) | Volatility and character differ sharply | ✅ 🟢 |
| London & NY opens | Highest-volatility windows for gold | ✅ 🟢 |
| Session overlap (London+NY) | Peak liquidity | ✅ 🟢 |
| Hour of day | Simple bucketing | ✅ 🟢 |
| Day of week | Monday gaps, Friday drift | ✅ 🟢 |
| Day of month / turn of month | Flow effects | ✅ 🟢 |
| Rollover / daily break | ~63-min gap in this data | ✅ 🟢 |
| Weekend gap | ~49-hour discontinuity | ✅ 🟢 |
| News events (NFP, CPI, FOMC) | Dominant driver for gold | ❌ needs a calendar |
| Options expiry / COT positioning | Periodic structure | ❌ external data |

> ⚠️ **These timestamps are broker server time, not UTC and not your local
> time.** The project never shifts them. Before trusting any session filter,
> establish the broker's offset — otherwise "London open" is off by hours.
> Time features are 🟢 because a timestamp is known before the bar opens.

---

# 10. Statistical & Derived

| Method | Use |
|---|---|
| Z-score of price vs MA | Mean-reversion strength |
| Percentile rank / rolling quantiles | Regime-relative thresholds |
| Autocorrelation of returns | Is there momentum or reversion at this horizon? |
| Hurst exponent | Trending (>0.5) vs mean-reverting (<0.5) |
| Realised vs implied vol | ❌ needs options data |
| Rolling correlation | ❌ needs a second symbol (DXY, real yields, SPX) |
| Kalman filter / state space | Adaptive trend estimation |
| Change-point detection | Regime boundaries |
| Markov regime switching | Probabilistic regimes |
| ML classifiers (GBM, RF, NN) | Feature → direction; needs strict walk-forward |
| Monte Carlo on the trade sequence | Drawdown distribution, ruin probability |
| Bootstrap / permutation tests | **Is this edge distinguishable from luck?** |

> The last row matters most. With 46 combinations tried, pure chance produces a
> best-of-46 z ≈ 2.77. Any candidate must beat that bar before it means
> anything.

---

# 11. What this dataset cannot support

- **Order flow** — delta, footprint, DOM, absorption. Needs tick/L2 data.
- **Real volume** — MT5 gives tick counts, not contracts.
- **Cross-asset** — DXY, real yields, SPX, VIX all drive gold and none are here.
- **News and macro** — the biggest single driver of gold moves.
- **Sentiment / positioning** — COT, retail long-short ratios.
- **Multi-symbol** — no correlation, pairs, or basket work.
- **Spread and slippage realism beyond the recorded spread** — no queue position,
  no partial fills, no requotes.

---

# 12. Practical checklist before trusting any result

1. **Is every feature known before entry?** If it touches the entry bar's close,
   high or low, and you enter intrabar, it is look-ahead.
2. **Would it survive entering on the next bar's open?** That is the honest
   version of any candle-confirmation idea.
3. **Is the threshold scale-free?** Fixed pip/dollar thresholds silently
   concentrate your sample in whichever regime had the right price level.
4. **How many variants did you try?** Report it. Compare against
   `√(2·ln N)` for the expected best-of-N z.
5. **Does it hold on other timeframes?** Our best H1 result was strongly
   negative on M15 — which had 4× the sample.
6. **Is it positive in most individual years?** A total driven by one regime is
   not an edge.
7. **Are costs charged?** A clean 2R win should come out slightly *under*
   +2.000R once spread is deducted. If it is exactly 2.000, costs are missing.
8. **Does intrabar ambiguity matter?** When one bar contains both stop and
   target, the assumption you make can swing the result from +892R to −8R.
   Resolve it on M1.
