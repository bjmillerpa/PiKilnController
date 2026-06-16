import { html, useState, useEffect } from '../app.js';
import { renderMarkdown } from '../lib/markdown.js';

// Help tab — browses the help/ directory of bundled Markdown documents.
// The index lives at /docs/help/index.json and lists available docs. The
// MD content is fetched on demand and rendered client-side. Both the
// index and the .md files are static assets served by the relay and the
// Pi's HTTP server, so the same Help tab works for the operator UI and
// for read-only monitor viewers.
//
// We deliberately don't use a Markdown library — see web/lib/markdown.js
// for a small dependency-free renderer covering what our docs use.
export function HelpTab() {
  const [index, setIndex] = useState(null);
  const [indexError, setIndexError] = useState(null);
  const [selected, setSelected] = useState(null);   // slug
  const [content, setContent] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Load the doc index once on mount.
  useEffect(() => {
    fetch('/docs/help/index.json', { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => {
        const docs = Array.isArray(j?.docs) ? j.docs : [];
        setIndex(docs);
        // Auto-select the first doc if nothing's chosen yet.
        if (docs.length > 0) setSelected(docs[0].slug);
      })
      .catch(err => setIndexError(err.message));
  }, []);

  // Load doc content whenever the selection changes.
  useEffect(() => {
    if (!selected || !index) return;
    const doc = index.find(d => d.slug === selected);
    if (!doc) return;
    setContent(null);
    setLoadError(null);
    fetch(`/docs/help/${doc.file}`, { cache: 'no-cache' })
      .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(md => setContent(md))
      .catch(err => setLoadError(err.message));
  }, [selected, index]);

  if (indexError) {
    return html`
      <div class="section">
        <div class="section-title">Help</div>
        <div class="muted small">
          Couldn't load the doc index: ${indexError}. (The help docs are
          shipped in the release tarball under <code>web/docs/help/</code>.)
        </div>
      </div>
    `;
  }

  if (!index) {
    return html`
      <div class="section">
        <div class="section-title">Help</div>
        <div class="muted small">Loading…</div>
      </div>
    `;
  }

  const selectedDoc = index.find(d => d.slug === selected);
  const rendered = content != null ? renderMarkdown(content) : null;

  return html`
    <div class="help-tab">
      <div class="two-col" style="grid-template-columns: 220px 1fr; gap: 16px">
        <div class="section" style="padding:10px">
          <div class="section-title" style="margin-bottom:8px">Docs</div>
          ${index.map(d => html`
            <div
              class=${'help-doc-link' + (d.slug === selected ? ' active' : '')}
              onclick=${() => setSelected(d.slug)}
              title=${d.summary || ''}
              style="padding:6px 8px; cursor:pointer; border-radius:4px;
                     ${d.slug === selected
                       ? 'background:#1f3a5c; color:#fff'
                       : 'color:#cde'};
                     font-size:13px; margin-bottom:2px">
              ${d.title || d.slug}
            </div>
          `)}
        </div>

        <div class="section" style="padding:14px 20px; min-height:60vh">
          ${loadError && html`
            <div class="muted small">Couldn't load ${selectedDoc?.title}: ${loadError}</div>
          `}
          ${!loadError && content == null && html`
            <div class="muted small">Loading ${selectedDoc?.title}…</div>
          `}
          ${rendered && html`
            <div class="md-rendered" dangerouslySetInnerHTML=${{ __html: rendered }}></div>
          `}
        </div>
      </div>
    </div>
  `;
}
