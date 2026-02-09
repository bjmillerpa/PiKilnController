import { html, useState, useEffect } from '../app.js';

export function SchedulePicker({ state, ws }) {
  const [schedules, setSchedules] = useState([]);
  const [selected, setSelected] = useState('');

  useEffect(() => {
    function onMsg(e) {
      const msg = e.detail;
      if (msg.type === 'response' && msg.action === 'getScheduleList') {
        setSchedules(msg.data || []);
      }
    }
    function onOpen() { ws.send('getScheduleList'); }
    ws.addEventListener('message', onMsg);
    ws.addEventListener('open', onOpen);
    // Request list now in case already connected
    ws.send('getScheduleList');
    return () => {
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('open', onOpen);
    };
  }, []);

  function load() {
    if (selected) ws.send('loadSchedule', { title: selected });
  }

  function refresh() {
    ws.send('getScheduleList');
  }

  return html`
    <div class="picker">
      <select value=${selected} onChange=${e => setSelected(e.target.value)}>
        <option value="">-- select schedule --</option>
        ${schedules.map(t => html`
          <option value=${t} selected=${t === state.schedule?.title}>${t}</option>
        `)}
      </select>
      <button class="btn-secondary btn-small" onclick=${load}
        disabled=${!selected || state.mode === 'running'}>Load</button>
      <button class="btn-secondary btn-small" onclick=${refresh}>Refresh</button>
    </div>
  `;
}
