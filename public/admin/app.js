// The admin view: edit pieces, sections, role pages, jobs and the profile.
// Every save is a commit to the GitHub repository; Publish rebuilds the public site.
import {
  h, api, ApiError, parseDoc, parseFields, serializeDoc, serializeFields, slugify, safeFileName,
  formatBytes, fileToBase64, markdownPreview, byOrder, RESERVED, DATE_RE, shortDate,
} from './lib.js';

const MAX_FILE = 20 * 1024 * 1024;
const PIECE_FILE_TYPES = ['pdf', 'docx', 'md', 'markdown', 'txt'];
const TYPE_SUGGESTIONS = ['Blog post', 'City guide', 'Landing page', 'Product page', 'Website copy', 'Press release',
  'Email', 'Social media', 'Case study', 'Help article', 'Product documentation', 'Essay', 'Poem'];

const state = {
  head: null, live: null, liveChecked: false, publishing: false, name: '',
  sections: [], jobs: [], roles: [], pieces: [], settings: {},
};

const view = document.getElementById('view');
const toastBox = document.getElementById('toast');
let dirty = false;
let lastHash = location.hash;

// ---------------------------------------------------------------- loading --

function ingest(files) {
  state.sections = []; state.jobs = []; state.roles = []; state.pieces = []; state.settings = {};
  for (const [path, text] of Object.entries(files)) {
    const m = path.match(/^content\/(sections|jobs|focus|pieces)\/([a-z0-9-]+)\.md$/);
    if (path === 'content/settings.yml') { state.settings = parseFields(text); continue; }
    if (!m) continue;
    const { data, body } = parseDoc(text);
    const item = { ...data, slug: m[2] };
    if (m[1] === 'sections') state.sections.push(item);
    if (m[1] === 'jobs') state.jobs.push(item);
    if (m[1] === 'focus') state.roles.push({ ...item, intro: body });
    if (m[1] === 'pieces') state.pieces.push({ ...item, body });
  }
  sortAll();
}

function sortAll() {
  state.sections.sort(byOrder);
  state.roles.sort(byOrder);
  state.jobs.sort((a, b) => (a.end ? 1 : 0) - (b.end ? 1 : 0) || String(b.start || '').localeCompare(String(a.start || '')));
  state.pieces.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.title).localeCompare(String(b.title)));
}

async function start() {
  try {
    const [session, content] = await Promise.all([api('/api/session'), api('/api/content')]);
    state.name = session.name;
    state.head = content.head;
    ingest(content.files);
  } catch (err) {
    if (err.status === 401) { location.href = '/admin/login'; return; }
    view.replaceChildren(h('div', { class: 'notice notice-error' },
      h('h1', {}, "The admin view couldn't load"), h('p', {}, err.message),
      h('p', {}, h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Try again'))));
    return;
  }
  document.getElementById('who').textContent = state.name;
  route();
  checkLive();
}

// --------------------------------------------------------------- saving ---

async function commit(files, message) {
  const res = await api('/api/commit', { method: 'POST', body: { base: state.head, message, files } });
  state.head = res.head;
  dirty = false;
  renderPublish();
}

async function upload(file, path) {
  if (file.size > MAX_FILE) throw new ApiError(`${file.name} is ${formatBytes(file.size)}. Files must be 20 MB or smaller; compress it and try again.`, 413);
  const content = await fileToBase64(file);
  const res = await api('/api/blob', { method: 'POST', rawBody: `{"content":"${content}","encoding":"base64"}` });
  return { path, sha: res.sha };
}

function explain(err) {
  if (err.status === 401) {
    return h('span', {}, 'Your session has ended. ', h('a', { href: '/admin/login', target: '_blank', rel: 'noopener' }, 'Log in again in a new tab'), ', then come back and save again. Your changes on this page are still here.');
  }
  return err.message || 'Something went wrong. Try again.';
}

// ------------------------------------------------------------ publishing ---

async function checkLive() {
  try {
    const res = await fetch(`/build.json?t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    state.live = data.commit || null;
  } catch {
    state.live = null;
  }
  state.liveChecked = true;
  renderPublish();
}

function renderPublish() {
  const box = document.getElementById('publish');
  if (!state.liveChecked) { box.replaceChildren(); return; }
  if (state.publishing) {
    box.replaceChildren(h('span', { class: 'publish-state busy' }, 'Publishing. The site updates in about a minute.'));
    return;
  }
  const isLive = state.live && state.live === state.head;
  if (isLive) {
    box.replaceChildren(h('span', { class: 'publish-state ok' }, 'Everything is live'));
    return;
  }
  box.replaceChildren(
    h('span', { class: 'publish-state pending' }, state.live ? 'Saved changes aren’t live yet' : 'Publish to update the site'),
    h('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: publish }, 'Publish'),
  );
}

async function publish() {
  if (dirty && !confirm('This page has unsaved changes. They won’t be published. Publish what’s already saved?')) return;
  state.publishing = true;
  renderPublish();
  let target;
  try {
    target = (await api('/api/publish', { method: 'POST' })).head;
    state.head = target;
  } catch (err) {
    state.publishing = false;
    renderPublish();
    toast(err.message, true);
    return;
  }
  const started = Date.now();
  const poll = async () => {
    await checkLive();
    if (state.live === target) {
      state.publishing = false;
      renderPublish();
      toast('Published. The site is up to date.');
      return;
    }
    if (Date.now() - started > 8 * 60 * 1000) {
      state.publishing = false;
      renderPublish();
      toast('Publishing is taking longer than usual. Open the Cloudflare dashboard (Workers & Pages → your project → Deployments) to check the build.', true);
      return;
    }
    state.publishing = true;
    renderPublish();
    setTimeout(poll, 8000);
  };
  setTimeout(poll, 15000);
}

// ---------------------------------------------------------------- shell ---

let toastTimer;
function toast(message, isError = false) {
  toastBox.textContent = message;
  toastBox.className = `toast${isError ? ' toast-error' : ''}`;
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastBox.hidden = true; }, isError ? 12000 : 5000);
}

function go(hash) {
  dirty = false;
  location.hash = hash;
}

function route() {
  const [, tab = 'pieces', id] = (location.hash || '#/pieces').split('/');
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const screens = {
    pieces: () => (id ? pieceEditor(id === 'new' ? null : id) : piecesList()),
    sections: () => (id ? sectionEditor(id === 'new' ? null : id) : sectionsList()),
    roles: () => (id ? roleEditor(id === 'new' ? null : id) : rolesList()),
    jobs: () => (id ? jobEditor(id === 'new' ? null : id) : jobsList()),
    profile: () => profileEditor(),
  };
  const screen = (screens[tab] || screens.pieces)();
  view.replaceChildren(screen);
  window.scrollTo(0, 0);
  const heading = view.querySelector('h1');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
}

window.addEventListener('hashchange', () => {
  if (dirty && !confirm('You have unsaved changes. Leave this page without saving?')) {
    history.replaceState(null, '', lastHash);
    return;
  }
  dirty = false;
  lastHash = location.hash;
  route();
});
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
// Editing a field clears its error message.
function touch(e) {
  if (!e.target.closest('form[data-editor]')) return;
  dirty = true;
  const wrap = e.target.closest('.field');
  if (!wrap) return;
  const err = wrap.querySelector('.field-error');
  if (err) { err.hidden = true; err.textContent = ''; }
  e.target.removeAttribute('aria-invalid');
}
view.addEventListener('input', touch);
view.addEventListener('change', touch);

document.getElementById('logout').addEventListener('click', async () => {
  if (dirty && !confirm('You have unsaved changes. Log out anyway?')) return;
  dirty = false;
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/admin/login';
});

// --------------------------------------------------------- form helpers ---

let uid = 0;
function field(label, control, { hint, required, name } = {}) {
  const id = control.id || `f${(uid += 1)}`;
  control.id = id;
  const errId = `${name || id}-error`;
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'field', 'data-field': name || '' },
    h('label', { class: 'field-label', for: id }, label, required ? h('span', { class: 'req' }, ' (required)') : null),
    hint ? h('p', { class: 'field-hint', id: hintId }, hint) : null,
    control,
    h('p', { class: 'field-error', id: errId, hidden: true }));
}

const input = (name, value, attrs = {}) => h('input', { name, value: value ?? '', ...attrs });
const textarea = (name, value, attrs = {}) => h('textarea', { name, rows: 4, ...attrs }, value ?? '');

function checkbox(name, checked, label, hint) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', name, checked }),
    h('span', {}, label, hint ? h('span', { class: 'check-hint' }, hint) : null));
}

function checkboxGroup(name, options, selected, legend, hint) {
  return h('fieldset', { class: 'field', 'data-field': name },
    h('legend', { class: 'field-label' }, legend),
    hint ? h('p', { class: 'field-hint' }, hint) : null,
    h('div', { class: 'checks' }, options.map((o) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', name, value: o.value, checked: selected.includes(o.value) }),
      h('span', {}, o.label)))),
    h('p', { class: 'field-error', id: `${name}-error`, hidden: true }));
}

function radioGroup(name, options, selected, legend) {
  return h('fieldset', { class: 'field' },
    h('legend', { class: 'field-label' }, legend),
    h('div', { class: 'checks' }, options.map((o) => h('label', { class: 'check' },
      h('input', { type: 'radio', name, value: o.value, checked: o.value === selected }),
      h('span', {}, o.label, o.hint ? h('span', { class: 'check-hint' }, o.hint) : null)))));
}

function datalist(id, values) {
  return h('datalist', { id }, [...new Set(values.filter(Boolean))].map((v) => h('option', { value: v })));
}

function checkedValues(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
}

function lines(value) {
  return String(value || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function clearErrors(form) {
  for (const p of form.querySelectorAll('.field-error')) { p.hidden = true; p.textContent = ''; }
  for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  const banner = form.querySelector('.form-error');
  if (banner) { banner.hidden = true; banner.replaceChildren(); }
}

function showErrors(form, errors) {
  let first = null;
  for (const [name, message] of Object.entries(errors)) {
    const p = form.querySelector(`#${CSS.escape(name)}-error`);
    if (p) { p.textContent = message; p.hidden = false; }
    const control = form.querySelector(`[name="${name}"]`);
    if (control) { control.setAttribute('aria-invalid', 'true'); first = first || control; }
  }
  if (first) first.focus();
}

function formBanner(form, content) {
  const banner = form.querySelector('.form-error');
  banner.replaceChildren(typeof content === 'string' ? document.createTextNode(content) : content);
  banner.hidden = false;
  banner.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// A list of rows with the same fields (publications, education, highlights…).
function rows(fields, items, addLabel) {
  const list = h('div', { class: 'rows' });
  const addRow = (item = {}) => {
    const row = h('div', { class: 'row' },
      h('div', { class: 'row-fields' }, fields.map((f) => h('label', { class: `row-field${f.wide ? ' wide' : ''}` },
        h('span', { class: 'row-label' }, f.label),
        h('input', { 'data-key': f.key, value: item[f.key] ?? '', placeholder: f.placeholder || '' })))),
      h('div', { class: 'row-tools' },
        h('button', { type: 'button', class: 'btn btn-small btn-quiet', 'aria-label': 'Move up', onclick: () => { if (row.previousElementSibling) { list.insertBefore(row, row.previousElementSibling); dirty = true; } } }, 'Up'),
        h('button', { type: 'button', class: 'btn btn-small btn-quiet', 'aria-label': 'Move down', onclick: () => { if (row.nextElementSibling) { list.insertBefore(row.nextElementSibling, row); dirty = true; } } }, 'Down'),
        h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => { row.remove(); dirty = true; } }, 'Remove')));
    list.append(row);
    return row;
  };
  items.forEach((i) => addRow(i));
  const el = h('div', { class: 'rows-wrap' }, list,
    h('button', { type: 'button', class: 'btn btn-small', onclick: () => { const r = addRow(); r.querySelector('input').focus(); dirty = true; } }, addLabel));
  return {
    el,
    value: () => [...list.children].map((r) => Object.fromEntries([...r.querySelectorAll('input')].map((i) => [i.dataset.key, i.value.trim()])))
      .filter((o) => Object.values(o).some(Boolean)),
  };
}

// One file slot (a CV, a photo): shows the current file and lets you replace or remove it.
function fileSlot(name, currentUrl, accept, label) {
  let pending = null;
  let removed = false;
  const status = h('span', { class: 'slot-status' });
  const picker = h('input', { type: 'file', accept, class: 'visually-hidden', id: `${name}-file` });
  const removeBtn = h('button', { type: 'button', class: 'btn btn-small btn-quiet' }, 'Remove');
  const paint = () => {
    if (pending) status.replaceChildren(`New file: ${pending.name} (${formatBytes(pending.size)}). It uploads when you save.`);
    else if (currentUrl && !removed) status.replaceChildren(h('a', { href: currentUrl, target: '_blank', rel: 'noopener' }, currentUrl.split('/').pop()));
    else status.replaceChildren(removed ? 'Will be removed when you save.' : 'No file yet.');
    removeBtn.hidden = !(pending || (currentUrl && !removed));
  };
  picker.addEventListener('change', () => { if (picker.files[0]) { pending = picker.files[0]; removed = false; dirty = true; paint(); } });
  removeBtn.addEventListener('click', () => { pending = null; removed = true; picker.value = ''; dirty = true; paint(); });
  paint();
  const el = h('div', { class: 'field', 'data-field': name },
    h('span', { class: 'field-label' }, label),
    h('div', { class: 'slot' }, status,
      h('label', { class: 'btn btn-small', for: `${name}-file` }, currentUrl ? 'Replace' : 'Choose file'), picker, removeBtn),
    h('p', { class: 'field-error', id: `${name}-error`, hidden: true }));
  return { el, get pending() { return pending; }, get removed() { return removed; } };
}

function editorShell(title, form, { backHash, backLabel, deleteAction, viewUrl }) {
  return h('div', { class: 'editor' },
    h('p', { class: 'crumb' }, h('a', { href: backHash }, backLabel)),
    h('div', { class: 'editor-head' },
      h('h1', {}, title),
      viewUrl ? h('a', { class: 'editor-view', href: viewUrl, target: '_blank', rel: 'noopener' }, 'View on the site') : null),
    form,
    deleteAction ? h('div', { class: 'danger-zone' },
      h('button', { type: 'button', class: 'btn btn-danger', onclick: deleteAction }, 'Delete')) : null);
}

function formActions(saveLabel, cancelHash) {
  return h('div', { class: 'form-actions' },
    h('button', { class: 'btn btn-primary', type: 'submit' }, saveLabel),
    h('a', { class: 'btn btn-quiet', href: cancelHash }, 'Cancel'),
    h('p', { class: 'form-note' }, 'Saving keeps your changes. Use Publish at the top to put them on the site.'));
}

async function runSave(form, button, work) {
  const label = button.textContent;
  button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  try {
    await work((text) => { button.textContent = text; });
    return true;
  } catch (err) {
    formBanner(form, explain(err));
    return false;
  } finally {
    button.disabled = false;
    button.textContent = label;
    form.removeAttribute('aria-busy');
  }
}

// ---------------------------------------------------------------- pieces ---

const sectionTitle = (slug) => (state.sections.find((s) => s.slug === slug) || {}).title || slug;
const jobBySlug = (slug) => state.jobs.find((j) => j.slug === slug);
const companyOf = (p) => p.company || (jobBySlug(p.job) || {}).shortName || (jobBySlug(p.job) || {}).company || '';
const VIS_LABEL = { public: 'Public', unlisted: 'Unlisted', draft: 'Draft' };

function piecesList() {
  const search = h('input', { type: 'search', placeholder: 'Search by title, company or type', 'aria-label': 'Search pieces' });
  const sectionFilter = h('select', { 'aria-label': 'Filter by section' },
    h('option', { value: '' }, 'All sections'), state.sections.map((s) => h('option', { value: s.slug }, s.title)));
  const tbody = h('tbody');
  const count = h('p', { class: 'list-count', 'aria-live': 'polite' });

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const sec = sectionFilter.value;
    const shown = state.pieces.filter((p) => (!sec || (p.sections || []).includes(sec))
      && (!q || [p.title, companyOf(p), p.type].join(' ').toLowerCase().includes(q)));
    count.textContent = `${shown.length} of ${state.pieces.length} pieces`;
    tbody.replaceChildren(...shown.map((p) => h('tr', {},
      h('td', {}, h('a', { class: 'row-title', href: `#/pieces/${p.slug}` }, p.title || p.slug),
        p.featured ? h('span', { class: 'badge' }, 'Featured') : null),
      h('td', {}, (p.sections || []).map(sectionTitle).join(', ')),
      h('td', {}, p.type || ''),
      h('td', {}, companyOf(p)),
      h('td', { class: 'nowrap' }, shortDate(p.date)),
      h('td', {}, h('span', { class: `vis vis-${p.visibility || 'public'}` }, VIS_LABEL[p.visibility || 'public'])))));
  };
  search.addEventListener('input', paint);
  sectionFilter.addEventListener('change', paint);
  paint();

  if (!state.pieces.length) {
    return h('div', {},
      h('div', { class: 'list-head' }, h('h1', {}, 'Pieces')),
      h('div', { class: 'empty-state' },
        h('p', {}, 'No pieces yet. Add the first one: a city guide, a landing page, a press release or a poem. Upload a Word file or PDF, add a link, or paste the text.'),
        h('a', { class: 'btn btn-primary', href: '#/pieces/new' }, 'Add a piece')));
  }
  return h('div', {},
    h('div', { class: 'list-head' }, h('h1', {}, 'Pieces'), h('a', { class: 'btn btn-primary', href: '#/pieces/new' }, 'Add a piece')),
    h('div', { class: 'list-tools' }, search, sectionFilter, count),
    h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Title', 'Sections', 'Type', 'Company', 'Date', 'Status'].map((t) => h('th', { scope: 'col' }, t)))),
      tbody)));
}

function pieceEditor(slug) {
  const existing = slug ? state.pieces.find((p) => p.slug === slug) : null;
  if (slug && !existing) return notFound('piece', '#/pieces', 'Back to pieces');
  const p = existing ? structuredClone(existing) : { title: '', sections: [], visibility: 'public', files: [], links: [], tags: [] };
  const isNew = !existing;
  let slugTouched = false;
  let breaksTouched = Boolean(existing);

  const form = h('form', { class: 'form', 'data-editor': 'piece', novalidate: true });
  const title = input('title', p.title, { required: true, autocomplete: 'off' });
  const slugInput = input('slug', p.slug || '', { pattern: '[a-z0-9-]+', spellcheck: 'false', disabled: !isNew });
  const urlPreview = h('span', { class: 'mono' });
  const paintUrl = () => { urlPreview.textContent = `${location.origin}/work/${slugInput.value || '…'}/`; };
  title.addEventListener('input', () => { if (isNew && !slugTouched) { slugInput.value = slugify(title.value); paintUrl(); } });
  slugInput.addEventListener('input', () => { slugTouched = true; paintUrl(); });
  paintUrl();

  // --- the work itself
  const keepFiles = (p.files || []).map((f) => ({ ...f, keep: true }));
  const newFiles = [];
  const fileList = h('ul', { class: 'file-list' });
  const paintFiles = () => {
    fileList.replaceChildren(
      ...keepFiles.map((f) => h('li', { class: f.keep ? '' : 'removed' },
        h('a', { href: f.path, target: '_blank', rel: 'noopener' }, f.name || f.path.split('/').pop()),
        h('span', { class: 'muted' }, f.keep ? ` ${formatBytes(f.size)}` : ' will be removed when you save'),
        h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => { f.keep = !f.keep; dirty = true; paintFiles(); } }, f.keep ? 'Remove' : 'Keep'))),
      ...newFiles.map((file, i) => h('li', { class: 'pending' },
        h('span', {}, file.name), h('span', { class: 'muted' }, ` ${formatBytes(file.size)}, uploads when you save`),
        h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => { newFiles.splice(i, 1); dirty = true; paintFiles(); } }, 'Remove'))));
  };
  const fileError = h('p', { class: 'field-error', id: 'files-error', hidden: true });
  const addFiles = (list) => {
    fileError.hidden = true;
    const problems = [];
    for (const file of list) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!PIECE_FILE_TYPES.includes(ext)) problems.push(`${file.name} isn't a PDF, Word (.docx), Markdown or text file.`);
      else if (file.size > MAX_FILE) problems.push(`${file.name} is ${formatBytes(file.size)}. Files must be 20 MB or smaller.`);
      else newFiles.push(file);
    }
    if (problems.length) { fileError.textContent = problems.join(' '); fileError.hidden = false; }
    dirty = true;
    paintFiles();
  };
  const picker = h('input', { type: 'file', multiple: true, accept: '.pdf,.docx,.md,.markdown,.txt', class: 'visually-hidden', id: 'piece-files' });
  picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
  const drop = h('div', { class: 'drop' },
    h('p', {}, 'Drop PDF, Word (.docx), Markdown or text files here, or ', h('label', { for: 'piece-files', class: 'linkish' }, 'choose files'), '.'),
    h('p', { class: 'field-hint' }, 'Word and Markdown files become web text. PDFs show page by page with a download button. Up to 20 MB each.'),
    picker);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  paintFiles();

  const linkList = h('div', { class: 'links' });
  const addLink = (link = {}) => {
    const url = h('input', { 'data-key': 'url', value: link.url || '', placeholder: 'https://', type: 'url', inputmode: 'url', 'aria-label': 'Link address' });
    const fields = ['title', 'description', 'site', 'image', 'archive'].map((k) => h('label', { class: 'row-field wide' },
      h('span', { class: 'row-label' }, { title: 'Title', description: 'Description', site: 'Site name', image: 'Preview image address', archive: 'Archived copy (Wayback Machine)' }[k]),
      k === 'description' ? h('textarea', { 'data-key': k, rows: 2 }, link[k] || '') : h('input', { 'data-key': k, value: link[k] || '' })));
    const details = h('details', { class: 'link-details', open: Boolean(link.title) }, h('summary', {}, 'Preview details'), ...fields);
    const note = h('p', { class: 'field-hint link-note' });
    const fetchBtn = h('button', { type: 'button', class: 'btn btn-small' }, 'Fetch preview');
    fetchBtn.addEventListener('click', async () => {
      if (!/^https?:\/\/\S+\.\S+/.test(url.value.trim())) { note.textContent = 'Enter a full link that starts with https://'; return; }
      fetchBtn.disabled = true; fetchBtn.textContent = 'Fetching…'; note.textContent = '';
      try {
        const data = await api(`/api/unfurl?url=${encodeURIComponent(url.value.trim())}`);
        for (const k of ['title', 'description', 'site', 'image', 'archive']) {
          const el = details.querySelector(`[data-key="${k}"]`);
          if (data[k] && !el.value) el.value = data[k];
        }
        details.open = true;
        note.textContent = [data.problem, data.archiveRequested ? 'The Wayback Machine had no copy yet, so it has been asked to save one. Fetch again in a few minutes to add it.' : ''].filter(Boolean).join(' ');
        dirty = true;
      } catch (err) {
        note.textContent = err.message;
      } finally {
        fetchBtn.disabled = false; fetchBtn.textContent = 'Fetch preview';
      }
    });
    const block = h('div', { class: 'link-block' },
      h('div', { class: 'link-row' }, url, fetchBtn,
        h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => { block.remove(); dirty = true; } }, 'Remove')),
      note, details);
    linkList.append(block);
    return block;
  };
  (p.links || []).forEach(addLink);

  const body = textarea('body', p.body || '', { rows: 14, class: 'body-text' });
  const preview = h('div', { class: 'preview prose', hidden: true });
  const breaks = h('input', { type: 'checkbox', name: 'lineBreaks', checked: Boolean(p.lineBreaks) });
  breaks.addEventListener('change', () => { breaksTouched = true; });
  const previewBtn = h('button', { type: 'button', class: 'btn btn-small btn-quiet' }, 'Preview');
  previewBtn.addEventListener('click', () => {
    const showing = !preview.hidden;
    preview.hidden = showing; body.hidden = !showing;
    previewBtn.textContent = showing ? 'Preview' : 'Edit';
    if (!showing) preview.innerHTML = markdownPreview(body.value, breaks.checked) || '<p class="muted">Nothing to preview yet.</p>';
  });

  // --- details
  const jobSelect = h('select', { name: 'job' }, h('option', { value: '' }, 'None (freelance, personal or a publication)'),
    state.jobs.map((j) => h('option', { value: j.slug, selected: j.slug === p.job }, `${j.title}, ${j.shortName || j.company}`)));
  const company = input('company', p.company || '', { list: 'company-list' });
  const role = input('role', p.role || '');
  const paintJobHints = () => {
    const job = jobBySlug(jobSelect.value);
    company.placeholder = job ? `${job.shortName || job.company} (from the job)` : 'Client or publication';
    role.placeholder = job ? `${job.title} (from the job)` : 'For example: Copywriter';
  };
  jobSelect.addEventListener('change', paintJobHints);
  paintJobHints();

  const typeInput = input('type', p.type || '', { list: 'type-list' });
  const autoBreaks = () => {
    if (breaksTouched) return;
    const poetic = typeInput.value.trim().toLowerCase() === 'poem'
      || checkedValues(form, 'sections').some((s) => (state.sections.find((x) => x.slug === s) || {}).lineBreaks);
    breaks.checked = poetic;
  };
  typeInput.addEventListener('input', autoBreaks);

  const sectionsGroup = checkboxGroup('sections', state.sections.map((s) => ({ value: s.slug, label: s.title })), p.sections || [],
    'Sections', 'Where this piece is listed. Pick one or more.');
  sectionsGroup.addEventListener('change', autoBreaks);

  form.append(
    h('div', { class: 'form-error', role: 'alert', hidden: true }),
    h('section', { class: 'form-block' },
      h('h2', {}, 'The piece'),
      field('Title', title, { required: true, name: 'title' }),
      field('Web address', slugInput, { name: 'slug', hint: isNew ? 'Made from the title. You can shorten it. It can\'t change after the first save.' : 'This can\'t change, so links to the piece keep working.' }),
      h('p', { class: 'field-hint url-preview' }, urlPreview),
      sectionsGroup,
      field('Type of writing', typeInput, { name: 'type', hint: 'For example: City guide, Landing page, Press release, Poem.' }),
      field('Date', input('date', p.date || '', { placeholder: 'YYYY-MM, for example 2024-03', inputmode: 'numeric' }), { name: 'date', hint: 'A year (2024), a month (2024-03) or a day (2024-03-09).' }),
      field('Summary', input('summary', p.summary || '', { maxlength: 200 }), { name: 'summary', hint: 'One sentence shown in lists and search results.' })),
    h('section', { class: 'form-block' },
      h('h2', {}, 'The work'),
      h('p', { class: 'block-hint' }, 'Add at least one: a file, a link to where it\'s published, or the text itself.'),
      h('div', { class: 'field', 'data-field': 'files' }, h('span', { class: 'field-label' }, 'Files'), drop, fileList, fileError),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Links'),
        h('p', { class: 'field-hint' }, 'Where the piece is published. The site shows a preview card and keeps a link to an archived copy in case the page moves.'),
        linkList,
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => { addLink().querySelector('input').focus(); dirty = true; } }, 'Add a link')),
      h('div', { class: 'field' },
        h('div', { class: 'label-row' }, h('label', { class: 'field-label', for: 'body-text' }, 'Text'), previewBtn),
        h('p', { class: 'field-hint' }, 'Paste or type the piece. Markdown works: **bold**, *italic*, ## heading, - list item, [link](https://…).'),
        Object.assign(body, { id: 'body-text' }), preview,
        h('label', { class: 'check' }, breaks, h('span', {}, 'Keep line breaks', h('span', { class: 'check-hint' }, 'For poems: each new line stays a new line.')))),
    ),
    h('section', { class: 'form-block' },
      h('h2', {}, 'Specimen label'),
      h('p', { class: 'block-hint' }, 'The details shown beside the piece.'),
      field('Job', jobSelect, { name: 'job', hint: 'Fills in the company and role. Leave as None for freelance work or a publication.' }),
      field('Company, client or publication', company, { name: 'company' }),
      field('Role', role, { name: 'role' }),
      field('Brief', textarea('brief', p.brief || '', { rows: 3 }), { name: 'brief', hint: 'What the piece had to do and for whom.' }),
      field('Result', input('result', p.result || ''), { name: 'result', hint: 'Only a result she can explain in an interview: what was measured and over what time.' }),
      field('Skills', input('tags', (p.tags || []).join(', ')), { name: 'tags', hint: 'Separate with commas. For example: SEO, Web copy, Travel.' })),
    h('section', { class: 'form-block' },
      h('h2', {}, 'Where it shows'),
      radioGroup('visibility', [
        { value: 'public', label: 'Public', hint: 'Listed on the site and in search.' },
        { value: 'unlisted', label: 'Unlisted', hint: 'Only people with the link can see it. Good for samples you send privately.' },
        { value: 'draft', label: 'Draft', hint: 'Saved here but not on the site.' },
      ], p.visibility || 'public', 'Visibility'),
      checkbox('featured', p.featured, 'Feature on the home page', 'Up to six featured pieces appear under Selected work.'),
      field('Order', input('order', p.order ?? '', { type: 'number', min: 1, max: 99, class: 'short' }), { name: 'order', hint: 'Lower numbers come first among featured pieces.' })),
    formActions(isNew ? 'Save piece' : 'Save changes', '#/pieces'),
    datalist('type-list', [...TYPE_SUGGESTIONS, ...state.pieces.map((x) => x.type)]),
    datalist('company-list', state.pieces.map((x) => x.company)),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const f = form.elements;
    const finalSlug = isNew ? slugify(slugInput.value || title.value) : p.slug;
    const errors = {};
    if (!title.value.trim()) errors.title = 'Enter a title.';
    if (isNew && !finalSlug) errors.slug = 'Enter a web address using letters and numbers.';
    else if (isNew && state.pieces.some((x) => x.slug === finalSlug)) errors.slug = `Another piece already uses /work/${finalSlug}/. Change the web address.`;
    if (state.sections.length && !checkedValues(form, 'sections').length) errors.sections = 'Pick at least one section.';
    if (f.date.value.trim() && !DATE_RE.test(f.date.value.trim())) errors.date = 'Use YYYY, YYYY-MM or YYYY-MM-DD, for example 2024-03.';
    const links = [...linkList.querySelectorAll('.link-block')].map((b) => Object.fromEntries([...b.querySelectorAll('[data-key]')].map((el) => [el.dataset.key, el.value.trim()]))).filter((l) => l.url);
    if (links.some((l) => !/^https?:\/\/\S+$/.test(l.url))) errors.links = 'Each link must start with https://';
    const hasWork = keepFiles.some((x) => x.keep) || newFiles.length || links.length || body.value.trim();
    if (!hasWork) errors.files = 'Add the work itself: upload a file, add a link, or paste the text.';
    if (Object.keys(errors).length) {
      if (errors.links) formBanner(form, errors.links);
      showErrors(form, errors);
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    const ok = await runSave(form, button, async (progress) => {
      const changes = [];
      const files = keepFiles.filter((x) => x.keep).map(({ keep, ...rest }) => rest);
      for (const removed of keepFiles.filter((x) => !x.keep)) changes.push({ path: `public${removed.path}`, delete: true });
      const used = new Set(files.map((x) => x.path));
      for (const [i, file] of newFiles.entries()) {
        progress(`Uploading ${i + 1} of ${newFiles.length}…`);
        let name = safeFileName(file.name);
        let sitePath = `/files/${finalSlug}/${name}`;
        // Re-uploading a file with the same name replaces it.
        const same = files.findIndex((x) => x.path === sitePath);
        if (same >= 0) files.splice(same, 1);
        else for (let n = 2; used.has(sitePath); n += 1) { name = name.replace(/(-\d+)?(\.[a-z0-9]+)?$/, `-${n}$2`); sitePath = `/files/${finalSlug}/${name}`; }
        used.add(sitePath);
        changes.push(await upload(file, `public${sitePath}`));
        files.push({ path: sitePath, name: file.name, size: file.size });
      }
      progress('Saving…');
      const data = {
        title: title.value.trim(),
        sections: checkedValues(form, 'sections'),
        type: f.type.value.trim(),
        date: f.date.value.trim(),
        job: f.job.value,
        company: f.company.value.trim(),
        role: f.role.value.trim(),
        summary: f.summary.value.trim(),
        brief: f.brief.value.trim(),
        result: f.result.value.trim(),
        tags: f.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
        featured: f.featured.checked,
        order: f.order.value ? Number(f.order.value) : '',
        visibility: f.visibility.value,
        lineBreaks: breaks.checked,
        files,
        links,
      };
      changes.push({ path: `content/pieces/${finalSlug}.md`, content: serializeDoc(data, body.value) });
      await commit(changes, `${isNew ? 'Add' : 'Edit'} piece: ${data.title}`);
      const saved = { ...data, slug: finalSlug, body: body.value.trim() };
      state.pieces = state.pieces.filter((x) => x.slug !== finalSlug).concat(saved);
      sortAll();
    });
    if (ok) { toast(`Saved “${title.value.trim()}”. Publish to put it on the site.`); go('#/pieces'); }
  });

  const deleteAction = isNew ? null : async () => {
    if (!confirm(`Delete “${p.title}” and its files? It leaves the site the next time you publish.`)) return;
    try {
      await commit([{ path: `content/pieces/${p.slug}.md`, delete: true }, ...(p.files || []).map((x) => ({ path: `public${x.path}`, delete: true }))], `Delete piece: ${p.title}`);
      state.pieces = state.pieces.filter((x) => x.slug !== p.slug);
      toast(`Deleted “${p.title}”. Publish to remove it from the site.`);
      go('#/pieces');
    } catch (err) { formBanner(form, explain(err)); }
  };

  return editorShell(isNew ? 'Add a piece' : p.title, form, {
    backHash: '#/pieces', backLabel: 'Pieces', deleteAction,
    viewUrl: !isNew && p.visibility !== 'draft' ? `/work/${p.slug}/` : null,
  });
}

// -------------------------------------------------------------- sections ---

function sectionsList() {
  return h('div', {},
    h('div', { class: 'list-head' }, h('h1', {}, 'Sections'), h('a', { class: 'btn btn-primary', href: '#/sections/new' }, 'Add a section')),
    h('p', { class: 'page-hint' }, 'Sections group the work on the site, such as Copywriting or Poetry. A section only appears once it has a public piece.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Section', 'Web address', 'Pieces', 'Shown'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, state.sections.map((s) => h('tr', {},
        h('td', {}, h('a', { class: 'row-title', href: `#/sections/${s.slug}` }, s.title || s.slug)),
        h('td', { class: 'mono' }, `/${s.slug}/`),
        h('td', {}, String(state.pieces.filter((p) => (p.sections || []).includes(s.slug)).length)),
        h('td', {}, s.visible === false ? 'Hidden' : 'Yes')))))));
}

function sectionEditor(slug) {
  const existing = slug ? state.sections.find((s) => s.slug === slug) : null;
  if (slug && !existing) return notFound('section', '#/sections', 'Back to sections');
  const s = existing ? { ...existing } : { title: '', description: '', order: state.sections.length + 1, visible: true, lineBreaks: false };
  const isNew = !existing;
  const form = h('form', { class: 'form', 'data-editor': 'section', novalidate: true });
  const title = input('title', s.title, { required: true });
  const slugInput = input('slug', s.slug || '', { disabled: !isNew, spellcheck: 'false' });
  let touched = false;
  title.addEventListener('input', () => { if (isNew && !touched) slugInput.value = slugify(title.value); });
  slugInput.addEventListener('input', () => { touched = true; });

  form.append(
    h('div', { class: 'form-error', role: 'alert', hidden: true }),
    h('section', { class: 'form-block' },
      field('Name', title, { required: true, name: 'title' }),
      field('Web address', slugInput, { name: 'slug', hint: isNew ? 'The section\'s page will be at /your-address/. It can\'t change later.' : `The page is at /${s.slug}/.` }),
      field('Description', input('description', s.description || ''), { name: 'description', hint: 'One line shown under the section name.' }),
      field('Order', input('order', s.order ?? '', { type: 'number', min: 1, max: 99, class: 'short' }), { name: 'order', hint: 'Lower numbers come first.' }),
      checkbox('visible', s.visible !== false, 'Show this section on the site'),
      checkbox('lineBreaks', s.lineBreaks, 'Keep line breaks in its pieces', 'Turn this on for poetry.')),
    formActions(isNew ? 'Save section' : 'Save changes', '#/sections'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const f = form.elements;
    const finalSlug = isNew ? slugify(slugInput.value || title.value) : s.slug;
    const errors = {};
    if (!title.value.trim()) errors.title = 'Enter a name.';
    if (isNew && !finalSlug) errors.slug = 'Enter a web address using letters and numbers.';
    else if (isNew && RESERVED.has(finalSlug)) errors.slug = `“${finalSlug}” is used by another part of the site. Choose a different address.`;
    else if (isNew && state.sections.some((x) => x.slug === finalSlug)) errors.slug = 'Another section already uses that address.';
    if (Object.keys(errors).length) { showErrors(form, errors); return; }
    const data = {
      title: title.value.trim(), description: f.description.value.trim(),
      order: f.order.value ? Number(f.order.value) : 99, visible: f.visible.checked, lineBreaks: f.lineBreaks.checked,
    };
    const ok = await runSave(form, form.querySelector('[type=submit]'), async (progress) => {
      progress('Saving…');
      await commit([{ path: `content/sections/${finalSlug}.md`, content: serializeDoc(data) }], `${isNew ? 'Add' : 'Edit'} section: ${data.title}`);
      state.sections = state.sections.filter((x) => x.slug !== finalSlug).concat({ ...data, slug: finalSlug });
      sortAll();
    });
    if (ok) { toast(`Saved the ${data.title} section.`); go('#/sections'); }
  });

  const deleteAction = isNew ? null : async () => {
    const using = state.pieces.filter((p) => (p.sections || []).includes(s.slug));
    const msg = using.length
      ? `Delete the ${s.title} section? ${using.length} ${using.length === 1 ? 'piece is' : 'pieces are'} in it. They stay on the site under their other sections; pieces only in this section will have no section.`
      : `Delete the ${s.title} section?`;
    if (!confirm(msg)) return;
    const changes = [{ path: `content/sections/${s.slug}.md`, delete: true }];
    const updatedPieces = using.map((p) => ({ ...p, sections: p.sections.filter((x) => x !== s.slug) }));
    for (const p of updatedPieces) { const { slug: ps, body, ...data } = p; changes.push({ path: `content/pieces/${ps}.md`, content: serializeDoc(data, body) }); }
    const updatedRoles = state.roles.filter((r) => (r.sections || []).includes(s.slug)).map((r) => ({ ...r, sections: r.sections.filter((x) => x !== s.slug) }));
    for (const r of updatedRoles) { const { slug: rs, intro, ...data } = r; changes.push({ path: `content/focus/${rs}.md`, content: serializeDoc(data, intro) }); }
    try {
      await commit(changes, `Delete section: ${s.title}`);
      state.sections = state.sections.filter((x) => x.slug !== s.slug);
      for (const p of updatedPieces) state.pieces = state.pieces.map((x) => (x.slug === p.slug ? p : x));
      for (const r of updatedRoles) state.roles = state.roles.map((x) => (x.slug === r.slug ? r : x));
      toast(`Deleted the ${s.title} section.`);
      go('#/sections');
    } catch (err) { formBanner(form, explain(err)); }
  };
  return editorShell(isNew ? 'Add a section' : s.title, form, { backHash: '#/sections', backLabel: 'Sections', deleteAction, viewUrl: isNew ? null : `/${s.slug}/` });
}

// ------------------------------------------------------------ role pages ---

function rolesList() {
  return h('div', {},
    h('div', { class: 'list-head' }, h('h1', {}, 'Role pages'), h('a', { class: 'btn btn-primary', href: '#/roles/new' }, 'Add a role page')),
    h('p', { class: 'page-hint' }, 'Each role page gathers the samples for one kind of job. Put its link on the matching CV.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Role', 'Link for the CV', 'Pinned samples'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, state.roles.map((r) => h('tr', {},
        h('td', {}, h('a', { class: 'row-title', href: `#/roles/${r.slug}` }, r.title || r.slug)),
        h('td', { class: 'mono' }, `${location.host}/for/${r.slug}/`),
        h('td', {}, String((r.pinned || []).length))))))));
}

function roleEditor(slug) {
  const existing = slug ? state.roles.find((r) => r.slug === slug) : null;
  if (slug && !existing) return notFound('role page', '#/roles', 'Back to role pages');
  const r = existing ? structuredClone(existing) : { title: '', sections: [], pinned: [], highlights: [], cv: '', order: state.roles.length + 1, intro: '' };
  const isNew = !existing;
  const form = h('form', { class: 'form', 'data-editor': 'role', novalidate: true });
  const title = input('title', r.title, { required: true });
  const slugInput = input('slug', r.slug || '', { disabled: !isNew, spellcheck: 'false' });
  let touched = false;
  title.addEventListener('input', () => { if (isNew && !touched) slugInput.value = slugify(title.value); });
  slugInput.addEventListener('input', () => { touched = true; });

  // Pinned samples, in order.
  const pinned = [...(r.pinned || [])];
  const pinList = h('ol', { class: 'pin-list' });
  const choosable = () => state.pieces.filter((p) => p.visibility !== 'draft' && !pinned.includes(p.slug));
  const pinSelect = h('select', { 'aria-label': 'Choose a piece to pin' });
  const paintPins = () => {
    pinList.replaceChildren(...pinned.map((s, i) => {
      const p = state.pieces.find((x) => x.slug === s);
      return h('li', {}, h('span', {}, p ? p.title : `${s} (deleted)`, p && p.visibility === 'unlisted' ? h('span', { class: 'badge' }, 'Unlisted') : null),
        h('span', { class: 'row-tools' },
          h('button', { type: 'button', class: 'btn btn-small btn-quiet', disabled: i === 0, onclick: () => { [pinned[i - 1], pinned[i]] = [pinned[i], pinned[i - 1]]; dirty = true; paintPins(); } }, 'Up'),
          h('button', { type: 'button', class: 'btn btn-small btn-quiet', disabled: i === pinned.length - 1, onclick: () => { [pinned[i + 1], pinned[i]] = [pinned[i], pinned[i + 1]]; dirty = true; paintPins(); } }, 'Down'),
          h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => { pinned.splice(i, 1); dirty = true; paintPins(); } }, 'Remove')));
    }));
    if (!pinned.length) pinList.replaceChildren(h('li', { class: 'muted' }, 'No pinned samples. The page shows the newest pieces from the sections above.'));
    pinSelect.replaceChildren(h('option', { value: '' }, choosable().length ? 'Choose a piece…' : 'No more pieces to pin'),
      ...choosable().map((p) => h('option', { value: p.slug }, p.title)));
  };
  paintPins();
  const cv = fileSlot('cv', r.cv, '.pdf,application/pdf', 'CV for this role (PDF)');

  form.append(
    h('div', { class: 'form-error', role: 'alert', hidden: true }),
    h('section', { class: 'form-block' },
      field('Role', title, { required: true, name: 'title', hint: 'For example: Copywriter. It becomes the page heading.' }),
      field('Web address', slugInput, { name: 'slug', hint: isNew ? 'The page will be at /for/your-address/. It can\'t change later.' : `Put this link on the matching CV: ${location.origin}/for/${r.slug}/` }),
      field('Introduction', textarea('intro', r.intro || '', { rows: 4 }), { name: 'intro', hint: 'Two or three sentences on what she does in this role.' }),
      field('Highlights', textarea('highlights', (r.highlights || []).join('\n'), { rows: 5 }), { name: 'highlights', hint: 'One per line. Short, factual lines from her CV.' })),
    h('section', { class: 'form-block' },
      h('h2', {}, 'Samples'),
      checkboxGroup('sections', state.sections.map((s) => ({ value: s.slug, label: s.title })), r.sections || [], 'Draw samples from these sections'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Pinned samples'),
        h('p', { class: 'field-hint' }, 'Shown first, in this order. You can pin unlisted pieces too.'),
        pinList,
        h('div', { class: 'pin-add' }, pinSelect, h('button', { type: 'button', class: 'btn btn-small', onclick: () => { if (pinSelect.value) { pinned.push(pinSelect.value); dirty = true; paintPins(); } } }, 'Pin'))),
      cv.el,
      field('Order', input('order', r.order ?? '', { type: 'number', min: 1, max: 99, class: 'short' }), { name: 'order', hint: 'Order of the role buttons on the home page.' })),
    formActions(isNew ? 'Save role page' : 'Save changes', '#/roles'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const f = form.elements;
    const finalSlug = isNew ? slugify(slugInput.value || title.value) : r.slug;
    const errors = {};
    if (!title.value.trim()) errors.title = 'Enter the role.';
    if (isNew && !finalSlug) errors.slug = 'Enter a web address using letters and numbers.';
    else if (isNew && state.roles.some((x) => x.slug === finalSlug)) errors.slug = 'Another role page already uses that address.';
    if (cv.pending && !/\.pdf$/i.test(cv.pending.name)) errors.cv = 'The CV must be a PDF.';
    if (Object.keys(errors).length) { showErrors(form, errors); return; }
    const ok = await runSave(form, form.querySelector('[type=submit]'), async (progress) => {
      const changes = [];
      let cvPath = r.cv || '';
      const cvRepoPath = `/files/site/cv-${finalSlug}.pdf`;
      if (cv.pending) {
        progress('Uploading the CV…');
        changes.push(await upload(cv.pending, `public${cvRepoPath}`));
        if (cvPath && cvPath !== cvRepoPath) changes.push({ path: `public${cvPath}`, delete: true });
        cvPath = cvRepoPath;
      } else if (cv.removed && cvPath) {
        changes.push({ path: `public${cvPath}`, delete: true });
        cvPath = '';
      }
      progress('Saving…');
      const data = {
        title: title.value.trim(), order: f.order.value ? Number(f.order.value) : 99,
        sections: checkedValues(form, 'sections'), pinned: [...pinned], cv: cvPath, highlights: lines(f.highlights.value),
      };
      changes.push({ path: `content/focus/${finalSlug}.md`, content: serializeDoc(data, f.intro.value) });
      await commit(changes, `${isNew ? 'Add' : 'Edit'} role page: ${data.title}`);
      state.roles = state.roles.filter((x) => x.slug !== finalSlug).concat({ ...data, slug: finalSlug, intro: f.intro.value.trim() });
      sortAll();
    });
    if (ok) { toast(`Saved the ${title.value.trim()} page.`); go('#/roles'); }
  });

  const deleteAction = isNew ? null : async () => {
    if (!confirm(`Delete the ${r.title} page? Any CV that links to /for/${r.slug}/ will show "page not found" after you publish.`)) return;
    try {
      await commit([{ path: `content/focus/${r.slug}.md`, delete: true }, ...(r.cv ? [{ path: `public${r.cv}`, delete: true }] : [])], `Delete role page: ${r.title}`);
      state.roles = state.roles.filter((x) => x.slug !== r.slug);
      toast(`Deleted the ${r.title} page.`);
      go('#/roles');
    } catch (err) { formBanner(form, explain(err)); }
  };
  return editorShell(isNew ? 'Add a role page' : r.title, form, { backHash: '#/roles', backLabel: 'Role pages', deleteAction, viewUrl: isNew ? null : `/for/${r.slug}/` });
}

// ------------------------------------------------------------------ jobs ---

function jobsList() {
  return h('div', {},
    h('div', { class: 'list-head' }, h('h1', {}, 'Jobs'), h('a', { class: 'btn btn-primary', href: '#/jobs/new' }, 'Add a job')),
    h('p', { class: 'page-hint' }, 'Her experience, shown on the About page and role pages. Pieces pick a job so the company is always spelled the same way.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, ['Role', 'Company', 'Dates'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, state.jobs.map((j) => h('tr', {},
        h('td', {}, h('a', { class: 'row-title', href: `#/jobs/${j.slug}` }, j.title || j.slug)),
        h('td', {}, j.company || ''),
        h('td', { class: 'nowrap' }, `${shortDate(j.start)} – ${j.end ? shortDate(j.end) : 'present'}`)))))));
}

function jobEditor(slug) {
  const existing = slug ? state.jobs.find((j) => j.slug === slug) : null;
  if (slug && !existing) return notFound('job', '#/jobs', 'Back to jobs');
  const j = existing ? { ...existing } : { title: '', company: '', shortName: '', location: '', type: '', start: '', end: '', highlights: [], order: 99 };
  const isNew = !existing;
  const form = h('form', { class: 'form', 'data-editor': 'job', novalidate: true });
  form.append(
    h('div', { class: 'form-error', role: 'alert', hidden: true }),
    h('section', { class: 'form-block' },
      field('Job title', input('title', j.title), { required: true, name: 'title' }),
      field('Company', input('company', j.company), { required: true, name: 'company', hint: 'Full name, for example: Tripshepherd (See Sight Tours).' }),
      field('Short name', input('shortName', j.shortName), { name: 'shortName', hint: 'Used in lists of work, for example: Tripshepherd.' }),
      field('Location', input('location', j.location), { name: 'location', hint: 'For example: Singapore, or North America (remote).' }),
      field('Type', input('type', j.type, { list: 'job-types' }), { name: 'type' }),
      h('div', { class: 'two' },
        field('Started', input('start', j.start, { placeholder: 'YYYY-MM' }), { required: true, name: 'start' }),
        field('Ended', input('end', j.end, { placeholder: 'Leave empty if current' }), { name: 'end' })),
      field('Highlights', textarea('highlights', (j.highlights || []).join('\n'), { rows: 6 }), { name: 'highlights', hint: 'One per line, as on her CV.' })),
    datalist('job-types', ['Full-time', 'Part-time', 'Freelance', 'Contract', 'Editorial', 'Internship']),
    formActions(isNew ? 'Save job' : 'Save changes', '#/jobs'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const f = form.elements;
    const errors = {};
    if (!f.title.value.trim()) errors.title = 'Enter the job title.';
    if (!f.company.value.trim()) errors.company = 'Enter the company.';
    if (!DATE_RE.test(f.start.value.trim())) errors.start = 'Use YYYY-MM, for example 2022-10.';
    if (f.end.value.trim() && !DATE_RE.test(f.end.value.trim())) errors.end = 'Use YYYY-MM, or leave it empty if this is her current job.';
    const finalSlug = isNew ? slugify(f.shortName.value || f.company.value) : j.slug;
    if (isNew && !finalSlug) errors.company = 'Enter the company.';
    let unique = finalSlug;
    if (isNew) for (let n = 2; state.jobs.some((x) => x.slug === unique); n += 1) unique = `${finalSlug}-${n}`;
    if (Object.keys(errors).length) { showErrors(form, errors); return; }
    const data = {
      title: f.title.value.trim(), company: f.company.value.trim(), shortName: f.shortName.value.trim(),
      location: f.location.value.trim(), type: f.type.value.trim(), start: f.start.value.trim(), end: f.end.value.trim(),
      order: j.order ?? 99, highlights: lines(f.highlights.value),
    };
    const ok = await runSave(form, form.querySelector('[type=submit]'), async (progress) => {
      progress('Saving…');
      await commit([{ path: `content/jobs/${unique}.md`, content: serializeDoc(data) }], `${isNew ? 'Add' : 'Edit'} job: ${data.title}, ${data.company}`);
      state.jobs = state.jobs.filter((x) => x.slug !== unique).concat({ ...data, slug: unique });
      sortAll();
    });
    if (ok) { toast('Saved the job.'); go('#/jobs'); }
  });

  const deleteAction = isNew ? null : async () => {
    const using = state.pieces.filter((p) => p.job === j.slug);
    if (!confirm(`Delete ${j.title}, ${j.company}?${using.length ? ` ${using.length} ${using.length === 1 ? 'piece keeps' : 'pieces keep'} the company name.` : ''}`)) return;
    const changes = [{ path: `content/jobs/${j.slug}.md`, delete: true }];
    const updated = using.map((p) => ({ ...p, job: '', company: p.company || j.shortName || j.company, role: p.role || j.title }));
    for (const p of updated) { const { slug: ps, body, ...data } = p; changes.push({ path: `content/pieces/${ps}.md`, content: serializeDoc(data, body) }); }
    try {
      await commit(changes, `Delete job: ${j.title}, ${j.company}`);
      state.jobs = state.jobs.filter((x) => x.slug !== j.slug);
      for (const p of updated) state.pieces = state.pieces.map((x) => (x.slug === p.slug ? p : x));
      toast('Deleted the job.');
      go('#/jobs');
    } catch (err) { formBanner(form, explain(err)); }
  };
  return editorShell(isNew ? 'Add a job' : `${j.title}, ${j.shortName || j.company}`, form, { backHash: '#/jobs', backLabel: 'Jobs', deleteAction });
}

// --------------------------------------------------------------- profile ---

function profileEditor() {
  const s = state.settings;
  const form = h('form', { class: 'form', 'data-editor': 'profile', novalidate: true });
  const education = rows([{ key: 'degree', label: 'Degree', wide: true }, { key: 'school', label: 'School' }, { key: 'years', label: 'Years', placeholder: '2017–2019' }], s.education || [], 'Add education');
  const pubs = rows([{ key: 'title', label: 'Title', wide: true }, { key: 'venue', label: 'Journal' }, { key: 'date', label: 'Date', placeholder: 'Summer 2025' }, { key: 'url', label: 'Link', placeholder: 'https://', wide: true }], s.publications || [], 'Add a publication');
  const honours = rows([{ key: 'title', label: 'Honour', wide: true }, { key: 'year', label: 'Year' }], s.honours || [], 'Add an honour');
  const photo = fileSlot('photo', s.photo, 'image/jpeg,image/png,image/webp', 'Photo (optional, JPG, PNG or WebP)');
  const cv = fileSlot('cv', s.cv, '.pdf,application/pdf', 'General CV (PDF)');

  form.append(
    h('div', { class: 'form-error', role: 'alert', hidden: true }),
    h('section', { class: 'form-block' },
      h('h2', {}, 'Home page'),
      field('Name', input('name', s.name), { required: true, name: 'name' }),
      field('Headline', input('headline', s.headline), { name: 'headline', hint: 'Under her name, for example: Content writer and copywriter.' }),
      field('Introduction', textarea('intro', s.intro, { rows: 5 }), { name: 'intro', hint: 'The paragraph on the home page.' }),
      field('Results', textarea('results', (s.results || []).join('\n'), { rows: 4 }), { name: 'results', hint: 'One per line. Only numbers she can explain in an interview.' })),
    h('section', { class: 'form-block' },
      h('h2', {}, 'Contact'),
      field('Email', input('email', s.email, { type: 'email' }), { name: 'email' }),
      field('LinkedIn', input('linkedin', s.linkedin, { type: 'url', placeholder: 'https://www.linkedin.com/in/…' }), { name: 'linkedin' }),
      field('Location line', input('location', s.location), { name: 'location', hint: 'For example: Based in Pakistan (PKT, UTC+5). Open to remote roles.' }),
      cv.el, photo.el),
    h('section', { class: 'form-block' },
      h('h2', {}, 'About page'),
      field('About', textarea('about', s.about, { rows: 12 }), { name: 'about', hint: 'Markdown works. Leave a blank line between paragraphs.' }),
      field('Skills and tools', input('skills', (s.skills || []).join(', ')), { name: 'skills', hint: 'Separate with commas.' }),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Education'), education.el)),
    h('section', { class: 'form-block' },
      h('h2', {}, 'Poetry'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Selected publications'), pubs.el),
      field('Also published in', textarea('alsoPublishedIn', s.alsoPublishedIn, { rows: 3 }), { name: 'alsoPublishedIn' }),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Honours'), honours.el),
      field('Note', input('poetryNote', s.poetryNote), { name: 'poetryNote', hint: 'For example: Working on two poetry manuscripts and a novel.' })),
    formActions('Save profile', '#/pieces'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const f = form.elements;
    const errors = {};
    if (!f.name.value.trim()) errors.name = 'Enter her name.';
    if (f.email.value.trim() && !/^\S+@\S+\.\S+$/.test(f.email.value.trim())) errors.email = 'Enter an email address like name@example.com.';
    if (f.linkedin.value.trim() && !/^https:\/\/\S+$/.test(f.linkedin.value.trim())) errors.linkedin = 'Enter the full link, starting with https://';
    if (photo.pending && photo.pending.size > 5 * 1024 * 1024) errors.photo = 'The photo must be 5 MB or smaller.';
    if (photo.pending && !/\.(jpe?g|png|webp)$/i.test(photo.pending.name)) errors.photo = 'Use a JPG, PNG or WebP photo.';
    if (cv.pending && !/\.pdf$/i.test(cv.pending.name)) errors.cv = 'The CV must be a PDF.';
    if (Object.keys(errors).length) { showErrors(form, errors); return; }
    const ok = await runSave(form, form.querySelector('[type=submit]'), async (progress) => {
      const changes = [];
      let photoPath = s.photo || '';
      let cvPath = s.cv || '';
      if (photo.pending) {
        progress('Uploading the photo…');
        const ext = photo.pending.name.split('.').pop().toLowerCase().replace('jpeg', 'jpg');
        const next = `/files/site/photo.${ext}`;
        changes.push(await upload(photo.pending, `public${next}`));
        if (photoPath && photoPath !== next) changes.push({ path: `public${photoPath}`, delete: true });
        photoPath = next;
      } else if (photo.removed && photoPath) { changes.push({ path: `public${photoPath}`, delete: true }); photoPath = ''; }
      if (cv.pending) {
        progress('Uploading the CV…');
        changes.push(await upload(cv.pending, 'public/files/site/cv.pdf'));
        cvPath = '/files/site/cv.pdf';
      } else if (cv.removed && cvPath) { changes.push({ path: `public${cvPath}`, delete: true }); cvPath = ''; }
      progress('Saving…');
      const data = {
        name: f.name.value.trim(), headline: f.headline.value.trim(), intro: f.intro.value.trim(), results: lines(f.results.value),
        about: f.about.value.trim(), location: f.location.value.trim(), email: f.email.value.trim(), linkedin: f.linkedin.value.trim(),
        photo: photoPath, cv: cvPath, skills: f.skills.value.split(',').map((x) => x.trim()).filter(Boolean),
        education: education.value(), publications: pubs.value(), alsoPublishedIn: f.alsoPublishedIn.value.trim(),
        honours: honours.value(), poetryNote: f.poetryNote.value.trim(),
      };
      changes.push({ path: 'content/settings.yml', content: `${serializeFields(data)}\n` });
      await commit(changes, 'Edit profile');
      state.settings = data;
    });
    if (ok) { toast('Saved the profile. Publish to put it on the site.'); route(); }
  });

  return h('div', { class: 'editor' }, h('div', { class: 'editor-head' }, h('h1', {}, 'Profile')),
    h('p', { class: 'page-hint' }, 'Her name, introduction, contact details, About page and poetry credits.'), form);
}

function notFound(what, backHash, backLabel) {
  return h('div', { class: 'notice' }, h('h1', {}, `That ${what} doesn't exist`),
    h('p', {}, 'It may have been deleted or renamed.'), h('p', {}, h('a', { href: backHash }, backLabel)));
}

start();
