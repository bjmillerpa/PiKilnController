import { html, useState, useEffect, useRef } from '../app.js';
import { c2f } from '../lib/utils.js';

const UPLOT_CSS = 'https://unpkg.com/uplot@1.6.31/dist/uPlot.min.css';
const UPLOT_JS = 'https://unpkg.com/uplot@1.6.31/dist/uPlot.iife.min.js';

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
    const history = sched.history || [];

    // Build a single sorted x-axis with all time points (in minutes)
    const xSet = new Set();
    for (const p of planned) xSet.add(p.x);
    for (const p of history) xSet.add(p.x);
    const xs = [...xSet].sort((a, b) => a - b);

    if (xs.length === 0) return;

    // Build lookup maps
    const plannedMap = new Map(planned.map(p => [p.x, p.y]));
    const historyMap = new Map(history.map(p => [p.x, p.y]));

    const xData = xs;
    const plannedY = xs.map(x => plannedMap.has(x) ? c2f(plannedMap.get(x)) : null);
    const actualY = xs.map(x => historyMap.has(x) ? c2f(historyMap.get(x)) : null);

    const data = [xData, plannedY, actualY];

    if (uplotRef.current) {
      uplotRef.current.setData(data);
    } else {
      chartRef.current.innerHTML = '';
      const opts = {
        width: chartRef.current.offsetWidth || 600,
        height: 280,
        scales: { x: { time: false } },
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
          {
            label: 'Planned',
            stroke: '#666',
            width: 2,
            dash: [6, 4],
            spanGaps: true,
          },
          {
            label: 'Actual',
            stroke: '#e94560',
            width: 2,
            spanGaps: true,
          },
        ],
      };
      uplotRef.current = new window.uPlot(opts, data, chartRef.current);
    }
  }, [loaded, state.schedule?.history?.length, state.schedule?.planned?.length]);

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
