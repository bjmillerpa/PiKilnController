import { html, useState, useEffect, useRef } from '../app.js';

export function LogViewer({ ws }) {
  const [logs, setLogs] = useState([]);
  const containerRef = useRef(null);

  useEffect(() => {
    function onMsg(e) {
      const msg = e.detail;
      if (msg.type === 'log' || msg.type === 'message') {
        const prefix = msg.type === 'message' ? '>> ' : '';
        setLogs(prev => {
          const next = [...prev, prefix + msg.message];
          return next.length > 200 ? next.slice(-200) : next;
        });
      }
      if (msg.alert) {
        setLogs(prev => {
          const next = [...prev, 'ALERT: ' + msg.alert];
          return next.length > 200 ? next.slice(-200) : next;
        });
      }
    }
    ws.addEventListener('message', onMsg);
    return () => ws.removeEventListener('message', onMsg);
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length]);

  return html`
    <div class="section">
      <div class="section-title">Log</div>
      <div class="log-container" ref=${containerRef}>
        ${logs.map(l => html`<div class="log-entry">${l}</div>`)}
      </div>
    </div>
  `;
}
