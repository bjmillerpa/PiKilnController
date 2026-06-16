import { html } from '../app.js';
import { fmtTemp, fmtDuration, fmtHours, fmtPower } from '../lib/utils.js';
import { RING_COLORS } from '../lib/ring-colors.js';

export function Dashboard({ state, ws }) {
  const s = state;
  const sched = s.schedule;
  const rec = s.pendingRecovery;

  // Compose a human-readable mode label: running / cooling / etc., with the
  // hold-state appended when active so the operator sees "running · holding"
  // rather than just "running" while the schedule clock is paused.
  const modeLabel = s.holdState ? `${s.mode} · ${s.holdState}` : s.mode;

  function recoveryResume() { ws && ws.send('recoveryResume'); }
  function recoveryAbort()  {
    if (!confirm('Abort the interrupted firing? The kiln will stay off.')) return;
    ws && ws.send('recoveryAbort');
  }

  return html`
    <div class="dashboard">
      ${s.simulation && html`<div class="sim-banner">SIMULATION MODE</div>`}
      ${rec && html`
        <div class="recovery-banner">
          <div class="recovery-banner-title">⚠ Last firing was interrupted by a power outage</div>
          <div class="recovery-banner-detail">
            Schedule: <strong>${rec.savedSchedule || '(unknown)'}</strong>
            ${rec.outageSeconds != null
              ? ` · outage ${(rec.outageSeconds / 60).toFixed(1)} min`
              : ''}
            ${rec.maxTempF != null
              ? ` · kiln now at ${rec.maxTempF.toFixed(0)}°F`
              : ''}
            ${rec.savedMaxTempF != null && rec.maxTempF != null
              ? ` (was ${rec.savedMaxTempF.toFixed(0)}°F)`
              : ''}
            ${rec.reason === 'kiln-cool'
              ? ' — kiln cooled below the auto-resume threshold'
              : rec.reason === 'schedule-missing'
                ? ' — saved schedule no longer in the master'
                : rec.reason === 'start-failed'
                  ? ` — auto-resume failed: ${rec.error || ''}`
                  : ''}
          </div>
          <div class="recovery-banner-actions">
            <button class="btn-start btn-small" onclick=${recoveryResume}
              disabled=${rec.reason === 'schedule-missing'}>
              Resume from current temperature
            </button>
            <button class="btn-stop btn-small" onclick=${recoveryAbort}>
              Abort
            </button>
          </div>
        </div>
      `}
      ${s.mode === 'cooling' && html`
        <div class="cooling-banner">${'COOLING — schedule complete, waiting for < 120°F'}</div>
      `}
      ${s.holdState && html`
        <div class="hold-banner">${
          s.holdState === 'hold'
            ? `HOLDING at ${s.holdTargetC != null ? (s.holdTargetC * 9/5 + 32).toFixed(0) + '°F' : ''}`
            : 'PAUSED — elements off'
        }</div>
      `}

      <div class="temps">
        ${s.temps.map((_c, i) => i).reverse().map(i => {
          // Render in physical-stack order (top of kiln first / leftmost) so a
          // glance at the dashboard maps directly to the operator's view of
          // the kiln. The underlying ring indices in code (and in the log
          // lines) stay 1..3 — only the UI label and display order reflect
          // physical position. Labels come from state.ringPositionLabels
          // (constants.js RING_POSITION_LABELS); flip there if the wiring
          // ever changes.
          //
          // sensorFaults[i] non-null means the chip isn't responding; the
          // value in temps[i] is the last good reading (potentially minutes/
          // hours old) so we hide it behind "--" rather than show a stale
          // number that looks live. The element may still be firing via the
          // fault-fallback that reads a sibling ring — keep the red border
          // and FIRING label visible regardless of fault.
          const c = s.temps[i];
          const fault = s.sensorFaults?.[i];
          const firing = s.elements[i]?.isOn;
          // Two-part label only when we actually have a physical-position
          // name from the controller. If the controller is on older firmware
          // and doesn't send ringPositionLabels, just fall back to plain
          // "Ring N" so we don't duplicate it (was "Ring 3 · Ring 3").
          const posLabel = s.ringPositionLabels?.[i];
          // Color strip at the bottom of the tile matches this ring's line
          // color on the firing-curve chart. Lets the operator tell which
          // tile corresponds to which line without a separate legend.
          return html`
            <div class="temp-ring ${firing ? 'on' : ''} ${fault ? 'faulted' : ''}">
              <div class="label">
                ${posLabel
                  ? html`${posLabel} <span class="muted">· Ring ${i + 1}</span>`
                  : html`Ring ${i + 1}`}
              </div>
              <div class="value">${fault ? '--' : fmtTemp(c)}</div>
              <div class="element-indicator">${firing ? 'FIRING' : ''}</div>
              ${fault && html`<div class="fault-indicator" title="Thermocouple fault — firing via sibling ring">FAULT: ${fault}</div>`}
              <div style="height:4px; background:${RING_COLORS[i]}; border-radius:2px; margin-top:6px"></div>
            </div>
          `;
        })}
      </div>

      <div class="info-grid">
        <div class="info-card">
          <div class="label">Mode</div>
          <div class="value mode-${s.mode}">${modeLabel}</div>
        </div>
        <div class="info-card">
          <div class="label">Target</div>
          <div class="value">${sched ? fmtTemp(sched.targetTempC) : '--'}</div>
        </div>
        <div class="info-card">
          <div class="label">Schedule</div>
          <div class="value">${sched?.title || '--'}</div>
        </div>
        <div class="info-card">
          <div class="label">Segment</div>
          <div class="value">${sched
            ? `${sched.currentSegment + 1} / ${sched.totalSegments}${sched.inHold ? ' hold' : ''}`
            : '--'}</div>
        </div>
        <div class="info-card">
          <div class="label">Elapsed</div>
          <div class="value">${fmtDuration(s.elapsedSeconds)}</div>
        </div>
        <div class="info-card">
          ${s.mode === 'cooling'
            ? html`
              <div class="label" title="Modeled time to natural cool-down to 120°F (safe to open). Real cool-down may be faster with the vent fan on, or slower with a heavy load.">Time to Open</div>
              <div class="value">${fmtHours(s.timeToCoolHrs)}</div>
            `
            : html`
              <div class="label" title="Modeled time remaining in the firing. Accounts for the kiln's max heating rate at each segment temperature and any current ramp slip.">Time Left</div>
              <div class="value">${fmtHours(sched?.timeLeftHrs)}</div>
            `}
        </div>
        <div class="info-card">
          <div class="label">Power</div>
          <div class="value">${fmtPower(s.powerKWHr || 0, s.costPerKWH)}</div>
        </div>
        <div class="info-card">
          <div class="label">Cone</div>
          <div class="value">${sched?.cone || '--'}</div>
        </div>
        <div class="info-card">
          <div class="label">Fan</div>
          <div class="value">${s.fan?.isOn ? 'ON' : 'OFF'} (${s.fanMode})</div>
        </div>
      </div>
    </div>
  `;
}
