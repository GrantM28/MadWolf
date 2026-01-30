// Stupid-simple UI:
// setup admin -> login -> add libraries -> scan -> click title to play
// Also: on refresh, if cookie is still valid, it auto-enters the app.

const app = document.querySelector("#app");

const state = {
  mediaRoot: "",
  libraries: [],
  folders: [],
  currentLibId: null,
  items: [],
  pollTimer: null,
};

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setView(html) {
  app.innerHTML = `
    <div class="wrap">
      <div class="panel">
        ${html}
      </div>
    </div>
  `;
  return app.querySelector(".panel");
}

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  // Only force JSON header if we're sending a body
  if (opts.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, {
    ...opts,
    headers,
    credentials: "include",
  });

  if (!res.ok) {
    // Try to pull a useful error message
    let msg = res.statusText || "Request failed";
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await res.json();
        msg = j?.detail || j?.message || JSON.stringify(j);
      } else {
        const t = await res.text();
        if (t) msg = t;
      }
    } catch (_) {}
    throw new Error(msg);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function boot() {
  stopPolling();

  let st;
  try {
    st = await api("/api/setup/status");
  } catch (e) {
    setView(`
      <div class="card">
        <div class="h1">Server not reachable</div>
        <div class="muted">Error: <span class="code">${esc(e.message)}</span></div>
      </div>
    `);
    return;
  }

  state.mediaRoot = st.mediaRoot || state.mediaRoot;

  if (st.needsSetup) {
    renderSetup();
    return;
  }

  // If setup is done, try to enter using existing cookie.
  // /api/libraries is protected; if it works, you're logged in.
  try {
    await api("/api/libraries");
    await renderApp();
  } catch (_) {
    renderLogin();
  }
}

function renderSetup() {
  const root = setView(`
    <div class="card">
      <div class="topline">
        <div class="h1">First run setup</div>
      </div>
      <div class="muted">Media root inside container: <span class="code">${esc(state.mediaRoot)}</span></div>

      <div class="form" style="margin-top:14px;">
        <div class="field">
          <label>Admin username</label>
          <input id="u" placeholder="admin" autocomplete="username" />
        </div>
        <div class="field">
          <label>Admin password</label>
          <input id="p" type="password" placeholder="min 8 chars" autocomplete="new-password" />
        </div>
      </div>

      <div class="row" style="margin-top:14px;">
        <button class="btn" id="go">Create admin</button>
        <div class="status" id="s"></div>
      </div>

      <div class="muted" style="margin-top:12px;">
        Reminder: the container can only see what you mount. Example:
        <span class="code">-v /mnt/user/media:${esc(state.mediaRoot)}</span>
      </div>
    </div>
  `);

  const s = root.querySelector("#s");
  const setStatus = (m, kind = "") => {
    s.className = `status ${kind}`;
    s.textContent = m || "";
  };

  root.querySelector("#go").onclick = async () => {
    const username = root.querySelector("#u").value.trim();
    const password = root.querySelector("#p").value;

    setStatus("Creating admin…");
    try {
      await api("/api/setup/init", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setStatus("Admin created. Loading…", "ok");
      await boot();
    } catch (e) {
      setStatus(`Setup failed: ${e.message}`, "err");
    }
  };
}

function renderLogin() {
  const root = setView(`
    <div class="card">
      <div class="topline">
        <div class="h1">Sign in</div>
      </div>
      <div class="muted">Media root: <span class="code">${esc(state.mediaRoot)}</span></div>

      <div class="form" style="margin-top:14px;">
        <div class="field">
          <label>Username</label>
          <input id="u" placeholder="admin" autocomplete="username" />
        </div>
        <div class="field">
          <label>Password</label>
          <input id="p" type="password" placeholder="••••••••" autocomplete="current-password" />
        </div>
      </div>

      <div class="row" style="margin-top:14px;">
        <button class="btn" id="go">Login</button>
        <div class="status" id="s"></div>
      </div>
    </div>
  `);

  const s = root.querySelector("#s");
  const setStatus = (m, kind = "") => {
    s.className = `status ${kind}`;
    s.textContent = m || "";
  };

  const doLogin = async () => {
    const username = root.querySelector("#u").value.trim();
    const password = root.querySelector("#p").value;

    setStatus("Logging in…");
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setStatus("Logged in.", "ok");
      await renderApp();
    } catch (e) {
      setStatus(`Login failed: ${e.message}`, "err");
    }
  };

  root.querySelector("#go").onclick = doLogin;
  root.querySelector("#p").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
}

async function loadLibraries() {
  const data = await api("/api/libraries");
  state.mediaRoot = data.mediaRoot || state.mediaRoot;
  state.libraries = Array.isArray(data.libraries) ? data.libraries : [];

  if (state.currentLibId && !state.libraries.some((l) => l.id === state.currentLibId)) {
    state.currentLibId = null;
  }
  if (!state.currentLibId && state.libraries.length) {
    state.currentLibId = state.libraries[0].id;
  }
}

async function loadFolders() {
  // depth=1 keeps it “main folders only”
  const data = await api("/api/libraries/discover?depth=1");
  state.folders = Array.isArray(data.folders) ? data.folders : [];
}

async function loadItems() {
  state.items = [];
  if (!state.currentLibId) return;

  const data = await api(`/api/items?library_id=${encodeURIComponent(state.currentLibId)}&limit=500&offset=0`);
  state.items = Array.isArray(data.items) ? data.items : [];
}

async function renderApp() {
  stopPolling();

  // Load state
  await Promise.all([loadLibraries(), loadFolders()]);
  await loadItems();

  const root = setView(`
    <div class="card">
      <div class="topbar">
        <div>
          <div class="h1">Libraries</div>
          <div class="muted">Media root: <span class="code">${esc(state.mediaRoot)}</span></div>
        </div>
        <div class="topbar-actions">
          <button class="btn ghost" id="refresh">Refresh</button>
          <button class="btn danger" id="logout">Logout</button>
        </div>
      </div>

      <div class="row" style="margin-top:14px;">
        <div class="field grow">
          <label>Current library</label>
          <select id="libSelect"></select>
        </div>
        <button class="btn" id="scanBtn" ${state.currentLibId ? "" : "disabled"}>Scan</button>
        <div class="status grow" id="status"></div>
      </div>

      <div class="divider"></div>

      <div class="h2">Add library</div>
      <div class="row">
        <div class="field grow">
          <label>Name</label>
          <input id="newName" placeholder="Movies" />
        </div>
        <div class="field grow">
          <label>Folder</label>
          <select id="folderSelect"></select>
        </div>
        <button class="btn" id="addBtn">Add</button>
      </div>
      <div class="muted" style="margin-top:8px;">
        Tip: folder dropdown comes from <span class="code">/api/libraries/discover</span>.
      </div>
    </div>

    <div class="card">
      <div class="topline">
        <div class="h1">Titles</div>
        <div class="muted" id="countLine"></div>
      </div>
      <div class="list" id="items"></div>
    </div>

    <div class="card" id="playerCard" style="display:none;">
      <div class="muted">Now playing</div>
      <div class="now" id="nowTitle"></div>
      <video id="player" controls playsinline></video>
    </div>
  `);

  const status = root.querySelector("#status");
  const setStatus = (m, kind = "") => {
    status.className = `status ${kind}`;
    status.textContent = m || "";
  };

  // Populate library select
  const libSelect = root.querySelector("#libSelect");
  libSelect.innerHTML = state.libraries.length
    ? state.libraries
        .map(
          (l) =>
            `<option value="${l.id}" ${l.id === state.currentLibId ? "selected" : ""}>${esc(l.name)} — ${esc(l.path)}</option>`
        )
        .join("")
    : `<option value="">(no libraries yet)</option>`;

  libSelect.onchange = async () => {
    state.currentLibId = libSelect.value ? parseInt(libSelect.value, 10) : null;
    setStatus("Loading…");
    try {
      await loadItems();
      renderItems();
      setStatus("");
    } catch (e) {
      setStatus(e.message, "err");
    }
  };

  // Populate folders
  const folderSelect = root.querySelector("#folderSelect");
  folderSelect.innerHTML = state.folders.length
    ? state.folders.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("")
    : `<option value="">(no folders discovered)</option>`;

  // Add library
  root.querySelector("#addBtn").onclick = async () => {
    const name = root.querySelector("#newName").value.trim();
    const path = folderSelect.value;

    if (!name) return setStatus("Name is required.", "err");
    if (!path) return setStatus("No folder selected.", "err");

    setStatus("Creating library…");
    try {
      const res = await api("/api/libraries", {
        method: "POST",
        body: JSON.stringify({ name, path }),
      });

      // Prefer returned library id if present
      if (res?.library?.id) state.currentLibId = res.library.id;

      await renderApp();
    } catch (e) {
      setStatus(`Add failed: ${e.message}`, "err");
    }
  };

  // Scan
  root.querySelector("#scanBtn").onclick = async () => {
    if (!state.currentLibId) return;

    setStatus("Scan queued…", "ok");
    try {
      await api(`/api/libraries/${state.currentLibId}/scan`, { method: "POST" });
    } catch (e) {
      setStatus(`Scan failed: ${e.message}`, "err");
      return;
    }

    // Poll items so the page updates without refresh
    const startCount = state.items.length;
    let ticks = 0;

    const poll = async () => {
      ticks++;
      try {
        await loadItems();
        renderItems();
        const changed = state.items.length !== startCount;
        if (changed) setStatus(`Scan running… found ${state.items.length}`, "ok");
        else setStatus(`Scan running… (${ticks})`, "ok");

        // Stop after ~90s
        if (ticks >= 45) {
          setStatus("Scan finished (or timed out).", "ok");
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      } catch (e) {
        setStatus(`Polling error: ${e.message}`, "err");
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    };

    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(poll, 2000);
    poll();
  };

  // Refresh button
  root.querySelector("#refresh").onclick = async () => {
    setStatus("Refreshing…");
    try {
      await renderApp();
    } catch (e) {
      setStatus(e.message, "err");
    }
  };

  // Logout button
  root.querySelector("#logout").onclick = async () => {
    setStatus("Logging out…");
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (_) {}
    await boot();
  };

  // Items list + player
  const itemsEl = root.querySelector("#items");
  const countLine = root.querySelector("#countLine");
  const playerCard = root.querySelector("#playerCard");
  const player = root.querySelector("#player");
  const nowTitle = root.querySelector("#nowTitle");

  function renderItems() {
    countLine.textContent = state.currentLibId
      ? `${state.items.length} item(s)`
      : "Select a library";

    if (!state.items.length) {
      itemsEl.innerHTML = `<div class="muted">No items yet. Add a library and hit Scan.</div>`;
      return;
    }

    itemsEl.innerHTML = state.items
      .map(
        (i) => `
        <button class="item" data-id="${i.id}">
          <div class="item-title">${esc(i.title)}</div>
          <div class="item-meta">${esc(i.ext)} • ${esc(i.size_bytes)} bytes</div>
        </button>
      `
      )
      .join("");

    itemsEl.querySelectorAll(".item").forEach((btn) => {
      btn.onclick = async () => {
        const id = parseInt(btn.getAttribute("data-id"), 10);
        const item = state.items.find((x) => x.id === id);
        if (!item) return;

        nowTitle.textContent = item.title || `Item ${id}`;
        player.src = `/api/items/${id}/file`;
        playerCard.style.display = "";
        try {
          await player.play();
        } catch (_) {
          // autoplay might be blocked; user can hit play manually
        }
      };
    });
  }

  renderItems();
}

boot().catch((e) => {
  setView(`
    <div class="card">
      <div class="h1">Boot error</div>
      <div class="muted">${esc(e.message)}</div>
    </div>
  `);
});
