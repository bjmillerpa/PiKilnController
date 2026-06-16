import { html, useState, useEffect, useRef } from '../app.js';

// Operator notes that get baked into the firing log header at kiln.start().
// Edits auto-save to userConfig with a 600 ms debounce so closing the browser
// and coming back tomorrow shows the same notes. Once a firing starts, the
// notes captured at that moment go into the log file — later edits don't
// update the in-progress log (use the "Add inline note" button below for
// timestamped mid-firing annotations).
//
// `readOnly` (optional) hides the editor and inline-note button — used by
// the monitor (share-link) view so viewers see the current notes without a
// way to edit them or push new ones.
export function FiringNotes({ state, ws, readOnly = false }) {
  const serverNotes = state.firingNotes || '';
  const [draft, setDraft] = useState(serverNotes);
  // `pending` is true between a local edit and the server echoing it back.
  // Drives the "Saving…" indicator; flipped off when the round-trip completes
  // (see the serverNotes effect below).
  const [pending, setPending] = useState(false);
  // Last server value we've accepted. Lets us detect "is this a new server
  // change (multi-tab or initial load) or just our own save echo?" without
  // false-positives on re-renders where serverNotes is unchanged.
  const lastAckRef = useRef(serverNotes);

  // React to server-side changes. Three cases:
  //   1. Same as our last ack    → no-op, just a re-render
  //   2. Server caught up to our pending draft → ack-and-mark-saved
  //   3. Server diverged (multi-tab edit or initial load arriving):
  //        if we have no pending edits, sync remote → local
  //        if we DO have pending edits, leave local alone (last-write-wins
  //        will overwrite the remote value on our next send)
  useEffect(() => {
    if (serverNotes === lastAckRef.current) return;
    lastAckRef.current = serverNotes;
    if (!pending) {
      setDraft(serverNotes);
    } else if (serverNotes === draft) {
      // Our save completed.
      setPending(false);
    }
  }, [serverNotes]);

  function onInput(e) {
    setDraft(e.target.value);
    setPending(true);
  }

  // Debounced send: 600 ms after the last keystroke, push to server.
  // We don't flip `pending` off here — wait for the server echo so the
  // indicator accurately tracks the round-trip, not just "we hit send".
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => {
      ws.send('setFiringNotes', { notes: draft });
    }, 600);
    return () => clearTimeout(id);
  }, [draft, pending]);

  // Flush immediately on blur. Clicking the Start button blurs the textarea
  // first (focus shifts before the click handler fires), so notes arrive at
  // the server in the same WS connection just ahead of the `start` command —
  // userConfig.firingNotes is updated by the time `kiln.on('started')` reads
  // it. Without this, anyone who types and immediately hits Start within the
  // 600 ms debounce window loses the latest draft.
  function flush() {
    if (pending) ws.send('setFiringNotes', { notes: draft });
  }

  function addInline() {
    const text = prompt('Inline note to record at this moment:');
    if (!text || !text.trim()) return;
    ws.send('addFiringNote', { text: text.trim() });
  }

  const firingActive = !!state.activeFiring;
  const headerHint = readOnly
    ? (firingActive ? `Active firing: ${state.activeFiring.title}` : 'No active firing')
    : firingActive
      ? `Active firing: ${state.activeFiring.title} — these edits will apply to the NEXT firing`
      : 'Captured into the firing log header when you click Start';

  if (readOnly) {
    return html`
      <div class="section">
        <div class="section-title">Firing notes</div>
        <div class="muted small" style="margin-bottom:6px">${headerHint}</div>
        <div style="padding:8px; background:#0f0f23; color:#e0e0e0;
                    border:1px solid #444; border-radius:4px;
                    min-height:5em; white-space:pre-wrap; font-family:inherit">${serverNotes || '(no notes)'}</div>
      </div>
    `;
  }

  return html`
    <div class="section">
      <div class="section-title">
        Firing notes
        ${firingActive && html`
          <button class="btn-secondary btn-small" style="float:right; margin-top:-4px"
            onclick=${addInline}>Add inline note</button>
        `}
      </div>
      <div class="muted small" style="margin-bottom:6px">${headerHint}</div>
      <textarea
        rows="5"
        placeholder="What's being fired? How was the kiln loaded? Any special conditions?"
        value=${draft}
        onInput=${onInput}
        onBlur=${flush}
        style="width:100%; box-sizing:border-box; padding:8px;
               background:#0f0f23; color:#e0e0e0;
               border:1px solid #444; border-radius:4px;
               font-family:inherit; resize:vertical"></textarea>
      <div class="muted small" style="margin-top:4px; min-height:1.2em">
        ${pending ? 'Saving…' : 'Saved'}
      </div>
    </div>
  `;
}
