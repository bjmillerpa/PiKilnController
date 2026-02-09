import { html, useState, useEffect } from '../app.js';
import { c2f } from '../lib/utils.js';

export function ScheduleEditor({ state, ws }) {
  const [editing, setEditing] = useState(false);
  const [segments, setSegments] = useState([]);
  const [viewSegments, setViewSegments] = useState([]);
  const [title, setTitle] = useState('');
  const [loadedTitle, setLoadedTitle] = useState('');

  const sched = state.schedule;

  // Fetch segments when schedule changes (for read-only view)
  useEffect(() => {
    if (!sched?.title || sched.title === loadedTitle) return;
    fetch(`/api/schedule/${encodeURIComponent(sched.title)}`)
      .then(r => r.json())
      .then(data => {
        setViewSegments(data.segments || []);
        setLoadedTitle(sched.title);
      })
      .catch(() => {});
  }, [sched?.title]);

  if (!sched && !editing) return null;

  function startEdit() {
    setTitle(loadedTitle);
    setSegments(viewSegments.map(s => ({ ...s })));
    setEditing(true);
  }

  function save() {
    const schedule = {
      title,
      'units-rate': '\u00B0F/hr',
      'units-temp': '\u00B0F',
      'units-hold': 'min',
      'units-fanon': 'true/false',
      segments: segments.map(s => ({
        rate: Number(s.rate),
        temp: Number(s.temp),
        hold: Number(s.hold),
        fanon: Boolean(s.fanon),
        note: s.note || '',
      })),
    };
    ws.send('saveSchedule', { schedule });
    setEditing(false);
  }

  function addSegment() {
    setSegments([...segments, { rate: 200, temp: 1000, hold: 0, fanon: false, note: '' }]);
  }

  function removeSegment(idx) {
    setSegments(segments.filter((_, i) => i !== idx));
  }

  function updateSegment(idx, field, value) {
    const updated = segments.map((s, i) =>
      i === idx ? { ...s, [field]: value } : s
    );
    setSegments(updated);
  }

  if (!editing) {
    return html`
      <div class="section">
        <div class="section-title">
          Schedule Segments
          <button class="btn-small" onclick=${startEdit}
            disabled=${state.mode === 'running'}>Edit</button>
        </div>
        <table class="segment-table">
          <thead>
            <tr><th>#</th><th>Rate (\u00B0F/hr)</th><th>Temp (\u00B0F)</th><th>Hold (min)</th><th>Fan</th></tr>
          </thead>
          <tbody>
            ${viewSegments.map((seg, i) => html`
              <tr>
                <td>${i + 1}</td>
                <td>${seg.rate}</td>
                <td>${seg.temp}</td>
                <td>${seg.hold}</td>
                <td>${seg.fanon ? 'Yes' : 'No'}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    `;
  }

  return html`
    <div class="section">
      <div class="section-title">Edit Schedule</div>
      <div class="edit-row">
        <label>Title:</label>
        <input type="text" value=${title}
          onInput=${e => setTitle(e.target.value)} />
      </div>
      <table class="segment-table">
        <thead>
          <tr><th>#</th><th>Rate</th><th>Temp</th><th>Hold</th><th>Fan</th><th></th></tr>
        </thead>
        <tbody>
          ${segments.map((seg, i) => html`
            <tr>
              <td>${i + 1}</td>
              <td><input type="number" value=${seg.rate}
                onInput=${e => updateSegment(i, 'rate', e.target.value)} /></td>
              <td><input type="number" value=${seg.temp}
                onInput=${e => updateSegment(i, 'temp', e.target.value)} /></td>
              <td><input type="number" value=${seg.hold}
                onInput=${e => updateSegment(i, 'hold', e.target.value)} /></td>
              <td><input type="checkbox" checked=${seg.fanon}
                onChange=${e => updateSegment(i, 'fanon', e.target.checked)} /></td>
              <td><button class="btn-small btn-danger" onclick=${() => removeSegment(i)}>X</button></td>
            </tr>
          `)}
        </tbody>
      </table>
      <div class="edit-actions">
        <button class="btn-small" onclick=${addSegment}>+ Segment</button>
        <button class="btn-start btn-small" onclick=${save}>Save</button>
        <button class="btn-small" onclick=${() => setEditing(false)}>Cancel</button>
      </div>
    </div>
  `;
}
