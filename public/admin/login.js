const form = document.getElementById('login');
const errorBox = document.getElementById('error');
const savedName = localStorage.getItem('admin-name');
if (savedName) form.elements.name.value = savedName;

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
