import { html, useState } from '../app.js';

export function Controls({ state, ws }) {
  const running = state.mode === 'running';
  const [testRelay, setTestRelay] = useState(null);

  function start() { ws.send('start'); }
  function stop() { ws.send('stop'); }
  function setFan(mode) { ws.send('setFanMode', { mode }); }

  function toggleRelay(name) {
    if (running) return;
    const isOn = testRelay === name;
    ws.send('testRelay', { relay: name, on: !isOn });
    setTestRelay(isOn ? null : name);
  }

  return html`
    <div class="section">
      <div class="section-title">Controls</div>
      <div class="control-row">
        <button class="btn-start" onclick=${start}
          disabled=${running || !state.schedule}>Start</button>
        <button class="btn-stop" onclick=${stop}
          disabled=${!running}>Stop</button>
      </div>

      <div class="control-row">
        <span class="control-label">Fan:</span>
        ${['off', 'auto', 'on'].map(m => html`
          <button class="btn-secondary btn-small ${state.fanMode === m ? 'active' : ''}"
            onclick=${() => setFan(m)}>${m}</button>
        `)}
      </div>

      ${!running && html`
        <div class="control-row">
          <span class="control-label">Test:</span>
          ${['heat1', 'heat2', 'heat3', 'fan'].map(r => html`
            <button class="btn-secondary btn-small ${testRelay === r ? 'active' : ''}"
              onclick=${() => toggleRelay(r)}>${r}</button>
          `)}
        </div>
      `}
    </div>
  `;
}
