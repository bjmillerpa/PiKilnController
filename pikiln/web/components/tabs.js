import { html } from '../app.js';

// Tab bar shown at the top of the app. Each tab is a {key, label} pair.
// Active tab is highlighted; clicking switches via onChange.
export function Tabs({ tabs, active, onChange }) {
  return html`
    <div class="tabs">
      ${tabs.map(t => html`
        <button
          class="tab ${active === t.key ? 'tab-active' : ''}"
          onclick=${() => onChange(t.key)}
        >${t.label}</button>
      `)}
    </div>
  `;
}
