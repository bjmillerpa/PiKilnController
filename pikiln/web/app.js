// Vendored locally so the UI loads at the kiln with no internet.
// Resolved via the importmap in index.html → web/lib/vendor/*.mjs
import { h, render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);
export { html, useState, useEffect, useRef, useCallback };

import { WsClient } from './lib/ws-client.js';
import { Tabs } from './components/tabs.js';
import { Dashboard } from './components/dashboard.js';
import { FiringCurve } from './components/firing-curve.js';
import { SchedulePicker } from './components/schedule-picker.js';
import { Controls } from './components/controls.js';
import { SettingsTab } from './components/settings-tab.js';
import { LogTab } from './components/log-tab.js';
import { SchedulesTab } from './components/schedules-tab.js';
import { TestsTab } from './components/tests-tab.js';
import { HelpTab } from './components/help-tab.js';

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

const TABS = [
  { key: 'run',       label: 'Run' },
  { key: 'settings',  label: 'Settings' },
  { key: 'log',       label: 'Log' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'tests',     label: 'Tests' },
  { key: 'help',      label: 'Help' },
];

// Detect read-only "monitor" mode. The relay serves /monitor/<key> as the
// same index.html — we sniff the path here and use it to switch WS endpoint,
// hide the Schedules/Tests tabs, and pass `readOnly` to the Run tab so
// individual controls can render disabled (or hide entirely).
function detectMonitorKey() {
  if (typeof location === 'undefined') return null;
  const m = location.pathname.match(/^\/monitor\/([a-fA-F0-9]+)/);
  return m ? m[1] : null;
}
const MONITOR_KEY = detectMonitorKey();
const READ_ONLY   = !!MONITOR_KEY;
// Monitor mode hides operator-only tabs. Read-only viewers get Run (dashboard
// + firing curve), Log (notes view + live log stream), and Help (static
// documentation, useful for anyone watching to understand what they're
// seeing). Settings/Schedules/Tests are control surfaces and stay off-limits.
const VISIBLE_TABS = READ_ONLY
  ? TABS.filter(t => ['run', 'log', 'help'].includes(t.key))
  : TABS;

function App() {
  const [state, setState] = useState(EMPTY_STATE);
  const [connected, setConnected] = useState(false);
  // controllerOnline: relay tells us whether the Pi (or sim) is dialed in.
  // null in LAN mode (Pi serves the UI directly; no relay events flow).
  const [controllerOnline, setControllerOnline] = useState(null);
  const [controllerRole, setControllerRole] = useState(null); // 'real' | 'sim' | null
  // True for ~10s after a controller-disconnected event. Lets us show
  // "Reconnecting…" instead of jumping straight to "Kiln offline" while
  // the sim is taking over (typically ~3s).
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectingTimerRef = useRef(null);
  // Keep the active tab in the URL hash so refreshes (and links) preserve it.
  const [tab, setTab] = useState(() => {
    const h = (typeof location !== 'undefined' && location.hash || '').replace('#', '');
    return TABS.find(t => t.key === h)?.key || 'run';
  });
  // Log buffer lives in App so it survives tab switches — moving to a
  // different tab used to unmount LogViewer and wipe its local state, so
  // log messages arriving during that interval were lost and the log
  // appeared to "restart" on tab return. Bounded to 500 entries.
  const [logs, setLogs] = useState([]);
  const wsRef = useRef(null);

  useEffect(() => {
    const ws = new WsClient();
    wsRef.current = ws;

    ws.addEventListener('open', () => setConnected(true));
    ws.addEventListener('close', () => {
      setConnected(false);
      setControllerOnline(null);
      setControllerRole(null);
      setReconnecting(false);
      if (reconnectingTimerRef.current) {
        clearTimeout(reconnectingTimerRef.current);
        reconnectingTimerRef.current = null;
      }
    });
    ws.addEventListener('message', (e) => {
      const msg = e.detail;
      // Accumulate log lines at the App level so the buffer persists when
      // the user navigates away from the Log tab. Bounded to 500 lines —
      // that's about 25 min of typical firing telemetry, plenty for context.
      if (msg.type === 'log' || msg.type === 'message') {
        const prefix = msg.type === 'message' ? '>> ' : '';
        setLogs(prev => {
          const next = [...prev, prefix + msg.message];
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
      if (msg.alert) {
        setLogs(prev => {
          const next = [...prev, 'ALERT: ' + msg.alert];
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
      if (msg.type === 'state') {
        setState(msg.data);
        // When served by the controller directly (LAN), state.simulation
        // tells us whether we're talking to a real or sim controller.
        if (controllerRole === null) {
          setControllerRole(msg.data?.simulation ? 'sim' : 'real');
        }
      } else if (msg.type === 'relay') {
        if (msg.event === 'controller-connected') {
          setControllerOnline(true);
          setReconnecting(false);
          if (reconnectingTimerRef.current) {
            clearTimeout(reconnectingTimerRef.current);
            reconnectingTimerRef.current = null;
          }
        }
        if (msg.event === 'controller-disconnected') {
          setControllerOnline(false);
          // Hold a transient "Reconnecting…" state for 10s, then degrade
          // to "Kiln offline" if no controller has come back by then.
          setReconnecting(true);
          if (reconnectingTimerRef.current) clearTimeout(reconnectingTimerRef.current);
          reconnectingTimerRef.current = setTimeout(() => {
            setReconnecting(false);
            reconnectingTimerRef.current = null;
          }, 10000);
        }
        if (msg.controllerRole) setControllerRole(msg.controllerRole);
      }
    });

    // Pick endpoint by mode. Monitor mode uses /monitor-ws with the key
    // in the query string — the relay validates against the live firing's
    // key on upgrade. Normal mode uses the cookie-authed root WS.
    if (READ_ONLY) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws.connect(`${proto}//${location.host}/monitor-ws?key=${encodeURIComponent(MONITOR_KEY)}`);
    } else {
      ws.connect();
    }
  }, []);

  // Persist tab to URL hash
  useEffect(() => {
    if (typeof location !== 'undefined' && location.hash !== '#' + tab) {
      history.replaceState(null, '', '#' + tab);
    }
  }, [tab]);

  const ws = wsRef.current;

  // Four-state status:
  //   WS closed                                  → "Disconnected"
  //   WS open + controller dropped, transient    → "Reconnecting…"
  //   WS open + controller dropped, gave up      → "Kiln offline"
  //   WS open + controller up                    → "Connected"
  let statusLabel, statusClass;
  if (!connected)                                   { statusLabel = 'Disconnected'; statusClass = 'off'; }
  else if (controllerOnline === false && reconnecting) { statusLabel = 'Reconnecting…'; statusClass = 'warn'; }
  else if (controllerOnline === false)              { statusLabel = 'Kiln offline'; statusClass = 'off'; }
  else                                              { statusLabel = 'Connected';    statusClass = 'on';  }

  const roleLabel = controllerRole === 'sim' ? 'SIM' : (controllerRole === 'real' ? 'LIVE' : '');

  return html`
    <header>
      <h1>PiKiln${READ_ONLY ? ' — Monitor' : ' Controller'}</h1>
      <div class="header-row">
        <span class="subtitle">${READ_ONLY ? 'Read-only view of the current firing' : 'Ceramics kiln controller'}</span>
        <div>
          ${roleLabel && html`<span class="role-chip role-${controllerRole}">${roleLabel}</span>`}
          <span class="conn-status ${statusClass}">${statusLabel}</span>
        </div>
      </div>
    </header>

    <${Tabs} tabs=${VISIBLE_TABS} active=${tab} onChange=${setTab} />

    ${ws && tab === 'run' && html`
      <${Dashboard} state=${state} ws=${ws} />
      <${FiringCurve} state=${state} />
      ${!READ_ONLY && html`
        ${state.mode !== 'running' && state.mode !== 'cooling' && html`
          <${SchedulePicker} state=${state} ws=${ws} />
        `}
        <${Controls} state=${state} ws=${ws} />
      `}
    `}

    ${!READ_ONLY && ws && tab === 'settings' && html`
      <${SettingsTab} state=${state} ws=${ws} />
    `}

    ${ws && tab === 'log' && html`
      <${LogTab} state=${state} ws=${ws} logs=${logs} readOnly=${READ_ONLY} />
    `}

    ${!READ_ONLY && ws && tab === 'schedules' && html`
      <${SchedulesTab} state=${state} ws=${ws} />
    `}

    ${!READ_ONLY && ws && tab === 'tests' && html`
      <${TestsTab} state=${state} ws=${ws} />
    `}

    ${tab === 'help' && html`
      <${HelpTab} />
    `}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
