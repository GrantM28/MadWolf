const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
};

const app = document.querySelector('#app');

async function api(path, opts={}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers||{}) },
    credentials: 'include',
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || res.statusText);
  }
  return res.json();
}

function renderShell(inner) {
  app.innerHTML = '';
  const root = el(`
    <div class="container">
      <div class="header">
        <div class="brand">
          <div class="logo"></div>
          <div>
            <h1>MadWolf</h1>
            <div class="sub">Your self-hosted streaming server (MVP)</div>
          </div>
        </div>
        <div class="toolbar" id="top-actions"></div>
      </div>
      ${inner}
    </div>
  `);
  app.appendChild(root);
  return root;
}

async function boot() {
  const st = await api('/api/setup/status');
  if (st.needsSetup) return renderSetup(st.mediaRoot);
  return renderLogin(st.mediaRoot);
}

function renderSetup(mediaRoot) {
  const root = renderShell(`
    <div class="card">
      <h2 style="margin:0 0 6px;font-size:16px;">First run setup</h2>
      <div class="notice">Media root inside the container: <span class="code">${mediaRoot}</span></div>

      <div class="row" style="margin-top:10px;">
        <div class="col">
          <label>Admin username</label>
          <input id="u" placeholder="admin" />
        </div>
        <div class="col">
          <label>Admin password</label>
          <input id="p" type="password" placeholder="min 8 chars" />
        </div>
      </div>

      <div style="margin-top:14px;display:flex;gap:10px;">
        <button class="btn" id="go">Create admin</button>
      </div>

      <div class="notice" style="margin-top:14px;">
        Important: the container can only see folders you mount into it. On Unraid you’ll map something like
        <span class="code">/mnt/user/media</span> → <span class="code">${mediaRoot}</span>.
      </div>
    </div>
  `);

  root.querySelector('#go').onclick = async () => {
    const username = root.querySelector('#u').value.trim();
    const password = root.querySelector('#p').value;
    try {
      await api('/api/setup/init', { method:'POST', body: JSON.stringify({ username, password }) });
      await boot();
    } catch (e) {
      alert(`Setup failed: ${e.message}`);
    }
  };
}

function renderLogin(mediaRoot) {
  const root = renderShell(`
    <div class="card">
      <h2 style="margin:0 0 6px;font-size:16px;">Sign in</h2>
      <div class="notice">Media root: <span class="code">${mediaRoot}</span></div>

      <div class="row" style="margin-top:10px;">
        <div class="col">
          <label>Username</label>
          <input id="u" placeholder="admin" />
        </div>
        <div class="col">
          <label>Password</label>
          <input id="p" type="password" placeholder="••••••••" />
        </div>
      </div>

      <div style="margin-top:14px;display:flex;gap:10px;">
        <button class="btn" id="go">Login</button>
      </div>
    </div>
  `);

  root.querySelector('#go').onclick = async () => {
    const username = root.querySelector('#u').value.trim();
    const password = root.querySelector('#p').value;
    try {
      await api('/api/auth/login', { method:'POST', body: JSON.stringify({ username, password }) });
      await renderApp();
    } catch (e) {
      alert(`Login failed: ${e.message}`);
    }
  };
}

async function renderApp() {
  const shell = renderShell(`
    <div class="card">
      <div class="toolbar" style="justify-content:space-between;">
        <div class="toolbar" style="gap:10px;">
          <button class="btn" id="addLib">Add library</button>
          <button class="btn" id="refresh">Refresh list</button>
        </div>
        <button class="btn danger" id="logout">Logout</button>
      </div>

      <div id="libs" class="notice" style="margin-top:12px;"></div>

      <div class="row" style="margin-top:12px;">
        <div class="col">
          <label>Search</label>
          <input id="q" placeholder="Type to filter..." />
        </div>
      </div>

      <div id="grid" class="grid"></div>

      <div id="playerWrap" style="display:none;">
        <div class="player">
          <video id="player" controls></video>
        </div>
        <div class="notice" id="rows"></div>
      </div>
    </div>
  `);

  const top = shell.querySelector('#top-actions');
  top.innerHTML = '';

  shell.querySelector('#logout').onclick = async () => {
    await api('/api/auth/logout', { method:'POST' });
    await boot();
  };

  const libsEl = shell.querySelector('#libs');
  const gridEl = shell.querySelector('#grid');
  const qEl = shell.querySelector('#q');
  const playerWrap = shell.querySelector('#playerWrap');
  const player = shell.querySelector('#player');
  const rows = shell.querySelector('#rows');

  let currentLibId = null;
  let items = [];

  async function loadLibs() {
    const data = await api('/api/libraries');
    if (!data.libraries.length) {
      libsEl.innerHTML = `No libraries yet. Add one. Media root: <span class="code">${data.mediaRoot}</span>`;
      currentLibId = null;
      return;
    }
    currentLibId = data.libraries[0].id;
    libsEl.innerHTML = `
      Libraries:
      ${data.libraries.map(l => `<span class="code" style="margin-right:8px;cursor:pointer" data-id="${l.id}">${l.name}</span>`).join('')}
      <div class="notice">Click a library name to switch. After adding one, hit scan.</div>
    `;
    libsEl.querySelectorAll('[data-id]').forEach(x => {
      x.onclick = async () => {
        currentLibId = parseInt(x.getAttribute('data-id'), 10);
        await loadItems();
      };
    });
  }

  function renderItems() {
    const q = qEl.value.trim().toLowerCase();
    const filtered = q ? items.filter(i => i.title.toLowerCase().includes(q)) : items;

    gridEl.innerHTML = filtered.map(i => `
      <div class="tile" data-id="${i.id}">
        <div class="title">${i.title}</div>
        <div class="meta">${i.ext} • ${(i.size_bytes/1024/1024/1024).toFixed(2)} GB</div>
      </div>
    `).join('');

    gridEl.querySelectorAll('.tile').forEach(t => {
      t.onclick = async () => {
        const id = parseInt(t.getAttribute('data-id'), 10);
        await play(id);
      };
    });
  }

  async function loadItems() {
    if (!currentLibId) return;
    const data = await api(`/api/items?library_id=${currentLibId}&limit=200`);
    items = data.items;
    renderItems();
  }

  async function play(itemId) {
    playerWrap.style.display = 'block';
    player.src = `/api/items/${itemId}/file`;
    player.play().catch(()=>{});

    // Save progress periodically
    const tick = async () => {
      if (player.duration && !Number.isNaN(player.duration)) {
        await api(`/api/items/${itemId}/progress`, {
          method:'POST',
          body: JSON.stringify({
            position_seconds: Math.floor(player.currentTime || 0),
            duration_seconds: Math.floor(player.duration || 0),
          })
        }).catch(()=>{});
      }
    };
    clearInterval(window.__sbTick);
    window.__sbTick = setInterval(tick, 8000);

    // “Because you watched” row (MVP logic now, ML later)
    const because = await api(`/api/rows/because-you-watched?item_id=${itemId}`).catch(()=>({items:[]}));
    rows.innerHTML = `
      <div style="margin-top:10px;">
        <div style="font-weight:700;margin-bottom:6px;">Because you watched this</div>
        <div class="grid">
          ${(because.items||[]).slice(0,8).map(i => `
            <div class="tile" data-id="${i.id}">
              <div class="title">${i.title}</div>
              <div class="meta">${i.ext}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    rows.querySelectorAll('.tile').forEach(t => {
      t.onclick = async () => {
        const id = parseInt(t.getAttribute('data-id'), 10);
        await play(id);
      };
    });
  }

  shell.querySelector('#addLib').onclick = async () => {
    const data = await api('/api/libraries');
    const mr = data.mediaRoot;

    const name = prompt('Library name (e.g. Movies):', 'Movies');
    if (!name) return;
    const path = prompt(`Path inside container (must be under ${mr}):`, `${mr}/Movies`);
    if (!path) return;

    try {
      await api('/api/libraries', { method:'POST', body: JSON.stringify({ name, path }) });
      await loadLibs();
      alert('Library added. Now click Refresh, then scan it from the Unraid console via API (next step).');
    } catch (e) {
      alert(`Add library failed: ${e.message}`);
    }
  };

  shell.querySelector('#refresh').onclick = async () => {
    await loadLibs();
    await loadItems();
  };

  qEl.oninput = renderItems;

  await loadLibs();
  await loadItems();

  // show quick scan instructions in UI (simple on purpose)
  libsEl.insertAdjacentHTML('beforeend', `
    <div class="notice" style="margin-top:10px;">
      To scan a library: call <span class="code">POST /api/libraries/&lt;id&gt;/scan</span>.
      (We’ll add a UI scan button next.)
    </div>
  `);
}

boot().catch(e => {
  renderShell(`<div class="card">Boot error: <span class="code">${String(e.message||e)}</span></div>`);
});
