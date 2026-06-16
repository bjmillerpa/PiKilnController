import { html, useState, useEffect } from '../app.js';
import { fmtTemp } from '../lib/utils.js';

// Subscribe to ws message events that decode SPI-read responses (the
// debug commands respond asynchronously, and we want their results in
// the debug log).
function useResponseLog(ws, dlog) {
  useEffect(() => {
    if (!ws) return;
    function onMsg(e) {
      const m = e.detail;
      if (m.type !== 'response') return;
      if (m.action === 'debugSpiRead' && m.data?.hex != null) {
        dlog(`SPI read result: 0x${m.data.hex} (${m.data.raw})  ${m.data.raw === 0 ? '← all zeros: no chip responding' : ''}`);
      }
      if (m.action === 'debugGpioSweep' && Array.isArray(m.data?.pinsPulsed)) {
        dlog(`Sweep complete (${m.data.pinsPulsed.length} pins pulsed)`);
      }
      if (m.action === 'error' && m.message) {
        dlog(`✗ ${m.message}`);
      }
    }
    ws.addEventListener('message', onMsg);
    return () => ws.removeEventListener('message', onMsg);
  }, [ws]);
}

// Tests tab — for verifying hardware wiring before firing. Manual on/off for
// each element relay and the vent fan, plus live readouts of the three
// thermocouples and the relays' actual on-state as the controller sees it.
//
// Server-side `testRelay` refuses while the kiln is running, so the buttons
// disable during a firing.
export function TestsTab({ state, ws }) {
  const running = state.mode === 'running';
  const elements = state.elements || [];
  const sim = state.simulation;
  const [simTempInput, setSimTempInput] = useState('1500');
  // Debug-panel state
  const [debugPin, setDebugPin] = useState('26');
  const [debugLevel, setDebugLevel] = useState(1);
  const [sweepStart, setSweepStart] = useState('2');
  const [sweepEnd, setSweepEnd] = useState('27');
  const [spiClk, setSpiClk] = useState('22');
  const [spiData, setSpiData] = useState('17');
  const [spiCs, setSpiCs] = useState('0');
  const [debugLog, setDebugLog] = useState([]);
  const cfg = state.gpioConfig || {};

  function toggle(name, currentOn) {
    if (running) return;
    ws.send('testRelay', { relay: name, on: !currentOn });
  }
  function simReset() { ws.send('simResetTemps'); }
  function simSet() {
    const tempF = Number(simTempInput);
    if (!Number.isFinite(tempF)) return;
    ws.send('simSetTemp', { tempF });
  }
  function dlog(s) {
    setDebugLog(prev => [...prev.slice(-19), `${new Date().toLocaleTimeString()} ${s}`]);
  }
  function dbgWrite(level) {
    const pin = Number(debugPin);
    if (!Number.isFinite(pin)) return;
    ws.send('debugGpioWrite', { pin, level });
    dlog(`GPIO ${pin} → ${level ? 'HIGH' : 'LOW'}`);
  }
  function dbgPulse() {
    const pin = Number(debugPin);
    if (!Number.isFinite(pin)) return;
    ws.send('debugGpioPulse', { pin, durationMs: 500 });
    dlog(`GPIO ${pin} pulsed HIGH for 500ms`);
  }
  function dbgSweep() {
    const s = Number(sweepStart), e = Number(sweepEnd);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    ws.send('debugGpioSweep', { startPin: s, endPin: e, durationMs: 400, gapMs: 200 });
    dlog(`Sweeping GPIO ${s}..${e} (this will take ~${((e - s + 1) * 0.6).toFixed(1)}s)`);
  }
  function dbgSpiRead() {
    const clockPin = Number(spiClk), dataPin = Number(spiData), csPin = Number(spiCs);
    if (![clockPin, dataPin, csPin].every(Number.isFinite)) return;
    ws.send('debugSpiRead', { clockPin, dataPin, csPin });
    dlog(`SPI read clk=${clockPin} data=${dataPin} cs=${csPin}...`);
  }

  // Listen for debug command responses
  useResponseLog(ws, dlog);

  // Relays listed in physical-stack order (top first) to match the
  // thermocouple panel above. The internal `name` ("heat1" etc.) still maps
  // to GPIO_HEAT[0..2] — only the display order is rearranged.
  const ringLabel = i => {
    const p = state.ringPositionLabels?.[i];
    return p ? `${p} (Heat ${i + 1})` : `Heat ${i + 1}`;
  };
  const relays = [
    { name: 'heat3', label: ringLabel(2), isOn: elements[2]?.isOn, ring: 2 },
    { name: 'heat2', label: ringLabel(1), isOn: elements[1]?.isOn, ring: 1 },
    { name: 'heat1', label: ringLabel(0), isOn: elements[0]?.isOn, ring: 0 },
    { name: 'fan',   label: 'Fan',        isOn: state.fan?.isOn,   ring: null },
  ];

  return html`
    <div class="tests-tab">
      ${sim && html`<div class="sim-banner">SIMULATION MODE — relay toggles affect simulated state only</div>`}
      ${running && html`<div class="warn-banner">Firing in progress — manual relay control disabled</div>`}

      <div class="section">
        <div class="section-title">Thermocouples</div>
        <div class="temps">
          ${(state.temps || []).map((_c, i) => i).reverse().map(i => {
            const c = state.temps[i];
            const fault = state.sensorFaults?.[i];
            const firing = state.elements?.[i]?.isOn;
            const posLabel = state.ringPositionLabels?.[i];
            return html`
              <div class="temp-ring ${firing ? 'on' : ''} ${fault ? 'faulted' : ''}">
                <div class="label">
                  ${posLabel
                    ? html`${posLabel} <span class="muted">· Ring ${i + 1}</span>`
                    : html`Ring ${i + 1}`}
                </div>
                <div class="value">${fault ? '--' : fmtTemp(c)}</div>
                <div class="element-indicator">${firing ? 'FIRING' : (fault ? '' : '—')}</div>
                ${fault && html`<div class="fault-indicator" title="Thermocouple fault — firing via sibling ring">FAULT: ${fault}</div>`}
              </div>
            `;
          })}
        </div>
      </div>

      <div class="section">
        <div class="section-title">Relays — manual toggle</div>
        <div class="test-grid">
          ${relays.map(r => html`
            <div class="test-cell">
              <div class="test-cell-label">${r.label}</div>
              <div class="test-cell-state ${r.isOn ? 'on' : 'off'}">
                ${r.isOn ? 'ON' : 'OFF'}
              </div>
              <button
                class="${r.isOn ? 'btn-stop' : 'btn-start'} btn-small"
                onclick=${() => toggle(r.name, r.isOn)}
                disabled=${running}>
                ${r.isOn ? 'Turn OFF' : 'Turn ON'}
              </button>
              ${r.ring !== null && state.elements?.[r.ring]?.secondsOn != null && html`
                <div class="test-cell-meta small muted">
                  ${state.elements[r.ring].secondsOn.toFixed(0)}s on-time
                </div>
              `}
            </div>
          `)}
        </div>
      </div>

      <div class="section muted small">
        <strong>How to use:</strong> turn each relay on briefly with the kiln
        unpowered and confirm the corresponding contactor clicks. With the kiln
        warm, turning Heat&nbsp;<em>n</em> on for a few seconds and checking
        that Ring&nbsp;<em>n</em>'s temperature climbs verifies the
        thermocouple-to-element mapping.
      </div>

      <!-- ── Diagnostic mode ──────────────────────────────────────────── -->
      <div class="section">
        <div class="section-title">
          Diagnostic mode
          ${state.diagnosticMode && html`
            <span style="float:right; color:#d4a017; font-weight:600; font-size:12px">
              ENABLED — fault filters OFF
            </span>
          `}
        </div>
        <div class="muted small" style="margin-bottom:10px">
          Turns off every software fault filter so thermocouple problems
          become obvious during cap/ferrite tuning:
          <ul style="margin:6px 0 6px 18px; padding:0">
            <li>Sensor debounce: 3-of-3 → <strong>1 sample</strong> (every transient fault shows)</li>
            <li>Sibling-ring fallback: <strong>disabled</strong> (faulted ring stops firing instead of using a sister)</li>
            <li>"All sensors failed" e-stop window: 30 s → <strong>5 s</strong></li>
          </ul>
          ${state.mode === 'running' && state.diagnosticMode && html`
            <div style="margin-top:8px; padding:8px; background:#3a2a0c; color:#ffd; border:1px solid #d4a017; border-radius:4px">
              <strong>⚠ Active firing with diagnostic mode on.</strong>
              Sustained EMI will emergency-stop the kiln in 5 s. This is the
              right setting for comparing cap/ferrite hardware fixes — turn
              it off once you're satisfied the noise is gone.
            </div>
          `}
          Resets to OFF on every controller restart.
        </div>
        <div class="control-row">
          <button
            class="${state.diagnosticMode ? 'btn-stop' : 'btn-secondary'} btn-small"
            onclick=${() => ws.send('setDiagnosticMode', { enabled: !state.diagnosticMode })}>
            ${state.diagnosticMode ? 'Turn diagnostic mode OFF' : 'Enable diagnostic mode'}
          </button>
        </div>
      </div>

      <!-- ── Hardware-bring-up debug panel ───────────────────────── -->
      <div class="section">
        <div class="section-title">GPIO debug</div>
        <div class="muted small" style="margin-bottom:10px">
          For hardware bring-up: probe individual BCM pins and raw SPI lines
          to figure out what's actually wired where. Disabled during a firing.
          ${sim ? 'In simulation — commands respond but do nothing physical.' : 'Real hardware.'}
        </div>

        <div class="muted small" style="margin-bottom:10px">
          <strong>Current pin assignments:</strong>
          heat: BCM [${(cfg.heat || []).join(', ')}],
          fan: BCM ${cfg.ventFan ?? '?'},
          SPI clk/data: BCM ${cfg.spiClock ?? '?'}/${cfg.spiData ?? '?'},
          SPI CS: BCM [${(cfg.spiCs || []).join(', ')}]
        </div>

        <div class="control-row">
          <span class="control-label">Pin BCM:</span>
          <input type="number" min="0" max="53" value=${debugPin}
            onInput=${e => setDebugPin(e.target.value)}
            style="width: 70px; padding: 4px; background:#0f0f23; color:#e0e0e0; border:1px solid #444; border-radius:4px" />
          <button class="btn-secondary btn-small" onclick=${() => dbgWrite(1)} disabled=${running}>Drive HIGH</button>
          <button class="btn-secondary btn-small" onclick=${() => dbgWrite(0)} disabled=${running}>Drive LOW</button>
          <button class="btn-secondary btn-small" onclick=${dbgPulse} disabled=${running}>Pulse 500ms</button>
        </div>

        <div class="control-row">
          <span class="control-label">Sweep BCM:</span>
          <input type="number" min="0" max="53" value=${sweepStart}
            onInput=${e => setSweepStart(e.target.value)}
            style="width: 60px; padding: 4px; background:#0f0f23; color:#e0e0e0; border:1px solid #444; border-radius:4px" />
          <span class="muted small">to</span>
          <input type="number" min="0" max="53" value=${sweepEnd}
            onInput=${e => setSweepEnd(e.target.value)}
            style="width: 60px; padding: 4px; background:#0f0f23; color:#e0e0e0; border:1px solid #444; border-radius:4px" />
          <button class="btn-secondary btn-small" onclick=${dbgSweep} disabled=${running}>Sweep (pulse each)</button>
        </div>

        <div class="control-row">
          <span class="control-label">SPI read:</span>
          <span class="muted small">clk</span>
          <input type="number" min="0" max="53" value=${spiClk}
            onInput=${e => setSpiClk(e.target.value)}
            style="width: 50px; padding: 4px; background:#0f0f23; color:#e0e0e0; border:1px solid #444; border-radius:4px" />
          <span class="muted small">data</span>
          <input type="number" min="0" max="53" value=${spiData}
            onInput=${e => setSpiData(e.target.value)}
            style="width: 50px; padding: 4px; background:#0f0f23; color:#e0e0e0; border:1px solid #444; border-radius:4px" />
          <span class="muted small">cs</span>
          <input type="number" min="0" max="53" value=${spiCs}
            onInput=${e => setSpiCs(e.target.value)}
            style="width: 50px; padding: 4px; background:#0f0f23; color:#e0e0e0; border:1px solid #444; border-radius:4px" />
          <button class="btn-secondary btn-small" onclick=${dbgSpiRead} disabled=${running}>Read 32 bits</button>
        </div>

        ${debugLog.length > 0 && html`
          <div class="log-container" style="margin-top:10px; max-height:200px">
            ${debugLog.map(line => html`<div class="log-entry">${line}</div>`)}
          </div>
        `}
      </div>

      ${sim && html`
        <div class="section">
          <div class="section-title">Simulation helpers</div>
          <div class="muted small" style="margin-bottom:10px">
            Skips the wait for the thermal model to ramp up/down. Sets all
            three thermocouples to the chosen value instantaneously. Only
            visible in simulation mode.
          </div>
          <div class="control-row">
            <button class="btn-secondary btn-small" onclick=${simReset}
              disabled=${running}>Reset to ambient (70°F)</button>
          </div>
          <div class="control-row">
            <input type="number" value=${simTempInput}
              onInput=${e => setSimTempInput(e.target.value)}
              style="width: 90px; padding: 6px; background: #0f0f23; color: #e0e0e0; border: 1px solid #444; border-radius: 4px;" />
            <span class="control-label" style="min-width: 30px">°F</span>
            <button class="btn-secondary btn-small" onclick=${simSet}
              disabled=${running}>Set kiln temperature</button>
          </div>
        </div>
      `}
    </div>
  `;
}
