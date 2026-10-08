// Section page filters: topic chips and selects (place, type, company, year), plus "show more" for long lists.
(() => {
  const form = document.querySelector('[data-filters]');
  const list = document.getElementById('list');
  if (!form || !list) return;
  const rows = [...list.querySelectorAll('.entry')];
  const count = form.querySelector('[data-count]');
  const empty = document.querySelector('[data-empty]');
  const more = document.querySelector('[data-more]');
  const chips = [...form.querySelectorAll('[data-topic]')];
  const selects = [...form.querySelectorAll('select')];
  const LIMIT = 14;
  const params = new URLSearchParams(location.search);
  let topic = params.get('topic') || '';
  let expanded = false;

  if (!chips.some((c) => c.dataset.topic === topic)) topic = '';
  for (const select of selects) {
    const wanted = params.get(select.name);
    if (wanted && [...select.options].some((o) => o.value === wanted)) select.value = wanted;
  }

  function apply() {
    const chosen = {};
    for (const select of selects) if (select.value) chosen[select.name] = select.value;
    const filtering = Boolean(topic) || Object.keys(chosen).length > 0;
    let matched = 0;
    let shown = 0;
    for (const row of rows) {
      const topics = (row.dataset.topics || '').split('|');
      const match = (!topic || topics.includes(topic)) && Object.entries(chosen).every(([key, value]) => row.dataset[key] === value);
      if (match) matched += 1;
      const visible = match && (filtering || expanded || shown < LIMIT);
      if (visible) shown += 1;
      row.hidden = !visible;
    }
    for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.topic === topic));
    count.textContent = `${matched} ${matched === 1 ? 'piece' : 'pieces'}`;
    empty.hidden = matched !== 0;
    if (more) {
      const hiddenCount = rows.length - LIMIT;
      more.hidden = filtering || expanded || hiddenCount <= 0;
      more.textContent = `Show ${hiddenCount} more`;
    }
    const url = new URL(location.href);
    if (topic) url.searchParams.set('topic', topic); else url.searchParams.delete('topic');
    for (const select of selects) {
      if (select.value) url.searchParams.set(select.name, select.value);
      else url.searchParams.delete(select.name);
    }
    history.replaceState(null, '', url);
  }

  for (const chip of chips) chip.addEventListener('click', () => { topic = chip.dataset.topic; apply(); });
  form.addEventListener('change', apply);
  form.addEventListener('submit', (e) => e.preventDefault());
  if (more) more.addEventListener('click', () => { expanded = true; apply(); });
  apply();
})();
