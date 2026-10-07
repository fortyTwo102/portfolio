const form = document.getElementById('login');
const errorBox = document.getElementById('error');
let savedName = '';
try { savedName = localStorage.getItem('admin-name') || ''; } catch { /* private browsing */ }
if (savedName) form.elements.name.value = savedName;

// Say plainly if the site's settings aren't finished, instead of failing at login.
fetch('/api/status', { cache: 'no-store' }).then((r) => r.json()).then((status) => {
  if (status.ready) return;
  const notes = [];
  if (status.missing && status.missing.length) notes.push(`Cloudflare is missing these settings: ${status.missing.join(', ')}.`);
  if (status.github === 'rejected') notes.push('GitHub rejected the key in GITHUB_TOKEN. It may have expired or been deleted.');
  if (status.github === 'no access' || status.github === 'read-only') notes.push('The GitHub key in GITHUB_TOKEN can’t save to the portfolio repository. It needs that repository with “Contents: Read and write”.');
  if (status.github === 'unreachable') notes.push('GitHub didn’t respond. Try again in a few minutes.');
  if (!notes.length) return;
  const box = document.getElementById('setup');
  box.textContent = `The admin view isn’t ready yet. ${notes.join(' ')} After changing settings in Cloudflare, deploy the site again.`;
  box.hidden = false;
}).catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  const name = form.elements.name.value.trim();
  if (!username || !password) {
    errorBox.textContent = 'Enter the username and password.';
    errorBox.hidden = false;
    return;
  }
  const button = form.querySelector('button');
  button.disabled = true;
  button.textContent = 'Logging in…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'admin' },
      body: JSON.stringify({ username, password, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Logging in failed. Try again.');
    try { localStorage.setItem('admin-name', name); } catch { /* private browsing */ }
    location.href = '/admin/';
  } catch (err) {
    errorBox.textContent = err.message === 'Failed to fetch' ? "Couldn't reach the site. Check your connection and try again." : err.message;
    errorBox.hidden = false;
    button.disabled = false;
    button.textContent = 'Log in';
  }
});
