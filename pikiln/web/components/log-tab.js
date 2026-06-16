import { html } from '../app.js';
import { FiringNotes } from './firing-notes.js';
import { LogViewer } from './log-viewer.js';

// Dedicated tab for everything text-stream-y: pre-firing notes, the live
// event log, and (during a firing) the "Add inline note" button on the
// FiringNotes section.
//
// `logs` is the shared log buffer owned by App so it persists across tab
// switches. `readOnly` is set true by the monitor (share-link) view —
// notes show without an editor and the inline-note button is hidden, but
// the log still streams normally.
export function LogTab({ state, ws, logs, readOnly = false }) {
  return html`
    <div class="log-tab">
      <${FiringNotes} state=${state} ws=${ws} readOnly=${readOnly} />
      <${LogViewer} logs=${logs} height="65vh" />
    </div>
  `;
}
