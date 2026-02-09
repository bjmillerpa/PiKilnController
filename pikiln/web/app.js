import { h, render } from 'https://esm.sh/preact@10.25.4';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10.25.4/hooks';
import htm from 'https://esm.sh/htm@3.1.1';

const html = htm.bind(h);
export { html, useState, useEffect, useRef, useCallback };

import { WsClient } from './lib/ws-client.js';
import { Dashboard } from './components/dashboard.js';
import { FiringCurve } from './components/firing-curve.js';
import { SchedulePicker } from './components/schedule-picker.js';
import { ScheduleEditor } from './components/schedule-editor.js';
import { Controls } from './components/controls.js';
import { LogViewer } from './components/log-viewer.js';

const EMPTY_STATE = {
  mode: 'off',
  fanMode: 'off',
  fan: { isOn: false },
  elapsedSeconds: 0,
  temps: [0, 0, 0],
  elements: [{ isOn: false }, { isOn: false }, { isOn: false }],
  schedule: null,
  powerKWHr: 0,
  costPerKWH: 0.12,
  simulation: false,
};

function App() {
  const [state, setState] = useState(EMPTY_STATE);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    const ws = new WsClient();
    wsRef.current = ws;

    ws.addEventListener('open', () => setConnected(true));
    ws.addEventListener('close', () => setConnected(false));
    ws.addEventListener('message', (e) => {
      const msg = e.detail;
      if (msg.type === 'state') setState(msg.data);
    });

    ws.connect();
  }, []);

  const ws = wsRef.current;

  return html`
    <header>
      <h1>PiKiln Controller</h1>
      <div class="header-row">
        <span class="subtitle">Ceramics kiln controller</span>
        <span class="conn-status ${connected ? 'on' : 'off'}">
          ${connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
    </header>

    ${ws && html`
      <${Dashboard} state=${state} />
      <${FiringCurve} state=${state} />
      <div class="two-col">
        <div>
          <${SchedulePicker} state=${state} ws=${ws} />
          <${Controls} state=${state} ws=${ws} />
        </div>
        <div>
          <${ScheduleEditor} state=${state} ws=${ws} />
        </div>
      </div>
      <${LogViewer} ws=${ws} />
    `}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
