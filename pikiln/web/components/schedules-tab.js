import { html, useState, useEffect, useRef } from '../app.js';
import { c2f } from '../lib/utils.js';

// Vendored locally — see web/lib/vendor/.
const UPLOT_CSS = '/lib/vendor/uPlot.min.css';
const UPLOT_JS  = '/lib/vendor/uPlot.iife.min.js';

// Schedules tab — independent of what the controller has loaded. Pick a
// schedule from the list (which mirrors the controller's data/schedules/),
// edit its segments in a table, and see a live preview of the firing curve
// alongside. Saves go through the same `saveSchedule` command the controller
// already understands.
export function SchedulesTab({ state, ws }) {
  const [titles, setTitles] = useState([]);   // schedule titles from server
  const [selected, setSelected] = useState(''); // which we're editing
  const [title, setTitle] = useState('');
  const [segments, setSegments] = useState([]);
  const [cone, setCone] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [loadError, setLoadError] = useState('');
  // Remember the title we last asked for so we can identify which response
  // is ours (responses go to all browsers through the relay).
  const pendingTitle = useRef(null);

  // ── Schedule list + load + save/delete responses ─────────────────────
  useEffect(() => {
    function onMsg(e) {
      const m = e.detail;
      if (m.type === 'response' && m.action === 'getScheduleList') {
        setTitles(m.data || []);
      } else if (m.type === 'response' && m.action === 'getSchedule') {
        // Only accept the response if it's for the schedule we're waiting on
        const data = m.data;
        if (!data || data.title !== pendingTitle.current) return;
        setTitle(data.title || '');
        setCone(data.cone || '');
        setSegments((data.segments || []).map(s => ({ ...s })));
        setDirty(false);
        setLoadError('');
        pendingTitle.current = null;
      } else if (m.type === 'response' && m.action === 'error' && pendingTitle.current) {
        setLoadError(m.message || 'load failed');
        pendingTitle.current = null;
      } else if (m.type === 'response' && m.action === 'saveSchedule') {
        if (m.data?.ok) { setSavedAt(new Date()); setDirty(false); }
      } else if (m.type === 'response' && m.action === 'deleteSchedule') {
        // After delete, clear the editor if it was the one we just removed
        if (m.data?.ok && selectedRef.current === m.data?.title) {
          setSelected(''); setTitle(''); setSegments([]); setCone(''); setDirty(false);
        }
      }
    }
    function onOpen() { ws.send('getScheduleList'); }
    ws.addEventListener('message', onMsg);
    ws.addEventListener('open', onOpen);
    ws.send('getScheduleList');
    return () => {
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('open', onOpen);
    };
  }, []);

  // Mirror `selected` into a ref so the long-lived message handler above
  // can read the current value without re-binding.
  const selectedRef = useRef('');
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // ── Load the picked schedule ─────────────────────────────────────────
  function pick(name) {
    if (dirty && !confirm('Discard unsaved edits?')) return;
    setSelected(name);
    if (!name) {
      setTitle(''); setSegments([]); setCone(''); setDirty(false);
      pendingTitle.current = null;
      return;
    }
    setLoadError('');
    pendingTitle.current = name;
    ws.send('getSchedule', { title: name });
  }

  // ── Segment editing ──────────────────────────────────────────────────
  function update(idx, field, value) {
    setSegments(segments.map((s, i) => {
      if (i !== idx) return s;
      const next = { ...s, [field]: value };
      // Convenience: when the operator first types a Cone target into a
      // segment that currently has Hold=0, default the cap to 30 minutes
      // so the segment actually holds rather than skipping straight past.
      // They can edit the 30 to whatever they want; we only nudge once,
      // and never overwrite a non-zero existing cap.
      if (field === 'holdToCone' && String(value).trim() && !Number(s.hold)) {
        next.hold = 30;
      }
      return next;
    }));
    setDirty(true);
  }
  function addSegment() {
    const last = segments[segments.length - 1];
    setSegments([...segments, {
      rate: last?.rate ?? 200,
      temp: last?.temp ?? 1000,
      hold: 0, holdToCone: '', fanon: false, note: '',
    }]);
    setDirty(true);
  }
  function removeSegment(idx) {
    setSegments(segments.filter((_, i) => i !== idx));
    setDirty(true);
  }
  function newSchedule() {
    if (dirty && !confirm('Discard unsaved edits?')) return;
    setSelected('');
    setTitle('Untitled');
    setCone('');
    setSegments([{ rate: 200, temp: 250, hold: 0, holdToCone: '', fanon: false, note: '' }]);
    setDirty(true);
  }

  function save() {
    if (!title.trim()) { alert('Title is required'); return; }
    const payload = {
      title: title.trim(),
      cone: cone || '',
      'units-rate': '°F/hr',
      'units-temp': '°F',
      'units-hold': 'min',
      'units-fanon': 'true/false',
      segments: segments.map(s => {
        const seg = {
          rate: Number(s.rate) || 0,
          temp: Number(s.temp) || 0,
          hold: Number(s.hold) || 0,
          fanon: Boolean(s.fanon),
          note: s.note || '',
        };
        // Cone-target hold: segment soaks until heat work hits this cone OR
        // `hold` minutes elapse (whichever first). Only emit when set so
        // plain time-only segments round-trip without the extra field.
        const ctc = (s.holdToCone || '').trim();
        if (ctc) seg.holdToCone = ctc;
        return seg;
      }),
    };
    ws.send('saveSchedule', { schedule: payload });
    // Server response handler will flip dirty=false and update savedAt.
  }

  function del() {
    if (!selected) return;
    if (!confirm(`Delete schedule "${selected}"? This cannot be undone.`)) return;
    ws.send('deleteSchedule', { title: selected });
    // Response handler will clear the editor and the broadcasted list update
    // will remove it from the sidebar.
  }

  // ── Render ───────────────────────────────────────────────────────────
  const hasEdits = title || segments.length > 0;

  return html`
    <div class="schedules-tab">
      <div class="two-col">
        <!-- Left: list -->
        <div>
          <div class="section">
            <div class="section-title">
              Schedules
              <button class="btn-small btn-secondary" onclick=${newSchedule}>+ New</button>
            </div>
            ${titles.length === 0 && html`<div class="muted">No schedules yet.</div>`}
            <ul class="schedule-list">
              ${titles.map(t => html`
                <li>
                  <button
                    class="schedule-list-item ${selected === t ? 'active' : ''}"
                    onclick=${() => pick(t)}
                  >${t}</button>
                </li>
              `)}
            </ul>
            ${loadError && html`<div class="error">Load failed: ${loadError}</div>`}
          </div>
        </div>

        <!-- Right: editor -->
        <div>
          ${hasEdits ? html`
            <div class="section">
              <div class="section-title">
                ${selected ? `Editing "${selected}"` : 'New schedule'}
                ${dirty && html`<span class="dirty-flag">● unsaved</span>`}
              </div>

              <div class="edit-row">
                <label>Title:</label>
                <input type="text" value=${title}
                  onInput=${e => { setTitle(e.target.value); setDirty(true); }} />
              </div>
              <div class="edit-row">
                <label>Cone:</label>
                <input type="text" value=${cone} style="max-width:80px"
                  placeholder="6, 04, …"
                  onInput=${e => { setCone(e.target.value); setDirty(true); }} />
              </div>

              <table class="segment-table">
                <thead>
                  <tr>
                    <th>#</th><th>Rate °F/hr</th><th>Temp °F</th>
                    <th title="Hold duration in minutes. When a Cone target is set, this is the maximum cap.">Hold min</th>
                    <th title="Optional. Hold soaks until accumulated heat work reaches this cone (e.g. 6, 04), capped by Hold min.">Cone target</th>
                    <th>Fan</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  ${segments.map((seg, i) => html`
                    <tr>
                      <td>${i + 1}</td>
                      <td><input type="number" value=${seg.rate}
                        onInput=${e => update(i, 'rate', e.target.value)} /></td>
                      <td><input type="number" value=${seg.temp}
                        onInput=${e => update(i, 'temp', e.target.value)} /></td>
                      <td><input type="number" value=${seg.hold}
                        onInput=${e => update(i, 'hold', e.target.value)} /></td>
                      <td><input type="text" value=${seg.holdToCone || ''}
                        placeholder="e.g. 6" style="max-width:70px"
                        onInput=${e => update(i, 'holdToCone', e.target.value)} /></td>
                      <td><input type="checkbox" checked=${seg.fanon}
                        onChange=${e => update(i, 'fanon', e.target.checked)} /></td>
                      <td><button class="btn-small btn-danger"
                        onclick=${() => removeSegment(i)}>X</button></td>
                    </tr>
                  `)}
                </tbody>
              </table>

              <div class="edit-actions">
                <button class="btn-small" onclick=${addSegment}>+ Segment</button>
                <button class="btn-start btn-small" onclick=${save}
                  disabled=${!dirty || !title.trim()}>Save</button>
                ${selected && html`
                  <button class="btn-danger btn-small" onclick=${del}
                    disabled=${state.mode === 'running' && state.schedule?.title === selected}
                    title=${state.mode === 'running' && state.schedule?.title === selected
                      ? 'Cannot delete the schedule that is currently firing'
                      : ''}>Delete</button>
                `}
                ${savedAt && html`<span class="muted small">saved ${fmtTime(savedAt)}</span>`}
              </div>
            </div>

            <${PreviewCurve} segments=${segments} />
          ` : html`
            <div class="section muted">
              ← Pick a schedule to edit, or click + New
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Live preview of the schedule being edited ─────────────────────────
// Computes (minute, °F) points from the segments and draws them with uPlot
// (same library FiringCurve uses, so the look matches). Re-renders whenever
// segments change.
function PreviewCurve({ segments }) {
  const chartRef = useRef(null);
  const uplotRef = useRef(null);
  const [loaded, setLoaded] = useState(!!window.uPlot);

  useEffect(() => {
    if (window.uPlot) { setLoaded(true); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = UPLOT_CSS;
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = UPLOT_JS;
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (!loaded || !chartRef.current || !window.uPlot) return;

    const points = plannedFromSegments(segments);
    if (points.length < 2) {
      if (uplotRef.current) { uplotRef.current.destroy(); uplotRef.current = null; }
      chartRef.current.innerHTML = '<div class="chart-placeholder">Add segments to preview</div>';
      return;
    }
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const data = [xs, ys];

    if (uplotRef.current) {
      uplotRef.current.setData(data);
    } else {
      chartRef.current.innerHTML = '';
      uplotRef.current = new window.uPlot({
        width: chartRef.current.offsetWidth || 600,
        height: 240,
        legend: { show: false },
        scales: { x: { time: false } },
        axes: [
          { label: 'Minutes', stroke: '#888', grid: { stroke: '#2a2a4e' } },
          { label: '°F',  stroke: '#888', grid: { stroke: '#2a2a4e' } },
        ],
        series: [
          {},
          { label: 'Planned', stroke: '#e94560', width: 2, spanGaps: true },
        ],
      }, data, chartRef.current);
    }
  }, [loaded, JSON.stringify(segments)]);

  return html`
    <div class="section">
      <div class="section-title">Preview</div>
      <div ref=${chartRef} class="chart-container"></div>
    </div>
  `;
}

// Compute (minute, °F) waypoints for a sequence of segments, starting from
// 70°F. Each segment ramps from the current temp to seg.temp at seg.rate,
// then holds at seg.temp for seg.hold minutes.
function plannedFromSegments(segments, startF = 70) {
  const out = [{ x: 0, y: startF }];
  let t = 0, temp = startF;
  for (const seg of segments) {
    const rate = Number(seg.rate) || 0;
    const target = Number(seg.temp) || 0;
    const hold = Number(seg.hold) || 0;
    if (rate > 0 && target !== temp) {
      const ramp = Math.abs(target - temp) / rate * 60;  // minutes
      t += ramp; temp = target;
      out.push({ x: t, y: temp });
    } else {
      // Zero rate or no temp change → instantaneous step at current t
      temp = target;
      out.push({ x: t, y: temp });
    }
    if (hold > 0) {
      t += hold;
      out.push({ x: t, y: temp });
    }
  }
  return out;
}
