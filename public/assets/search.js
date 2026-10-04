// Site search over /search-index.json, built with the site. No server, no third party.
(() => {
  const form = document.querySelector('[data-search]');
  const input = form && form.querySelector('input');
  const results = document.querySelector('[data-search-results]');
  const status = document.querySelector('[data-search-status]');
  if (!form || !input || !results) return;

  let index = null;
  const fold = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function load() {
    if (index) return index;
    const res = await fetch('/search-index.json', { cache: 'no-cache' });
    const raw = await res.json();
    index = raw.map((d) => ({
      ...d,
      _t: fold(d.t), _m: fold([d.ty, d.c, (d.sec || []).join(' '), (d.tg || []).join(' ')].join(' ')),
      _s: fold(d.s), _x: fold(d.x),
    }));
    return index;
  }

  function score(doc, terms) {
    let total = 0;
    for (const term of terms) {
      let s = 0;
      if (doc._t.includes(term)) s += 8;
      if (doc._m.includes(term)) s += 5;
      if (doc._s.includes(term)) s += 3;
      if (doc._x.includes(term)) s += 1;
      if (!s) return 0; // every word must appear somewhere
      total += s;
    }
    return total;
  }

  function snippet(doc, terms) {
    const text = doc.s || doc.x || '';
    if (doc.s) return esc(doc.s);
    const lower = fold(text);
    const at = Math.max(0, Math.min(...terms.map((t) => { const i = lower.indexOf(t); return i < 0 ? Infinity : i; })) - 60);
    const cut = (at > 0 ? '…' : '') + text.slice(at, at + 220) + (text.length > at + 220 ? '…' : '');
    let out = esc(cut);
    for (const t of terms) {
      if (t.length < 2) continue;
      out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
    }
    return out;
  }

  function render(found, terms) {
    results.innerHTML = found.map(({ doc }) => `
      <li class="entry">
        <div class="entry-meta">
          ${doc.ty ? `<span>${esc(doc.ty)}</span>` : ''}${doc.c ? `<span>${esc(doc.c)}</span>` : ''}${doc.d ? `<span>${esc(doc.d)}</span>` : ''}
        </div>
        <div class="entry-main">
          <h3 class="entry-title"><a href="${esc(doc.u)}">${esc(doc.t)}</a></h3>
          <p class="entry-summary">${snippet(doc, terms)}</p>
        </div>
      </li>`).join('');
  }

  async function run() {
    const q = input.value.trim();
    const url = new URL(location.href);
    if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
    history.replaceState(null, '', url);
    if (!q) { results.innerHTML = ''; status.textContent = ''; return; }
    let docs;
    try { docs = await load(); } catch { status.textContent = 'Search could not load. Reload the page to try again.'; return; }
    const terms = fold(q).split(/\s+/).filter(Boolean);
    const found = docs.map((doc) => ({ doc, s: score(doc, terms) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s);
    status.textContent = found.length ? `${found.length} ${found.length === 1 ? 'piece matches' : 'pieces match'} “${q}”` : `Nothing matches “${q}”. Try fewer words, or a client or type of writing.`;
    render(found, terms);
  }

  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  const initial = new URLSearchParams(location.search).get('q');
  if (initial) { input.value = initial; run(); }
})();
