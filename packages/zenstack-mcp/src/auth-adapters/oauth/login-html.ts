export const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in — ZenStack MCP</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f4f4f5;
      padding: 1rem;
    }

    .wrapper {
      width: 100%;
      max-width: 360px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: center;
      margin-bottom: 1.75rem;
    }

    .brand-icon {
      width: 28px;
      height: 28px;
      background: #18181b;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .brand-icon svg {
      width: 16px;
      height: 16px;
      stroke: white;
      fill: none;
    }

    .brand-name {
      font-size: 1rem;
      font-weight: 600;
      color: #18181b;
      letter-spacing: -0.015em;
    }

    .card {
      background: white;
      border: 1px solid #e4e4e7;
      border-radius: 12px;
      padding: 2rem;
      box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.04);
    }

    .card-header {
      margin-bottom: 1.5rem;
    }

    .card-header h1 {
      font-size: 1.125rem;
      font-weight: 600;
      color: #18181b;
      letter-spacing: -0.02em;
    }

    .card-header p {
      font-size: 0.8125rem;
      color: #71717a;
      margin-top: 3px;
    }

    .field {
      margin-bottom: 0.875rem;
    }

    label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      color: #3f3f46;
      margin-bottom: 5px;
    }

    input[type="email"],
    input[type="password"] {
      width: 100%;
      padding: 9px 11px;
      background: white;
      border: 1px solid #d4d4d8;
      border-radius: 7px;
      font-size: 0.9375rem;
      color: #18181b;
      outline: none;
      transition: border-color .12s, box-shadow .12s;
    }

    input[type="email"]:focus,
    input[type="password"]:focus {
      border-color: #a1a1aa;
      box-shadow: 0 0 0 3px rgba(0,0,0,.06);
    }

    input::placeholder { color: #a1a1aa; }

    button[type="submit"] {
      width: 100%;
      padding: 10px;
      margin-top: 0.375rem;
      background: #18181b;
      color: white;
      border: none;
      border-radius: 7px;
      font-size: 0.9375rem;
      font-weight: 500;
      cursor: pointer;
      transition: background .12s;
    }

    button[type="submit"]:hover:not(:disabled) { background: #27272a; }
    button[type="submit"]:active:not(:disabled) { background: #3f3f46; }
    button[type="submit"]:disabled { opacity: 0.6; cursor: not-allowed; }

    .error {
      display: none;
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 6px;
      padding: 9px 11px;
      color: #b91c1c;
      font-size: 0.8125rem;
      margin-bottom: 0.875rem;
    }

    .card-footer {
      margin-top: 1.25rem;
      padding-top: 1.125rem;
      border-top: 1px solid #f4f4f5;
      text-align: center;
      font-size: 0.75rem;
      color: #a1a1aa;
    }

    .card-footer a {
      color: #71717a;
      text-decoration: none;
    }

    .card-footer a:hover { text-decoration: underline; }

  </style>
</head>
<body>
  <div class="wrapper">
    <div class="brand">
      <div class="brand-icon">
        <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
      </div>
      <span class="brand-name">ZenStack</span>
    </div>

    <div class="card">
      <div class="card-header">
        <h1>Sign in</h1>
        <p>Sign in to continue</p>
      </div>

      <form id="login-form">
        <div id="error-container" class="error"></div>

        <div class="field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required />
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" placeholder="••••••••" autocomplete="current-password" required />
        </div>

        <button type="submit" id="login-button">Sign in</button>
      </form>

      <div class="card-footer">
        Secured by <a href="https://zenstack.dev" target="_blank" rel="noopener">ZenStack MCP</a>
      </div>
    </div>
  </div>
</body>
</html>`
