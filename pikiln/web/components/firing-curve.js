import { html, useState, useEffect, useRef } from '../app.js';
import { c2f } from '../lib/utils.js';
import { RING_COLORS } from '../lib/ring-colors.js';

// Vendored locally so the chart loads at the kiln with no internet.
// Files come from npm uplot@1.6.31; see web/lib/vendor/UPLOT-LICENSE.
const UPLOT_CSS = '/lib/vendor/uPlot.min.css';
const UPLOT_JS  = '/lib/vendor/uPlot.iife.min.js';

export function FiringCurve({ state }) {
  const chartRef = useRef(null);
  const uplotRef = useRef(null);
  const [loaded, setLoaded] = useState(false);

  // Load uPlot CSS + JS on first mount
  useEffect(() => {
    if (window.uPlot) { setLoaded(true); return; }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = UPLOT_CSS;
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = UPLOT_JS;
    script.onload = () => setLoaded(true);
    script.onerror = () => console.error('Failed to load uPlot');
    document.head.appendChild(script);
  }, []);

  // Create/update chart
  useEffect(() => {
    if (!loaded || !chartRef.current || !window.uPlot) return;

    const sched = state.schedule;
    if (!sched) {
      if (uplotRef.current) { uplotRef.current.destroy(); uplotRef.current = null; }
      return;
    }

    const planned = sched.planned || [];
    // Per-ring histories from getStatus. histories[0] = ring 1 (Bottom),
    // [1] = ring 2 (Mid), [2] = ring 3 (Top). Each is an array of {x,y}
    // points in minutes / \u00B0C.
    //
    // Backward compatibility: older controller firmware sent a single flat
    // `history` array (round-robin'd across rings). When that's the only
    // thing on the wire, we route it to ring 1's slot so the operator still
    // sees a curve \u2014 the other two series stay empty until the Pi picks up
    // the new build.
    let histories;
    if (Array.isArray(sched.histories) && sched.histories.length === 3) {
      histories = sched.histories;
    } else if (Array.isArray(sched.history)) {
      histories = [sched.history, [], []];
    } else {
      histories = [[], [], []];
    }

    // Build a single sorted x-axis with all time points (in minutes). uPlot
    // wants one x array shared across series, so we union every series'
    // x-values and back-fill nulls where a series has no data at that x.
    // spanGaps:true on each series tells uPlot to draw through those nulls.
    const xSet = new Set();
    for (const p of planned) xSet.add(p.x);
    for (const arr of histories) for (const p of arr) xSet.add(p.x);
    const xs = [...xSet].sort((a, b) => a - b);

    if (xs.length === 0) return;

    const plannedMap = new Map(planned.map(p => [p.x, p.y]));
    const ringMaps = histories.map(arr => new Map(arr.map(p => [p.x, p.y])));

    const xData = xs;
    const plannedY = xs.map(x => plannedMap.has(x) ? c2f(plannedMap.get(x)) : null);
    const ringYs = ringMaps.map(m =>
      xs.map(x => m.has(x) ? c2f(m.get(x)) : null));

    // Series-array order also determines uPlot draw order \u2014 earlier series
    // are painted first. We want the planned dashed line drawn LAST so it
    // sits on top of the three ring lines (which often overlap at the same
    // y near the planned trajectory and would otherwise hide it).
    const data = [xData, ...ringYs, plannedY];

    if (uplotRef.current) {
      uplotRef.current.setData(data);
    } else {
      chartRef.current.innerHTML = '';
      // Ring colors come from the shared RING_COLORS palette \u2014 same values
      // the dashboard uses for the accent strip under each temp tile, so
      // the operator can match a tile to its line without reading the
      // chart legend. Labels still describe the position (Bottom/Mid/Top)
      // for cross-referencing log lines.
      const ringLabels = state.ringPositionLabels || ['Ring 1', 'Ring 2', 'Ring 3'];
      const ringSeries = ringYs.map((_, i) => ({
        label: `${ringLabels[i]} (Ring ${i + 1})`,
        stroke: RING_COLORS[i],
        width: 2,
        spanGaps: true,
      }));
      const opts = {
        width: chartRef.current.offsetWidth || 600,
        height: 280,
        // Legend is off — the per-ring color cue lives on the dashboard
        // temp tiles (see RING_COLORS strip below the value), avoiding
        // duplicate visual chrome and keeping the chart area larger.
        legend: { show: false },
        scales: {
          x: { time: false },
          // Explicit y-range. uPlot's default autoscale picks the data
          // min/max but stalls when most series are sparse (mostly nulls
          // from spanGaps:true ring series early in a firing), leaving the
          // y-axis blank. We walk every series' data and bound the range
          // ourselves so the axis ticks always render — and the planned
          // schedule curve is visible from t=0 even before any firing data
          // is recorded.
          y: {
            range: (u, dmin, dmax) => {
              let min = Infinity, max = -Infinity;
              // u.data[0] is the x array; series data starts at index 1.
              for (let i = 1; i < u.data.length; i++) {
                const arr = u.data[i];
                if (!arr) continue;
                for (const v of arr) {
                  if (v != null && Number.isFinite(v)) {
                    if (v < min) min = v;
                    if (v > max) max = v;
                  }
                }
              }
              if (min === Infinity) return [0, 100];   // no data anywhere
              if (min === max) { min -= 10; max += 10; } // single-point case
              const pad = Math.max(20, (max - min) * 0.05);
              return [min - pad, max + pad];
            },
          },
        },
        axes: [
          {
            label: 'Minutes',
            stroke: '#888',
            grid: { stroke: '#2a2a4e' },
          },
          {
            label: '\u00B0F',
            stroke: '#888',
            grid: { stroke: '#2a2a4e' },
          },
        ],
        series: [
          {},
          ...ringSeries,
          {
            label: 'Planned',
            stroke: '#cccccc',
            width: 2,
            dash: [6, 4],
            spanGaps: true,
          },
        ],
      };
      uplotRef.current = new window.uPlot(opts, data, chartRef.current);
    }
  }, [loaded,
      state.schedule?.histories?.[0]?.length,
      state.schedule?.histories?.[1]?.length,
      state.schedule?.histories?.[2]?.length,
      state.schedule?.history?.length,        // legacy single-array fallback
      state.schedule?.planned?.length]);

  // Resize handler
  useEffect(() => {
    if (!uplotRef.current || !chartRef.current) return;
    const ro = new ResizeObserver(() => {
      if (uplotRef.current && chartRef.current) {
        uplotRef.current.setSize({ width: chartRef.current.offsetWidth, height: 280 });
      }
    });
    ro.observe(chartRef.current);
    return () => ro.disconnect();
  }, [loaded]);

  return html`
    <div class="section">
      <div class="section-title">Firing Curve</div>
      <div ref=${chartRef} class="chart-container">
        ${!state.schedule && html`<div class="chart-placeholder">No schedule loaded</div>`}
      </div>
    </div>
  `;
}
