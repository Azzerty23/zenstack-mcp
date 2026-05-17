/**
 * Built-in login page script — reads OAuth params from URLSearchParams, submits via fetch.
 *
 * Export this string to inject the login logic into a custom HTML page:
 * @example
 * import { loginScript } from 'zenstack-mcp'
 * const html = `<html>...<script>${loginScript}</script></html>`
 *
 * The HTML must expose these element IDs:
 *   - login-form       — the <form> element
 *   - email            — the email <input>
 *   - password         — the password <input>
 *   - login-button     — the submit <button>
 *   - error-container  — the error message container (hidden by default)
 */
export const loginScript = `(function () {
  var params = new URLSearchParams(window.location.search);
  var errorEl = document.getElementById('error-container');
  var form = document.getElementById('login-form');

  /* Exposed globally for onclick="fillDemo(...)" buttons */
  window.fillDemo = function (email, password) {
    document.getElementById('email').value = email;
    document.getElementById('password').value = password;
    if (form) form.requestSubmit();
  };

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.style.display = '';
  }

  var required = ['client_id', 'code_challenge', 'redirect_uri'];
  var missing = required.filter(function (p) { return !params.get(p); });

  if (missing.length > 0) {
    if (form) form.style.display = 'none';
    showError('Missing required parameters: ' + missing.join(', '));
    return;
  }

  if (!form) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = document.getElementById('login-button');
    if (btn) btn.disabled = true;
    if (errorEl) errorEl.style.display = 'none';

    try {
      var body = Object.fromEntries(params.entries());
      body.email = document.getElementById('email').value;
      body.password = document.getElementById('password').value;

      var res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await res.json();

      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else {
        showError(data.error || 'Invalid credentials');
        if (btn) btn.disabled = false;
      }
    } catch (err) {
      showError('An unexpected error occurred. Please try again.');
      if (btn) btn.disabled = false;
    }
  });
})();`
