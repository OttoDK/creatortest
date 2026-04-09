# V2 Unified Terms Change Modeler — Documentation

## Overview

`V2_unified.ipynb` is a Databricks notebook that answers a single question:

> **"What happens to revenue, costs, and return on investment if we change this brand's commission rate, introduce a flat fee, or both — and by how much?"**

It pulls the brand's actual historical performance, combines it with platform-wide empirical data on how similar changes have affected other programs in the past, and projects forward N months with a conservative, base, and optimistic scenario band.

Both `V2_test.ipynb` (flat fee modeler) and `v2_comission_rate.ipynb` (commission rate modeler) are replaced by this single notebook. Either change can be modelled independently or together in one run.

---

## How to Use It

1. Open `V2_unified.ipynb` in Databricks.
2. Fill in the widgets at the top of the notebook.
3. Run all cells top to bottom (**Run All**).
4. Review the printed summaries after each cell and the three charts at the bottom.

You only need to fill in whichever change you are proposing. Leave the other field at `0`.

---

## Input Widgets

| Widget | Description | Example |
|---|---|---|
| `brand_id` | The brand's internal account ID | `12345` |
| `avg_gift_costs` | Average cost of a gift sent to each **new** publisher onboarded ($). Enter `0` if no gifting. | `75` |
| `new_commission` | The proposed commission rate. Enter as a decimal (`0.15`) or as a percentage (`15`). Set to `0` if commission is not changing. | `0.15` or `15` |
| `new_flat_fee` | Proposed flat fee paid to each active publisher per month ($). Set to `0` if no flat fee is being introduced. | `200` |
| `forecast_months` | How many months ahead to forecast. Default is `12`. | `12` |

**At least one of `new_commission` or `new_flat_fee` must be non-zero.** If both are provided, the model combines both effects simultaneously.

---

## Pipeline Architecture

```
Widgets
   │
   ├─ Cell 1: Load brand history from brand_creator_agg
   │           Compute: hist_gmv_per_pub, avg_pub_growth, current_comm_rate
   │
   ├─ Cell 2: Look up brand vertical + program category
   │           (used for elasticity and flat fee benchmarks)
   │
   ├─ Cell 3: [if commission change] Query ioterms_gtv
   │           → empirical GMV response per pp rate change
   │           → P10 / P50 / P90 GMV multipliers
   │
   ├─ Cell 4: [if flat fee] Query vertical_flatfee_productivity
   │           → publisher retention factor at proposed fee level
   │
   ├─ Cell 5: Combined forward forecast loop
   │           → monthly GMV × costs × ROAS for all three scenarios
   │
   ├─ Cell 6: Historical baseline summary table + KPIs
   │
   ├─ Cell 7: Chart A — Monthly revenue & total cost
   ├─ Cell 8: Chart B — ROAS over time
   └─ Cell 9: Chart C — Cumulative revenue & investment
```

---

## Stage-by-Stage Explanation

### Cell 0 — Imports & Widgets

Sets up the Spark session, imports libraries, and defines the five input widgets. Nothing is computed here; this cell must run before any others.

---

### Cell 1 — Brand History Load

**What it does:**

Queries `fq-platform.strategy_sandbox.brand_creator_agg` for all available monthly history for the given brand. The current (incomplete) month is always excluded.

**Computed baseline metrics used throughout the rest of the notebook:**

| Variable | Meaning |
|---|---|
| `hist_gmv_per_pub` | Average monthly GMV generated per active publisher, averaged across all historical months. This is the core productivity anchor for the forecast. |
| `avg_pub_growth` | Average month-over-month % change in total active publishers. Used to grow the publisher base in the forecast. |
| `current_comm_rate` | The commission rate from the most recent historical month. |
| `delta_pp` | The difference between the proposed and current commission rate (signed decimal, e.g. `+0.05` = +5 percentage points). |
| `hist_total_costs` | Commission payouts (GTV) + gift costs per month. Used as historical cost baseline. |

---

### Cell 2 — Vertical & Category Lookup

Queries two tables:

- **`prod-data-enablement.analytics.program`** — retrieves the brand's `benchmarking_vertical` (e.g., "Health & Beauty"), used to look up commission elasticity benchmarks.
- **`prod-data-enablement.analytics.partnership_affiliation`** — retrieves the brand's `primary_program_category` (e.g., "Apparel, Shoes & Accessories"), used to look up flat fee productivity benchmarks. Falls back to `benchmarking_vertical` if not found.

---

### Cell 3 — Commission Elasticity (runs only if `new_commission` > 0)

**The problem with the old approach:**

The previous commission notebook looked up how programs *already running at* the proposed rate were performing. This is misleading — those programs chose that rate for reasons related to their brand quality, not because changing rates caused that performance.

**The new approach:**

This cell queries `fq-platform.strategy_sandbox.ioterms_gtv`, which contains ~650,000 rows of *actual before/after* GTV data for real commission rate changes across the platform. For each observed change of the same direction (increase or decrease) as the proposed change, it calculates:

```
response_signed = (GTV_after / GTV_before − 1) / delta_pp
```

This measures: *for each 1 percentage point the commission rate moved, how much did GTV change?*

The P10, P50, and P90 of this distribution across programs in the brand's vertical become the three forecast scenarios:

| Scenario | Meaning |
|---|---|
| P10 (conservative) | The bottom 10% of observed outcomes — the change has little or negative effect on GMV |
| P50 (base case) | The median observed outcome — the most likely result |
| P90 (optimistic) | The top 10% of outcomes — the change drives strong GMV uplift |

**For a commission rate increase:** higher response → more GMV gain (creators are more motivated).
**For a commission rate decrease:** higher response → more GMV loss (creators disengage more).

The model automatically selects the vertical-specific elasticity data and falls back to a cross-vertical average if the brand's vertical has insufficient observations.

---

### Cell 4 — Flat Fee Publisher Retention (runs only if `new_flat_fee` > 0)

**The logic:**

When a flat fee is introduced, some publishers who were previously driven purely by commission will disengage from generating sales (the flat fee provides income regardless of performance). This cell measures how many publishers are expected to remain productive.

It queries `fq-platform.strategy_sandbox.vertical_flatfee_productivity`, which shows — for each program category and flat fee size tier — what percentage of publishers generate GMV. The proposed flat fee amount is bucketed into one of these tiers:

| Flat fee range | Bucket |
|---|---|
| $0 | `0` (baseline) |
| $1–$50 | `1–50` |
| $51–$250 | `50–250` |
| $251–$500 | `250–500` |
| $501–$1,000 | `500–1000` |
| $1,001–$2,000 | `1000–2000` |
| Over $2,000 | `2000+` |

The **retention factor** is calculated as:

```
retention_factor = pct_publishers_with_gmv (at fee tier) / pct_publishers_with_gmv (no fee)
```

For example, if 95% of publishers generate GMV at no flat fee, and only 70% do at the proposed fee level, the retention factor is 73.7%. This is applied as a one-time step reduction to the publisher base at the start of the forecast.

---

### Cell 5 — Combined Forward Forecast

This is the core of the model. For each of `forecast_months` months:

1. **Publisher growth:** the base grows at `avg_pub_growth` per month from the retention-adjusted starting point.
2. **GMV:** `publishers × hist_gmv_per_pub × commission_multiplier`
   - The commission multiplier from Cell 3 is applied for all three scenarios (P10/P50/P90).
   - If no commission change, multiplier = 1.0.
3. **Costs:**
   - Commission payouts = `GMV × effective_commission_rate`
   - Flat fee costs = `publishers × new_flat_fee` (paid to all enrolled publishers)
   - Gift costs = `new_publishers_this_month × avg_gift_costs`
   - **Total cost = sum of all three** (a single line, not split out in charts)
4. **ROAS** = `GMV / total_costs`

All three scenarios (P10/P50/P90) are computed in parallel and stored in `forecast_pd`.

**When both changes are active:** the commission multiplier scales per-publisher GMV, and the flat fee retention scales the publisher base. These compound independently.

---

### Cell 6 — Historical Baseline Summary

Prints a KPI summary (total GMV, total costs, ROAS, average commission rate) and displays a month-by-month historical table. This establishes the baseline against which the forecast is compared.

---

### Cells 7–9 — Executive Charts

All three charts use the same design language:
- Clean white background, no chart border
- Historical period shown as solid lines
- Forecast period shown with dashed/dash-dot lines
- Blue shaded band = conservative-to-optimistic range (P10 to P90)
- Single grey vertical divider marks where the forecast begins
- Dollar values auto-formatted as `$1.2M`, `$450K`, etc.

**Chart A (Cell 7) — Monthly Revenue & Total Cost**

Shows monthly GMV (revenue) and total program cost on the left axis, and ROAS on the right axis. The forecast GMV band shows the uncertainty range.

**Chart B (Cell 8) — ROAS Over Time**

Focuses on return on spend. A dotted line at ROAS = 1 marks the break-even point. Useful for quickly seeing whether the proposed change improves or degrades program efficiency.

**Chart C (Cell 9) — Cumulative Revenue & Investment**

Shows the running total of revenue versus total investment since the start of the historical period. The annotation at the end of the forecast shows the projected cumulative revenue at the forecast horizon.

---

## Data Sources

| Table | Project | Purpose |
|---|---|---|
| `strategy_sandbox.brand_creator_agg` | `fq-platform` | Brand's actual monthly history: GMV, GTV, publishers, AOV, commission rate |
| `strategy_sandbox.ioterms_gtv` | `fq-platform` | Per-publisher GTV before and after real commission rate changes — used to derive elasticity |
| `strategy_sandbox.vertical_flatfee_productivity` | `fq-platform` | % of publishers with GMV at each flat fee tier, by program category |
| `analytics.program` | `prod-data-enablement` | Brand's benchmarking vertical |
| `analytics.partnership_affiliation` | `prod-data-enablement` | Brand's primary program category and active publisher count |

---

## Output Metrics Glossary

| Term | Definition |
|---|---|
| **Revenue / GMV** | Gross Merchandise Value — the total value of sales driven through the affiliate program |
| **Total Program Cost** | Commission payouts + flat fee payments + gift costs combined into a single figure |
| **ROAS** | Return on Ad Spend = GMV / Total Program Cost. A ROAS of 5x means every $1 spent drove $5 in sales |
| **P10 (conservative)** | The outcome that only 10% of comparable historical changes performed worse than — a cautious scenario |
| **P50 (base case)** | The median outcome — the most likely result based on historical data |
| **P90 (optimistic)** | The outcome that 90% of comparable changes performed worse than — a best-case scenario |
| **Publisher retention factor** | The fraction of publishers expected to remain actively generating sales after a flat fee is introduced |
| **Commission elasticity** | How much GMV changes per 1 percentage point move in the commission rate, based on observed platform history |

---

## Scenario Bands

The P10/P50/P90 range is driven by the **commission elasticity distribution** from `ioterms_gtv`. The key insight is that when commission rates have changed historically, some programs responded strongly (large GMV change) and others barely moved. The three scenarios represent where this brand's response is likely to fall within that distribution.

When **no commission change** is modelled (flat fee only), all three scenarios produce identical GMV values (the elasticity multiplier = 1.0 for all). The uncertainty in that case is purely from the flat fee retention estimate, which is a single point value rather than a distribution.

---

## Key Parameters & How to Calibrate Them

| Parameter | Where it comes from | How to override |
|---|---|---|
| `hist_gmv_per_pub` | Automatically derived from `brand_creator_agg` (mean GMV/publisher across history) | Not directly overridable — use a longer or shorter history window by filtering `brand_creator_agg` |
| `avg_pub_growth` | Automatically derived from month-over-month change in publisher count across history | Not directly overridable — reflect intended growth in the flat fee widget or discuss with the CS team |
| `flat_fee_retention` | Derived from `vertical_flatfee_productivity` for the brand's category at the proposed fee bucket | If the benchmark data looks wrong, manually set `flat_fee_retention = <value>` after Cell 4 |
| `comm_gmv_mult_p50` | P50 of observed `response_signed` for the brand's vertical from `ioterms_gtv` | If the vertical has few observations, the model falls back to a cross-vertical average automatically |

---

## Known Limitations

1. **Commission elasticity is a 1-month snapshot.** The `ioterms_gtv` table measures GTV one month before vs. one month after the rate change. Long-term effects (e.g., creators gradually adjusting behaviour over 6–12 months) are not captured. The forecast applies the multiplier as a permanent step-change from month 1.

2. **Flat fee retention is a cross-sectional benchmark.** The `vertical_flatfee_productivity` data reflects publishers *already in* programs with flat fees, not the dynamic effect of introducing a flat fee to a currently commission-only program. Actual retention may differ.

3. **Publisher growth rate is extrapolated.** The forecast assumes the brand's historical average growth rate continues unchanged. A flat fee introduction or commission cut could affect new publisher recruitment — this is not currently modelled separately.

4. **No seasonal adjustment.** The forecast applies a flat monthly multiplier without adjusting for seasonal peaks (e.g., Q4 holiday uplift). For seasonal programs, interpret the ROAS chart with this in mind.

5. **Single elasticity applied uniformly.** The commission multiplier is applied equally to all publishers. In reality, some publishers (e.g., high-GMV affiliates) may respond differently to rate changes than smaller ones.

---

## Maintenance Notes

- **`ioterms_gtv` data currency:** This table is updated as new commission rate changes occur on the platform. No action needed — each run queries live data.
- **`vertical_flatfee_productivity` data currency:** Updated periodically. Check the table's `LastModifiedTime` if flat fee estimates seem outdated.
- **`brand_creator_agg` history window:** Currently queries all available history with no date filter. If a brand has a very long history that is no longer representative, add a `AND event_month >= 'YYYY-MM-01'` filter in Cell 1.
- **Adding new verticals:** If `ioterms_gtv` has no data for a vertical, the model falls back to a cross-vertical average automatically and prints a warning.
