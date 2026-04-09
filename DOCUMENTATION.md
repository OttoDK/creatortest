# Creator Program Performance Forecasting Tool — Documentation

**Notebooks:** `Sales_v2.ipynb` · `v1_test.ipynb`  
**Platform:** Databricks (PySpark + BigQuery)  
**Audience:** Sales, Strategy & Consulting teams

---

## Table of Contents

1. [What This Tool Does](#1-what-this-tool-does)
2. [How to Use It](#2-how-to-use-it)
3. [Input Widgets Reference](#3-input-widgets-reference)
4. [Pipeline Architecture](#4-pipeline-architecture)
5. [Stage-by-Stage Explanation](#5-stage-by-stage-explanation)
6. [Data Sources](#6-data-sources)
7. [Output Metrics Glossary](#7-output-metrics-glossary)
8. [Charts](#8-charts)
9. [Key Parameters & How to Calibrate Them](#9-key-parameters--how-to-calibrate-them)
10. [Scenario Bands (P10 / P50 / P90)](#10-scenario-bands-p10--p50--p90)
11. [Known Limitations](#11-known-limitations)
12. [Maintenance Guide](#12-maintenance-guide)

---

## 1. What This Tool Does

This notebook forecasts 36 months of performance for a prospective creator/affiliate marketing program. Given a set of brand parameters entered via Databricks widgets, it answers three core questions:

- **How many creators will apply and get hired?** — predicted via a trained Random Forest classifier
- **How much content will those creators produce?** — estimated from compensation structure and historical posting frequency
- **What revenue, cost, and ROAS will the program generate?** — computed month-by-month using real vertical conversion rate data

The forecast is expressed as three scenarios — **P10 (conservative)**, **P50 (base case)**, and **P90 (optimistic)** — to communicate uncertainty clearly rather than presenting a false single-point estimate.

---

## 2. How to Use It

1. Open the notebook in Databricks and run **Cell 0** (imports/Spark setup) first.
2. Run **Cell 1** to initialise the widgets. The widget panel will appear at the top of the notebook.
3. Fill in all widgets with the brand's details (see [Section 3](#3-input-widgets-reference)).
4. Run cells **2 through 11** in order. Each cell depends on variables set by the previous one — do not skip cells.
5. Read the printed summaries and review the four charts at the bottom.

> **Re-running with different inputs:** Update widget values and re-run from Cell 2. You do not need to restart the cluster.

---

## 3. Input Widgets Reference

| Widget | Type | Default | Description |
|---|---|---|---|
| `aov` | Text | 350 | Average Order Value in USD. The brand's typical transaction value. Used in every revenue calculation. |
| `commission_rate` | Text | 0.08 | Affiliate commission rate as a decimal (e.g. `0.08` = 8%). Determines both variable program cost and creator acceptance rate. |
| `flat_fee_cost_per_post` | Text | 200 | How much the brand pays per creator post as a flat fee. Set to `0` for commission-only programs. |
| `flat_fee_total_budget` | Text | 200 | Total annual flat-fee budget in USD. This is spread evenly as a monthly fixed cost in the revenue model. |
| `Vertical` | Dropdown | Department Stores | The brand's industry category (24 options). Drives conversion rates, clicks-per-post benchmarks, and base creator acceptance rates. |
| `Product gifting` | Dropdown | No | Whether the brand sends free product to creators. Increases posting frequency estimate. |
| `Brand Awarnes` | Dropdown | Low | The brand's existing awareness level among creators. Feeds directly into the RF classifier as a feature. |
| `Expected activity from Brand/Support from consulting teams` | Dropdown | Medium | How actively the brand and its consulting team will support the program. Maps to `program_rating` (Low→1.0, Medium→3.0, High→4.5) as an RF feature. |
| `Brand recruitment drive` | Dropdown | Low | How aggressively the brand will drive creator recruitment. Applies a post-prediction multiplier to application estimates (Low→1.0×, Medium→1.3×, High→1.65×). |
| `paid_investment` | Text | 0 | Annual paid media budget in USD. Set to `0` to model creator-only program. |
| `cpa` | Text | 0 | Cost per Acquisition for paid media. Required alongside `paid_investment` to enable the paid media scenario. |
| `program_start_month` | Dropdown | 1 | Calendar month the program launches (1 = January). Used to align the seasonal conversion rate overlay with real calendar months. |

---

## 4. Pipeline Architecture

```
Widget Inputs
     │
     ▼
[Cell 2]  Feature engineering + RF model inference
     │         └─ Loads: /dbfs/tmp/models/creator_applications_rf
     │
     ▼
[Cell 3]  Bucket → P10/P50/P90 application estimate
     │         └─ BUCKET_STATS (empirical bucket means & percentiles)
     │         └─ Brand recruitment drive multiplier applied
     │
     ▼
[Cell 4]  Creator hiring estimate
     │         └─ Dynamic acceptance rate (vertical × commission × widget)
     │         └─ Outputs: creators_hired_p10, creators_hired_p50, creators_hired_p90
     │
     ▼
[Cell 5]  Conversion rate lookup + Seasonal index setup
     │         └─ Queries: fq-platform.strategy_sandbox.conversion_per_vertical_perM
     │         └─ Builds: seasonal_multiplier() function
     │
     ▼
[Cell 6]  Posts-per-creator estimate
     │         └─ Tries: fq-platform.strategy_sandbox.creator_posting_frequency_by_program
     │         └─ Falls back to rule-based logic if BQ table unavailable
     │
     ▼
[Cell 7]  36-Month Revenue Loop (P10 / P50 / P90 scenarios)
     │         └─ S-curve creator ramp (logistic, midpoint month 15)
     │         └─ Monthly churn: 2.5%/month applied to active pool
     │         └─ Vertical-specific clicks per post (CLICKS_PER_POST_BY_VERTICAL)
     │         └─ Seasonal multiplier applied to conversion rates
     │         └─ Outputs: revenue_df (Spark DataFrame, 36 rows × ~30 columns)
     │
     ▼
[Cells 8–11]  Charts
               ├─ Chart 1: Monthly GMV + cost + ROAS with P10–P90 band
               ├─ Chart 2: Creator ramp with churn + monthly posts
               ├─ Chart 3: Cumulative GMV, commission, cost + paid media overlay
               └─ Chart 4: Cumulative net GMV (brand ROI view, break-even line)
```

---

## 5. Stage-by-Stage Explanation

### Cell 0 — Imports & Spark Session
Initialises PySpark and imports the ML pipeline libraries. No logic here — must run first on every cluster restart.

---

### Cell 1 — Widget Definitions
Creates all 13 input widgets. In Databricks, widgets persist their values between runs; you only need to update changed values before re-running downstream cells.

---

### Cell 2 — Feature Engineering & RF Prediction

**What it does:**
1. Reads all widget values into Python variables.
2. Maps qualitative inputs to numeric/categorical model features:
   - `brand_support_widget` → `program_rating` (Low=1.0, Medium=3.0, High=4.5)
   - `product_gifting` → `gifting_cat` ("yes"/"no")
   - `brand_awareness_widget` → `brand_awareness` (lowercased)
3. Builds a single-row Spark DataFrame as model input.
4. Loads the pre-trained Random Forest pipeline from `/dbfs/tmp/models/creator_applications_rf`.
5. Runs inference and extracts the full 5-element probability vector (`prob_list`).
6. Computes a `recruit_drive_multiplier` from the Brand Recruitment Drive widget (this feature was not in the training data, so it is applied post-prediction rather than fed to the model).

**Key output variables:** `prob_list`, `recruit_drive_multiplier`, `vertical`, `commission_rate`, `aov`, `start_month`

---

### Cell 3 — Application Count Estimation (P10 / P50 / P90)

**The problem this solves:**  
The RF model predicts a bucket label (0-10, 11-50, 51-100, 100_plus) with an associated probability. The old approach used `low + (high-low) × p_max` as a point estimate, which is incorrect: class probability reflects *confidence in class membership*, not position within the bucket's range. This produced inflated estimates (e.g. predicting 412 creators when the true range was 100–420).

**The solution:**  
A `BUCKET_STATS` dictionary stores empirical mean, P10, and P90 values for each bucket (derived from training data distributions). The estimate is computed as a weighted expected value using the full probability vector:

```
P50 estimate = sum(p_i × mean_i)   for i in {100_plus, 11-50, 51-100, 0-10, __unknown}
P10 estimate = sum(p_i × p10_i)
P90 estimate = sum(p_i × p90_i)
```

The `recruit_drive_multiplier` is then applied to all three estimates.

**To update BUCKET_STATS from actual training data:**
```sql
SELECT apps_bucket,
       AVG(app_count)                                          AS mean,
       APPROX_QUANTILES(app_count, 10)[OFFSET(1)]             AS p10,
       APPROX_QUANTILES(app_count, 10)[OFFSET(9)]             AS p90
FROM <training_table>
GROUP BY apps_bucket
```

**Key output variables:** `pred_p10`, `pred_p50`, `pred_p90`, `pred_value` (= pred_p50)

---

### Cell 4 — Creator Count (Direct from Model)

**What it does:**  
Passes the P10/P50/P90 estimates from Cell 3 directly through as the creator counts. No acceptance rate conversion is applied.

**Why no acceptance rate:**  
The RF model was trained on the number of creators a program *has* (active hired creators), not on the number of creator applications. The predicted count is already the hired count — applying an acceptance rate on top would incorrectly reduce an already-final figure.

**Key output variables:** `creators_hired_p10`, `creators_hired_p50`, `creators_hired_p90`, `creators_hired` (= p50)

---

### Cell 5 — Conversion Rates & Seasonal Index

**What it does:**  
1. Queries BigQuery for historical conversion rates by vertical and months-since-program-start (months 1–36).
2. Displays the conversion trajectory for the selected vertical.
3. Defines `SEASONAL_INDEX` — a retail calendar multiplier for each calendar month (January–December).
4. Defines `seasonal_multiplier(program_month, start_month)` which maps a program month number to the appropriate calendar month seasonal multiplier.

**Seasonal index values** (normalised so the annual average ≈ 1.0):

| Month | Multiplier | Rationale |
|---|---|---|
| January | 0.87 | Post-holiday slowdown |
| February | 0.83 | Lowest consumer intent |
| March–May | 0.91–0.96 | Spring ramp-up |
| June–September | 0.91–0.99 | Summer plateau |
| October | 1.06 | Pre-holiday ramp |
| November | 1.32 | Black Friday / Cyber Monday |
| December | 1.47 | Peak holiday season |

**Key output variables:** `SEASONAL_INDEX`, `seasonal_multiplier()` function

---

### Cell 6 — Posts Per Creator

**What it does:**  
Estimates how many posts each active creator produces per year.

**Priority:**
1. **BQ lookup (preferred):** Queries `fq-platform.strategy_sandbox.creator_posting_frequency_by_program` for historical averages by vertical and compensation type (flat-fee vs commission-only). Requires ≥ 10 samples to use.
2. **Rule-based fallback:** If the BQ table is unavailable or has insufficient data:
   - Flat-fee programs (fee ≥ 10% of AOV): base range 1–5 posts/year
   - Commission-only programs: base range 0–2 posts/year
   - Gifting bonus: +1.0 post/year if product gifting enabled
   - Brand support bonus: Low=+0, Medium=+0.5, High=+1.0

**Key output variables:** `posts_per_creator`, `has_flat_fee`, `posts_data_source`

---

### Cell 7 — 36-Month Revenue Loop

This is the core computation cell. It runs for all 36 months and three scenarios.

**Step 1 — Paid media setup**  
If both `paid_investment > 0` and `cpa > 0`, monthly paid conversions are computed as `(annual_investment / cpa) / 12`. Otherwise paid media is disabled and all paid columns are zeroed.

**Step 2 — Vertical-specific clicks per post**  
`CLICKS_PER_POST_BY_VERTICAL` provides per-vertical click benchmarks (118–195 clicks/post depending on audience engagement by vertical). Falls back to 165 for unknown verticals. This replaces the old hardcoded `180.0` constant.

**Step 3 — Conversion rates from BQ**  
The same BQ table used in Cell 5 is re-queried and collected into a Python dictionary `conv_by_month = {month_number: conversion_rate}`. If data is missing for a specific month, the last available month's rate is used as a fallback.

**Step 4 — Power-curve creator ramp**  
`power_ramp(m, total_creators)` uses a concave power function (`(m/36)^alpha`, normalised to [10%, 100%]) with `alpha = 0.40`. This produces a front-heavy shape that reflects real program launch behaviour: a burst of recruitment in the first few months as the brand activates its existing network, followed by progressively slower incremental growth.

Approximate milestones with `alpha = 0.40`:

| Month | % of total hired active |
|---|---|
| 1 | 10% |
| 6 | 40% |
| 12 | 58% |
| 18 | 71% |
| 24 | 82% |
| 36 | 100% |

Lower `alpha` → more front-loaded. Higher `alpha` → approaches linear. Tune against observed program cohort data.

**Step 5 — Monthly creator churn**  
`compute_active_with_churn(total_hired)` runs the ramp with a `MONTHLY_CHURN_RATE = 0.025` (2.5%/month ≈ 26% annual attrition). Each month:
- New creators join based on the incremental S-curve target
- The existing pool is reduced by the churn rate
- Churned creators are not replaced (fixed hiring budget)

This is run independently for P10, P50, and P90 hired creator counts.

**Step 6 — Per-month revenue calculation**  
For each month and each scenario:

```
posts_this_month     = active_creators × (posts_per_creator_year / 12)
orders               = posts × clicks_per_post × conversion_rate × seasonal_multiplier
GMV                  = orders × aov
affiliate_commission = GMV × commission_rate
program_cost         = (flat_fee_budget / 12) + affiliate_commission
GMV ROAS             = GMV / program_cost
```

**Key output:** `revenue_df` — a 36-row Spark DataFrame with ~30 columns covering all three scenarios plus paid media columns. Legacy column aliases (`monthly_revenue_no_paid`, `creators_active`, etc.) are preserved for backward compatibility.

---

### Cells 8–11 — Charts

| Cell | Chart | Key Features |
|---|---|---|
| 8 | Monthly GMV, Commission & Cost | P10–P90 shaded GMV band, P50 base line, affiliate commission line, optional paid media line, GMV ROAS on right axis |
| 9 | Creator Ramp & Monthly Posts | P10–P90 active creator band, P50 line, monthly posts on secondary axis |
| 10 | Cumulative GMV, Commission & Cost | Shaded cumulative bands, paid media overlay |
| 11 | Cumulative Net GMV (Brand ROI) | Net GMV = total GMV − program costs, break-even line at zero, paid uplift annotations at months 12/24/36 |

---

## 6. Data Sources

### 6.1 Pre-trained ML Model
- **Location:** `/dbfs/tmp/models/creator_applications_rf`
- **Type:** PySpark `PipelineModel` wrapping a Random Forest classifier
- **Task:** Predicts the creator application count bucket for a new brand
- **Target variable:** `apps_bucket` — one of `{0-10, 11-50, 51-100, 100_plus}`
- **Training features (35-dimensional vector):**

| Feature | Type | Description |
|---|---|---|
| `avg_flat_fee` | Numeric | Average flat fee per post |
| `total_flat_fee` | Numeric | Total annual flat-fee budget |
| `commission_rate` | Numeric | Affiliate commission rate |
| `avg_order_value` | Numeric | Average transaction value |
| `program_rating` | Numeric | Brand support level (1.0 / 3.0 / 4.5) |
| `brand_awareness` | OHE (3) | Low / Medium / High brand awareness |
| `gifting_cat` | OHE (2) | Product gifting yes/no |
| `benchmarking_vertical` | OHE (25) | Industry vertical (25 categories) |

> **Note:** `Brand recruitment drive` and `Creator acceptance rate` are NOT features in this model. The recruitment drive is applied as a post-prediction multiplier; acceptance rate is applied separately in Cell 4.

---

### 6.2 BigQuery — Conversion Rates
- **Table:** `fq-platform.strategy_sandbox.conversion_per_vertical_perM`
- **Project:** `fq-platform`
- **Columns used:** `benchmarking_vertical`, `months_since_start`, `conversion_rate`
- **Description:** Historical click-to-order conversion rates for each vertical, broken down by how many months the creator program has been live. Used to model the trajectory of conversion improvement as the program matures.
- **Query scope:** Months 1–36 for the selected vertical only.

---

### 6.3 BigQuery — Posting Frequency (Optional)
- **Table:** `fq-platform.strategy_sandbox.creator_posting_frequency_by_program`
- **Status:** Optional — the code falls back gracefully if this table doesn't exist.
- **Expected columns:** `benchmarking_vertical`, `has_flat_fee` (BOOL), `posts_per_creator_year`, and aggregated statistics.
- **Purpose:** Provides data-driven posting frequency estimates instead of rule-based fallback logic.

---

### 6.4 Hardcoded Lookup Tables (Calibration Parameters)

These are embedded in the notebook code and represent the best available estimates. They should be updated periodically from real program data.

| Table | Location | Description |
|---|---|---|
| `BUCKET_STATS` | Cell 3 | Empirical mean, P10, P90 creator applications per bucket |
| `SEASONAL_INDEX` | Cell 5 | Monthly retail seasonality multipliers |
| `CLICKS_PER_POST_BY_VERTICAL` | Cell 7 | Average clicks per creator post by vertical |

---

## 7. Output Metrics Glossary

| Metric | Definition |
|---|---|
| **GMV** (Gross Merchandise Value) | Total sales value driven by the creator program: `orders × AOV`. This is the brand's revenue generated through the channel, not the network's earnings. |
| **Affiliate Commission** | What the brand pays the affiliate network for creator-driven sales: `GMV × commission_rate`. This is a subset of program cost. |
| **Program Cost** | Total cost the brand pays to run the creator program: `monthly_flat_fee + affiliate_commission`. |
| **GMV ROAS** | Return on ad spend measured in GMV terms: `GMV / program_cost`. A ROAS of 2.5× means the program generates $2.50 in sales for every $1.00 spent. Note: this is a GMV-based metric, not profit. |
| **Net GMV** | Brand ROI view: `GMV − program_cost`. Represents the incremental sales value after deducting all program costs. Breakeven is where this equals zero. |
| **P10 / P50 / P90** | The 10th, 50th, and 90th percentile scenarios. P50 is the base case. P10 is the conservative scenario (things go less well than expected); P90 is the optimistic scenario. |
| **Affiliate Commission vs Program Cost** | These are related but distinct: commission is only the variable portion of cost; program cost also includes flat fees. A commission-only program has commission = total cost. |

---

## 8. Charts

### Chart 1 — Monthly GMV, Commission & Cost
Shows the month-by-month trajectory of GMV, program cost, and affiliate commission for the P50 scenario, with the P10–P90 range as a shaded band. The right axis shows GMV ROAS (P50). A ROAS below 1.0× (red dashed line) means costs exceed GMV in that month — expected in early months when the creator pool is still small.

### Chart 2 — Creator Ramp & Monthly Posts
Shows how the active creator count grows over 36 months, shaped by the S-curve ramp and monthly churn. The shaded band shows the P10–P90 range of active creators. The secondary axis shows monthly posts from the P50 creator count.

### Chart 3 — Cumulative GMV & Cost
Cumulative versions of Chart 1. Useful for understanding total program value at months 12, 24, and 36. If paid media is enabled, a separate line shows the cumulative GMV with paid added.

### Chart 4 — Cumulative Net GMV (Brand ROI View)
Shows cumulative GMV minus cumulative program cost — the net value generated for the brand. The zero line is the break-even point; the month at which the line crosses zero is when the program has recouped all its costs. If paid media is enabled, annotations show the incremental uplift from paid media at months 12, 24, and 36.

---

## 9. Key Parameters & How to Calibrate Them

### 9.1 `BUCKET_STATS` (Cell 3)
These values determine the P10/P50/P90 range of the creator application estimates. Current values:

| Bucket | Mean | P10 | P90 |
|---|---|---|---|
| 0-10 | 4 | 1 | 9 |
| 11-50 | 26 | 13 | 46 |
| 51-100 | 70 | 55 | 95 |
| 100_plus | 185 | 110 | 420 |

**To recalibrate from training data:**
```sql
SELECT
    apps_bucket,
    AVG(app_count)                                    AS mean,
    APPROX_QUANTILES(app_count, 10)[OFFSET(1)]        AS p10,
    APPROX_QUANTILES(app_count, 10)[OFFSET(9)]        AS p90,
    COUNT(*)                                          AS sample_size
FROM <training_table>
WHERE app_count IS NOT NULL
GROUP BY apps_bucket
```

### 9.2 `MONTHLY_CHURN_RATE` (Cell 7)
Default: `0.025` (2.5% per month = ~26% annual).

To calibrate from data: compute the monthly survival rate from creator tenure records:
```sql
SELECT
    1 - COUNT(DISTINCT creator_id FILTER (WHERE months_active <= m)) /
        COUNT(DISTINCT creator_id FILTER (WHERE join_month <= m - 1))
FROM creator_tenure_table
```

### 9.3 `power_ramp` parameter (Cell 7)
- `alpha = 0.40` — shape of the front-heavy power curve. Lower values = more creators active in early months; higher values = more linear growth. Calibrate by fitting the curve to observed cohort ramp data (% of final creator count active at months 3, 6, 12).

### 9.4 `CLICKS_PER_POST_BY_VERTICAL` (Cell 7)
Replace with live values once a `creator_post_clicks_by_vertical` BigQuery table is available:
```sql
SELECT benchmarking_vertical, AVG(clicks) AS avg_clicks_per_post
FROM `fq-platform.strategy_sandbox.creator_post_clicks_by_vertical`
GROUP BY 1
```

### 9.5 `RECRUIT_DRIVE_MULTIPLIER` (Cell 2)
Values: Low=1.0×, Medium=1.30×, High=1.65×.

Calibrate by comparing predicted application counts against actual application counts for programs with known recruitment drive levels.

---

## 10. Scenario Bands (P10 / P50 / P90)

The three scenarios originate in Cell 3 and propagate through every subsequent calculation. They represent different outcomes for creator acquisition — driven by uncertainty in the RF model's prediction.

```
RF probability vector
        │
        ▼
  estimate_creator_count_v2()
        │
        ├── P10: sum(p_i × bucket_p10_i)   ← conservative
        ├── P50: sum(p_i × bucket_mean_i)  ← base case
        └── P90: sum(p_i × bucket_p90_i)   ← optimistic
              │
              ▼ × recruit_drive_multiplier
              │
        creators_hired_p10/p50/p90
        (model predicts the hired creator count directly — no acceptance rate step)
              │
              ▼ S-curve + churn (Cell 7)
              │
        actives_p10/p50/p90 (36-month arrays)
              │
              ▼ Revenue loop
              │
        monthly_gmv_p10/p50/p90
```

All costs are computed on the P50 scenario only — because the program's fixed costs (flat fees) and the commission rate don't change between scenarios. Only GMV, orders, and posts differ across scenarios.

---

## 11. Known Limitations

| Limitation | Impact | Potential Fix |
|---|---|---|
| `BUCKET_STATS` values are estimated, not computed from training data | P10/P90 bands may be over/under-wide | Run the calibration SQL in Section 9.1 |
| `CLICKS_PER_POST_BY_VERTICAL` is not live from BQ | Clicks estimate is a static benchmark per vertical | Build `creator_post_clicks_by_vertical` table |
| Posting frequency BQ table may not exist | Falls back to rule-based logic | Populate `creator_posting_frequency_by_program` |
| Creator churn rate is fixed at 2.5% for all verticals | Some verticals have higher/lower retention | Fit per-vertical churn from tenure data |
| S-curve ramp is not fitted to real cohort data | Ramp shape is approximate | Fit k and midpoint to observed program cohort data |
| Seasonal index is generic retail, not vertical-specific | Some verticals have different seasonality patterns | Build a per-vertical seasonal index from BQ calendar data |
| Paid media model is linear (no diminishing returns) | Overestimates paid ROI at high spend levels | Add a saturation curve to the paid media model |
| The RF model does not include `Brand recruitment drive` as a training feature | Recruitment drive effect is approximated post-prediction | Retrain model with this feature included |
| No model accuracy/confidence metric is shown to the user | Users cannot assess how reliable the RF prediction is | Display F1 score / confusion matrix from model evaluation run |

---

## 12. Maintenance Guide

### When to re-run / update

| Trigger | Action |
|---|---|
| New programs have launched and have 12+ months of data | Retrain the RF model; recalibrate `BUCKET_STATS` |
| Conversion rate BQ data updated | No action needed — Cell 5/7 query live data automatically |
| New vertical added to the platform | Add to `VERTICAL_ACCEPTANCE_BASE`, `CLICKS_PER_POST_BY_VERTICAL`, and the widget dropdown in Cell 1 |
| `creator_posting_frequency_by_program` BQ table created | Cell 6 will automatically start using it |

### Model path
The RF pipeline is stored at `/dbfs/tmp/models/creator_applications_rf` and loaded in Cell 2. To deploy a new model version, overwrite this path using `model.save("/dbfs/tmp/models/creator_applications_rf")` after retraining. Back up the old version before overwriting.

### BQ permissions
The notebook uses `gcp_utils.query_bq(query, project="fq-platform")` from `libs.src.gcp_utils`. The cluster must have GCP service account credentials with at least `BigQuery Data Viewer` and `BigQuery Job User` roles on the `fq-platform` project.
