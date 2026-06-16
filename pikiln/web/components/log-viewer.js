import { html, useEffect, useRef } from '../app.js';

// Pure display component. The log buffer (`logs` prop) is owned by App so
// it survives tab switches and captures messages that arrive while this
// component is unmounted. `height` overrides the default 200 px log-
// container height — the Log tab uses ~65 vh for a fill-the-screen view.
export function LogViewer({ logs, height }) {
  const containerRef = useRef(null);

  // Auto-scroll to the bottom whenever a new line arrives or the panel
  // (re-)mounts. On a fresh mount we want to land at the latest entry,
  // not at the top of the persistent buffer.
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs?.length]);

  const containerStyle = height ? `height:${height}` : '';
  const lines = Array.isArray(logs) ? logs : [];
  return html`
    <div class="section">
      <div class="section-title">Log</div>
      <div class="log-container" ref=${containerRef} style=${containerStyle}>
        ${lines.map(l => html`<div class="log-entry">${l}</div>`)}
      </div>
    </div>
  `;
}
