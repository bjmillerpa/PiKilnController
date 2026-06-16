# Thermal-loss analysis

How to extract your kiln's actual heat-loss curve and thermal mass from a
completed firing log — and how to read what the analyzer tells you.

The kiln's thermal model drives a few non-safety behaviors: estimated
time-to-cool, the duty cap that prevents overshoot on slow ramps, and the
predicted max heating rate. As of 2026-06-15 the baseline loss curve is
calibrated against Bruce's empty-kiln calibration firing on 2026-06-12
(three holds at 301/500/700°C giving direct steady-state loss anchors).
Fit residuals are under 1.5% at all three anchors. The previous L&L-
polynomial baseline that shipped originally under-predicted Bruce's
kiln's loss by 2.3–3.0×. The offline analyzer below is what produced
the calibrated coefficients — and what you'd run again if anything
about the kiln changes (new insulation, vent rework, element replacement).

## What the analyzer extracts

Three independent signals come out of one firing:

1. **Cool-down loss curve.** While the kiln is freely cooling (elements
   off after the schedule completes), `Q_loss(T) = -m·c · dT/dt`. The
   temperature trace gives `dT/dt` directly at every temperature the
   kiln passes through.
2. **Hold anchors.** At a steady-state hold the kiln's power input
   exactly balances its loss: `Q_loss(T_hold) = avg input power during
   the hold`. No `m·c` assumption needed — this is the cleanest possible
   measurement at that single temperature.
3. **Thermal mass back-fit.** Divide each hold's direct-loss number by
   the cool-down `dT/dt` at the same temperature and you recover the
   `m·c` for *this firing's load*. A heavily loaded kiln has higher
   `m·c` than an empty one.

Together those three give a parametric heat-loss model:

```
Q(T) = a·(T - T_amb) + b·(T - T_amb)² + c·((T_K)⁴ - (T_amb_K)⁴)
```

The linear term is conduction/convection through the walls; the quadratic
absorbs small nonlinearities; the quartic is Stefan-Boltzmann radiation,
which the baseline polynomial can't capture and which dominates above
about 600°C.

## Running it

From the `pikiln/` directory:

```bash
node scripts/analyze-thermal.js <firing-log> [--csv out.csv]
```

The firing log path can be either the Pi's local copy
(`/opt/pikiln/data/firings/<id>.log`) or the VPS mirror
(`~/kilncontroller/firings/<id>.log`). `--csv` writes the binned points
and hold anchors to a CSV for spreadsheet plotting.

## Reading the output

### Section 1 — Cool-down loss curve

A table binned in 25°C steps showing the median dT/dt in each bin and the
implied loss `Q = m·c · |dT/dt|`. The fourth column compares against
L&L's baseline polynomial. The bar chart is just a visual to spot the
shape of the curve.

What "good" looks like: smooth monotone increase of Q with temperature,
many samples per bin (the `n` column), and ratios to L&L that are
self-consistent across bins. A noisy or non-monotone curve usually means
either too short a cool-down window or fan-on cool-down sections that
shouldn't be pooled with natural cool data.

### Section 2 — Hold anchors

For each hold segment in the firing, the average power consumed during
the hold. This is direct measurement: kiln drew this many watts to
maintain that temperature, so that's its loss at that temperature.

Watch for **short transient holds at the top of a ramp** — when the
PID first arrives at a setpoint it can drive hard for a minute or two
before settling. Those holds tend to read higher than longer
steady-state holds at the same temp. The analyzer flags neither
automatically; if two holds at the same temperature give very
different numbers, trust the longer one.

### Section 3 — `m·c` back-fit

If any hold temperature overlaps with the cool-down range, the
analyzer divides hold-loss by cool-down dT/dt to back out the actual
thermal mass. With a typical load this comes in 20–40% above the L&L
baseline (the baseline assumes ~140 kg of brick alone; the load adds
mass).

The output also rescales the cool-down curve with the back-fit `m·c`
and shows it next to the direct hold-loss values at the same
temperatures — they should match closely (ratio near 1.00). If they
don't, something is off: thermocouple drift, a fan-on segment polluting
the cool-down data, or the load wasn't thermally equilibrated.

### Section 4 — Radiation-aware fit

The three-parameter fit coefficients and residuals. RMS residual under
~300 W on a kiln that loses 1000–6000 W is a good fit. Look at the
"Comparison at anchor points" table to see which data points the fit is
fighting — a large residual at one anchor usually means that anchor is
suspect (transient hold, etc.), not that the fit is broken.

### Section 5 — Extrapolation

Predicted loss at temperatures up to cone 10 (1300°C). Two flags appear
in the rightmost column:

- **`extrapolated`** — above the highest hold anchor; the radiation
  coefficient is poorly constrained from below and the curve here is
  the model's best guess, not a measurement.
- **`> max element power`** — predicted loss exceeds the kiln's total
  element power (11,520 W for three 240 V × 16 A elements). If that
  threshold appears at a temperature you've successfully fired to, the
  radiation slope is overestimated.

## Getting better fits

**One firing is a rough draft.** The fit's quality depends on the
*range and quality* of the data:

- Schedules that end with **uncontrolled cool-down from peak** (most
  bisque/glaze firings) give cool-down dT/dt all the way from peak to
  ambient — the best possible loss-curve data.
- Schedules with **controlled cool-down** (slumping, annealing) give
  less cool-down range — the natural-cool section only starts after
  the last controlled hold finishes. Hold anchors carry more weight.
- **Longer holds at varied temperatures** give more independent
  anchors. A schedule with 30+ minute holds at 5–6 different temps is
  ideal for fitting the loss curve via direct measurement.
- **Avoid running the vent fan during natural cool-down** if you want
  clean data for the loss curve — fan-on cool is a different regime.

A single cone-6 glaze firing with a full peak-to-ambient natural cool
will give a much tighter fit than several glass-slumping or annealing
runs, because the high-temp tail is what's most poorly constrained.

## What the analyzer is *not*

- **Not wired into the live controller.** It's an offline tool. Nothing
  it produces feeds back into the running kiln — the safety paths and
  duty cap still use the L&L baseline. Once we've validated learned
  fits across several firings the plan is to plumb a per-kiln model in
  as an opt-in config flag.
- **Not safe for extrapolation beyond your data.** The "extrapolated"
  flag is the honest answer — don't read the 1200°C number off the
  table and act on it until you have a firing that actually went there.
- **Not currently load-aware.** Each firing produces its own `m·c`
  estimate. Pooling across firings into a kiln-only loss curve (with
  per-firing load mass) is the next iteration.

## Reading firing logs by hand

The analyzer parses the structured log format the controller writes for
every firing. If you want to look directly, the format is:

```
=== FIRING SUMMARY ===
Schedule         <name>
Started          <timestamp>
Max temperature  <peak>
Energy           <kWh> ($cost)
...

=== EVENT LOG ===
<ts>: <ring> Tc: <current°F> Tt: <target°F> rate: <0..1> secs: <on-time>
<ts>: starting <N> min hold
<ts>: starting segment <N>: <T>C @ <rate>C/hr, <H> min hold
<ts>: Schedule complete — entering cool-down monitoring
<ts>: <ring> cooling Tc: <current°F>
<ts>: Cool-down complete (max sensor <T>°F) — run finished
```

Each ring fires once per 15-second cycle; `secs` is the commanded on-time
for that ring's element over the following 15 seconds. During holds the
ring updates continue with their normal cadence and the PID adjusts duty
to maintain temperature. During cool-down monitoring the rings just
report temps every 5 seconds (rotating through 1, 2, 3) and no elements
fire.
