const $ = (selector) => document.querySelector(selector);
const status = (message, error = false, target = $('#account-status')) => { target.textContent = message; target.classList.toggle('error', error); };
async function request(path, body) {
  const response = await fetch(`/api/customer/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'We could not complete that request. Please try again.');
  return data;
}
function showAccount(data) {
  $('#auth-panel').hidden = true;
  $('#signed-in-panel').hidden = false;
  $('#customer-name').textContent = data.user.name;
  $('#customer-email').textContent = data.user.email;
  status('', false, $('#signed-in-status'));
}
function showForm(mode) {
  const register = mode === 'register';
  $('#login-panel').hidden = register;
  $('#register-panel').hidden = !register;
  $('#tab-login').classList.toggle('active', !register);
  $('#tab-register').classList.toggle('active', register);
  $('#tab-login').setAttribute('aria-selected', String(!register));
  $('#tab-register').setAttribute('aria-selected', String(register));
  $('#account-title').textContent = register ? 'Make yourself at home.' : 'Welcome back.';
  $('#account-copy').textContent = register ? 'Create an APRIA account for a smoother checkout next time.' : 'Sign in to keep your name and email ready for checkout.';
  status('');
}
$('#tab-login').addEventListener('click', () => showForm('login'));
$('#tab-register').addEventListener('click', () => showForm('register'));
$('#login-panel').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]'); button.disabled = true; status('Signing you in…');
  try { showAccount(await request('login', Object.fromEntries(new FormData(form)))); }
  catch (error) { status(error.message, true); }
  finally { button.disabled = false; }
});
$('#register-panel').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]'); button.disabled = true; status('Creating your account…');
  try { showAccount(await request('register', Object.fromEntries(new FormData(form)))); }
  catch (error) { status(error.message, true); }
  finally { button.disabled = false; }
});
$('#sign-out').addEventListener('click', async () => {
  const button = $('#sign-out'); button.disabled = true; status('Signing you out…', false, $('#signed-in-status'));
  try { await request('logout', {}); $('#signed-in-panel').hidden = true; $('#auth-panel').hidden = false; showForm('login'); status('You’ve signed out. See you next time.'); }
  catch (error) { status(error.message, true, $('#signed-in-status')); }
  finally { button.disabled = false; }
});
request('session').then((data) => { if (data.authenticated) showAccount(data); }).catch(() => status('Your account status could not be reached. Please refresh and try again.', true));
