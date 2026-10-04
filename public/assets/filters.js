// Section page filters: hide catalogue rows that don't match the chosen company, type or year.
(() => {
  const form = document.querySelector('[data-filters]');
  const list = document.getElementById('list');
  if (!form || !list) return;
  const rows = [...list.querySelectorAll('.entry')];
  const count = form.querySelector('[data-count]');
  const empty = document.querySelector('[data-empty]');
  const params = new URLSearchParams(location.search);

  for (const select of form.querySelectorAll('select')) {
    const wanted = params.get(select.name);
    if (wanted && [...select.options].some((o) => o.value === wanted)) select.value = wanted;
  }

  function apply() {
    const chosen = {};
    for (const select of form.querySelectorAll('select')) if (select.value) chosen[select.name] = select.value;
    let shown = 0;
    for (const row of rows) {
      const match = Object.entries(chosen).every(([key, value]) => row.dataset[key] === value);
      row.hidden = !match;
      if (match) shown += 1;
    }
    count.textContent = `${shown} ${shown === 1 ? 'piece' : 'pieces'}`;
    empty.hidden = shown !== 0;
    const url = new URL(location.href);
    for (const select of form.querySelectorAll('select')) {
      if (select.value) url.searchParams.set(select.name, select.value);
      else url.searchParams.delete(select.name);
    }
    history.replaceState(null, '', url);
  }

  form.addEventListener('change', apply);
  form.addEventListener('submit', (e) => e.preventDefault());
  apply();
})();
