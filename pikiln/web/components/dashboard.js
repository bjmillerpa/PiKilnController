import { html } from '../app.js';
import { fmtTemp, fmtDuration, fmtHours, fmtPower } from '../lib/utils.js';

export function Dashboard({ state }) {
  const s = state;
  const sched = s.schedule;

  return html`
    <div class="dashboard">
      ${s.simulation && html`<div class="sim-banner">SIMULATION MODE</div>`}

      <div class="temps">
        ${s.temps.map((c, i) => html`
          <div class="temp-ring ${s.elements[i]?.isOn ? 'on' : ''}">
            <div class="label">Ring ${i + 1}</div>
            <div class="value">${fmtTemp(c)}</div>
            <div class="element-indicator">${s.elements[i]?.isOn ? 'FIRING' : ''}</div>
          </div>
        `)}
      </div>

      <div class="info-grid">
        <div class="info-card">
          <div class="label">Mode</div>
          <div class="value mode-${s.mode}">${s.mode}</div>
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
          <div class="value">${sched ? `${sched.currentSegment + 1} / ${sched.totalSegments}` : '--'}</div>
        </div>
        <div class="info-card">
          <div class="label">Elapsed</div>
          <div class="value">${fmtDuration(s.elapsedSeconds)}</div>
        </div>
        <div class="info-card">
          <div class="label">Time Left</div>
          <div class="value">${fmtHours(sched?.timeLeftHrs)}</div>
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
