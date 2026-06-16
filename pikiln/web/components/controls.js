import { html } from '../app.js';

// Run-tab controls: start/stop, hold/pause/resume, fan-mode selector. Lean
// on purpose — settings that don't change run-to-run (progress notifications,
// fan-balance thresholds, share-monitor link) live on the Settings tab so
// the operator's primary firing surface stays uncluttered.
export function Controls({ state, ws }) {
  const running = state.mode === 'running';
  const cooling = state.mode === 'cooling';
  const holdState = state.holdState; // null | 'hold' | 'pause'
  const inHoldOrPause = !!holdState;

  function start()  { ws.send('start'); }
  function stop()   { ws.send('stop'); }
  function hold()   { ws.send('hold'); }
  function pause()  { ws.send('pause'); }
  function resume() { ws.send('resume'); }
  function setFan(mode) { ws.send('setFanMode', { mode }); }

  // Hold and Pause sit between Start and Stop as a single always-visible row.
  // Each slot toggles to "Resume" when its mode is active; the *other* slot
  // is disabled while one is active (you can only resume the active state,
  // can't go hold→pause directly).
  const inHold  = holdState === 'hold';
  const inPause = holdState === 'pause';
  const holdLabel  = inHold  ? 'Resume' : 'Hold';
  const pauseLabel = inPause ? 'Resume' : 'Pause';
  const onHold  = inHold  ? resume : hold;
  const onPause = inPause ? resume : pause;

  return html`
    <div class="section">
      <div class="section-title">Controls</div>

      <div class="control-row">
        <button class="btn-start" onclick=${start}
          disabled=${running || cooling || !state.schedule}>Start</button>
        <button class="${inHold ? 'btn-start' : 'btn-secondary'}" onclick=${onHold}
          disabled=${(!running) || inPause}>${holdLabel}</button>
        <button class="${inPause ? 'btn-start' : 'btn-secondary'}" onclick=${onPause}
          disabled=${(!running) || inHold}>${pauseLabel}</button>
        <button class="btn-stop" onclick=${stop}
          disabled=${!running && !cooling}>Stop</button>
      </div>

      ${inHoldOrPause && html`
        <div class="control-row">
          <span class="muted small">
            ${inHold
              ? `Holding at ${state.holdTargetC != null ? (state.holdTargetC * 9/5 + 32).toFixed(0) + '°F' : ''}`
              : 'Paused — elements off'}
          </span>
        </div>
      `}

      <div class="control-row">
        <span class="control-label">Fan:</span>
        ${['off', 'auto', 'on', 'balance'].map(m => html`
          <button class="btn-secondary btn-small ${state.fanMode === m ? 'active' : ''}"
            title=${m === 'balance' ? 'Run the fan only when the top ring is hotter than the others — the downdraft pulls hot air down to balance. Tune thresholds on the Settings tab.' : ''}
            onclick=${() => setFan(m)}>${m}</button>
        `)}
      </div>
    </div>
  `;
}
