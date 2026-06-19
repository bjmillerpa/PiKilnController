import { html, useState, useEffect } from '../app.js';

// Operator-only settings — notifications, fan-balance thresholds, share-
// monitor link. None of these need to be in the operator's face during a
// firing, so they live on their own tab. Hidden entirely from the read-only
// monitor view.
export function SettingsTab({ state, ws }) {
  const progressOn = state.notifications?.progress !== false;
  function setNotif(progress) { ws.send('setNotifications', { progress }); }

  return html`
    <div class="settings-tab">
      <div class="section">
        <div class="section-title">Notifications</div>
        <div class="control-row">
          <label class="control-label" style="cursor:pointer">
            <input type="checkbox" checked=${progressOn}
              onChange=${e => setNotif(e.target.checked)} />
            <span style="margin-left:6px">Progress notifications (every 200°F)</span>
          </label>
        </div>
        <div class="muted small" style="margin-top:6px">
          Sends a Pushover ping each time the kiln crosses a 200°F threshold
          (200, 400, 600, …) on the way up. One-shot per threshold per firing.
        </div>
      </div>

      <div class="section">
        <div class="section-title">Kiln load</div>
        <${LoadKgSlider} state=${state} ws=${ws} />
      </div>

      <div class="section">
        <div class="section-title">
          Fan balance
          <span class="muted small" style="float:right; font-weight:normal">
            Active when Fan mode = balance
          </span>
        </div>
        <div class="muted small" style="margin-bottom:8px">
          When the top ring runs hotter than the others, the downdraft vent
          pulls hot air down through the column to balance the column. These
          thresholds control how aggressively that engages.
        </div>
        <${FanBalanceSliders} state=${state} ws=${ws} />
      </div>

      <div class="section">
        <div class="section-title">Share read-only monitor</div>
        <${ShareMonitorLink} state=${state} ws=${ws} />
      </div>
    </div>
  `;
}

// ── Kiln-load slider ───────────────────────────────────────────────────
// The operator's estimate of ware + furniture mass in the kiln. Adds to
// the bare-brick heat capacity (76,300 J/K) at 900 J/(kg·K) — the rough
// mid-range for ceramic ware, porcelain, stoneware, and cordierite kiln
// furniture. The derived total m·c is what drives time-to-cool, max-
// fire-rate, and the sim's thermal evolution. Tune this before starting
// a firing to get more accurate time-left estimates.
function LoadKgSlider({ state, ws }) {
  const serverKg = state?.loadKg ?? 0;
  const [localKg, setLocalKg] = useState(serverKg);
  useEffect(() => { setLocalKg(serverKg); }, [serverKg]);

  function commit(v) {
    const kg = Math.max(0, Math.min(100, v));
    setLocalKg(kg);
    ws.send('setLoadKg', { kg });
  }

  // Derived heat capacity for the operator's preview — matches the
  // formula in thermal-model.js. Showing the result helps the operator
  // build intuition (e.g. 30 kg of load adds ~35% to the kiln's mass).
  const heatCapJK = 76300 + localKg * 900;
  const pctBumpVsEmpty = ((heatCapJK / 76300 - 1) * 100).toFixed(0);

  return html`
    <div style="display:flex; flex-direction:column; gap:10px;
                padding:10px; background:#16213e; border:1px solid #333;
                border-radius:4px">
      <div class="muted small">
        Ware + furniture in the chamber. Adds ${pctBumpVsEmpty}% to the
        kiln's heat capacity vs empty — affects time-to-cool, time-left
        estimates, and the sim's thermal evolution.
      </div>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px">
        <span style="width:90px">Load ${localKg} kg</span>
        <input type="range" min="0" max="100" step="1" value=${localKg}
          onInput=${e => setLocalKg(Number(e.target.value))}
          onChange=${e => commit(Number(e.target.value))}
          style="flex:1" />
      </label>
      <div class="muted small" style="text-align:right">
        Effective m·c: <strong>${heatCapJK.toLocaleString()} J/K</strong>
        <span style="opacity:0.6">(76,300 brick + ${localKg} × 900 ceramic)</span>
      </div>
      <${ApparentLoadBadge} state=${state} />
    </div>
  `;
}

// Live-derived heat capacity, back-calculated from observed power input +
// temp rate against the calibrated Q_loss(T) curve. Updates each heartbeat
// during a running firing or cool-down. Hidden until the buffer has settled
// enough samples (~2 min). Useful for the operator to sanity-check the
// load setting above — an empty kiln should converge to ~76,300 J/K /
// 0 kg, a loaded kiln to the operator's slider value (within ±10 kg or so
// depending on how much of the load equilibrated with the brick).
function ApparentLoadBadge({ state }) {
  const al = state?.apparentLoad;
  if (!al) {
    return html`
      <div class="muted small" style="text-align:right; font-style:italic; opacity:0.6">
        Apparent m·c: gathering data… (needs 2 min of movement; idle/holds skipped)
      </div>
    `;
  }
  const fresh = !al.stale;
  const ageS  = al.updatedAt ? Math.max(0, Math.round((Date.now() - al.updatedAt) / 1000)) : null;
  const ageLabel = !fresh && ageS != null
    ? ` · paused ${ageS < 90 ? `${ageS}s` : `${Math.round(ageS / 60)}m`} ago`
    : '';
  return html`
    <div class="muted small" style="text-align:right; opacity:${fresh ? 1 : 0.65}">
      Apparent m·c: <strong>${al.mcJK.toLocaleString()} J/K</strong>
      → load ≈ <strong>${al.kg.toFixed(1)} kg</strong>${ageLabel}
    </div>
  `;
}

// ── Fan-balance sliders ────────────────────────────────────────────────
// ON: top ring must be this many °F hotter than the coolest other ring
// before the fan starts. OFF: once running, fan releases when the gap drops
// below this. Constrained so OFF < ON (else hysteresis flips and the relay
// chatters). Edits send immediately so the operator can see the effect
// during a live firing — no debounce needed for a once-in-a-while drag.
function FanBalanceSliders({ state, ws }) {
  const bal = state.fanBalance || { onF: 8, offF: 3 };
  const [localOn,  setLocalOn ] = useState(bal.onF);
  const [localOff, setLocalOff] = useState(bal.offF);
  // Sync from server when state changes externally (e.g. another tab edited).
  useEffect(() => { setLocalOn(bal.onF);   }, [bal.onF]);
  useEffect(() => { setLocalOff(bal.offF); }, [bal.offF]);

  function commitOn(v) {
    const onF = Math.max(localOff + 1, Math.min(60, v));
    setLocalOn(onF);
    ws.send('setFanBalanceThresholds', { onF });
  }
  function commitOff(v) {
    const offF = Math.max(0, Math.min(localOn - 1, v));
    setLocalOff(offF);
    ws.send('setFanBalanceThresholds', { offF });
  }

  return html`
    <div style="display:flex; flex-direction:column; gap:10px;
                padding:10px; background:#16213e; border:1px solid #333;
                border-radius:4px">
      <div class="muted small">
        Fan turns ON when the top ring is at least <strong>${localOn}°F</strong> hotter
        than the coolest other ring, OFF when the gap drops below <strong>${localOff}°F</strong>.
      </div>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px">
        <span style="width:80px">ON ${localOn}°F</span>
        <input type="range" min="1" max="30" step="1" value=${localOn}
          onInput=${e => setLocalOn(Number(e.target.value))}
          onChange=${e => commitOn(Number(e.target.value))}
          style="flex:1" />
      </label>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px">
        <span style="width:80px">OFF ${localOff}°F</span>
        <input type="range" min="0" max="29" step="1" value=${localOff}
          onInput=${e => setLocalOff(Number(e.target.value))}
          onChange=${e => commitOff(Number(e.target.value))}
          style="flex:1" />
      </label>
    </div>
  `;
}

// ── Share monitor link ────────────────────────────────────────────────
// The relay serves /monitor/<key> as a read-only view of the live state.
// The key is stable until the operator rotates it via the Refresh button
// (or the controller service restarts). Rotation invalidates the old link
// immediately — the relay drops monitor connections that no longer match.
function ShareMonitorLink({ state, ws }) {
  const key = state?.monitorKey;
  const url = key && typeof location !== 'undefined'
    ? `${location.origin}/monitor/${key}`
    : null;
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  if (!url) {
    return html`<div class="muted small">No monitor key yet — restart the controller to generate one.</div>`;
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard API can be blocked; the input is still selectable */ }
  }
  function rotate() {
    if (!confirm('Rotate the monitor share key? Anyone currently using the old link will be disconnected.')) return;
    setRotating(true);
    ws.send('rotateMonitorKey', {});
    // Clear the spinner on the next state frame; if the response is slow
    // we time out after 3 s so the button doesn't stay stuck.
    setTimeout(() => setRotating(false), 3000);
  }
  return html`
    <div style="display:flex; flex-direction:column; gap:6px">
      <div style="display:flex; gap:6px">
        <input type="text" readonly value=${url}
          onfocus=${e => e.target.select()}
          style="flex:1; padding:6px 8px; background:#0f0f23; color:#aef;
                 border:1px solid #444; border-radius:4px; font-family:monospace;
                 font-size:12px" />
        <button class="btn-secondary btn-small" onclick=${copy}
          style="min-width:64px">${copied ? 'Copied' : 'Copy'}</button>
        <button class="btn-secondary btn-small" onclick=${rotate}
          disabled=${rotating} title="Generate a new key and invalidate the old link"
          style="min-width:72px">${rotating ? '…' : 'Refresh'}</button>
      </div>
      <div class="muted small">
        Anyone with this link can view live temps, the firing curve, and
        the log — no login required. Refresh rotates the key and kicks
        any current viewers off; share the new link to re-invite them.
      </div>
    </div>
  `;
}
