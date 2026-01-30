// Minimal UI flow:
// 1) Setup admin (first run)
// 2) Login
// 3) Libraries (add -> scan -> browse -> play)
//
// Also fixes "refresh sends me back to login" by persisting token (if backend returns it).

const app = document.querySelector("#app");

const TOKEN_KEY = "mw_token";
const USER_KEY = "mw_user";

const state = {
  mediaRoot: "",
  libraries: [],
  folders: [],
  currentLib: null,
  items: [],
  view: "loading", // loading | setup | login | libraries | browse
  status: "",
};

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}
function setToken(t) {
  if (!t) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, t);
}
function getUsername() {
  return localStorage.getItem(USER_KEY) || "";
}
function setUsername(u) {
  if (!u) localStorage.removeItem(USER_KEY);
  else localStorage.setItem(USER_KEY, u);
}

function layout(title, bodyHtml, topRightHtml = "") {
  app.innerHTML = `
    <div class="shell">
      <header class="top">
        <div class="brand">
          <div class="logo">MW</div>
          <div class="title">
            <div class="name">MadWolf</div>
            <div class="sub">${esc(title)}</div>
          </div>
        </div>
        <div class="topRight">${topRightHtml}</div>
      </header>

      <main class="main">
        ${bodyHtml}
      </main>

      <footer class="foot">
        <span class="muted">Media root:</span> <span class="code">${esc(state.mediaRoot || "")}</span>
        <span class="dot">•</span>
        <span class="muted" id="statusLine">${esc(state.status || "")}</span>
      </footer>
    </div>
  `;
}

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const token = getToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (opts.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, {
    ...opts,
    headers,
    credentials: "include",
    cache: "no-store",
  });

  if (!res.ok) {
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
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

function setStatus(msg) {
  state.status = msg || "";
  const el = document.querySelector("#statusLine");
  if (el) el.textContent = state.status;
}

function btn(id, label, kind = "") {
  return `<button class="btn ${kind}" id="${id}">${esc(label)}</button>`;
}

async function boot() {
  setStatus("");

  // server reachable + setup status
  let st;
  try {
    st = await api("/api/setup/status");
  } catch (e) {
    layout("Offline", `
      <section class="card">
        <h2>Server not reachable</h2>
        <p class="muted">Error: <span class="code">${esc(e.message)}</span></p>
      </section>
    `);
    return;
  }

  state.mediaRoot = st.mediaRoot || state.mediaRoot;

  if (st.needsSetup) {
    state.view = "setup";
    renderSetup();
    return;
  }

  // try to enter
  try {
    await api("/api/libraries");
    state.view = "libraries";
    await renderLibraries();
  } catch (e) {
    // token/cookie invalid
    if (e.status === 401) {
      setToken("");
      setUsername("");
    }
    state.view = "login";
    renderLogin();
  }
}

function renderSetup() {
  layout("First run setup", `
    <section class="card">
      <h2>Create admin</h2>
      <p class="muted">Do this once. After that, you’ll just login.</p>

      <div class="form">
        <div class="field">
          <label>Username</label>
          <input id="su" autocomplete="username" placeholder="admin" />
        </div>
        <div class="field">
          <label>Password</label>
          <input id="sp" type="password" autocomplete="new-password" placeholder="min 8 chars" />
        </div>
      </div>

      <div class="row">
        ${btn("createAdmin", "Create admin", "primary")}
        <div class="grow"></div>
      </div>

      <p class="hint">
        Reminder: the container can only see what you mount.
        Example: <span class="code">-v /mnt/user:/mnt/user</span>
      </p>
    </section>
  `);

  document.querySelector("#createAdmin").onclick = async () => {
    const username = document.querySelector("#su").value.trim();
    const password = document.querySelector("#sp").value;

    setStatus("Creating admin…");
    try {
      await api("/api/setup/init", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setStatus("Admin created. Go login.");
      renderLogin();
    } catch (e) {
      setStatus(`Setup failed: ${e.message}`);
    }
  };
}

function renderLogin() {
  layout("Sign in", `
    <section class="card">
      <h2>Login</h2>
      <p class="muted">Sign in to manage libraries and play titles.</p>

      <div class="form">
        <div class="field">
          <label>Username</label>
          <input id="lu" autocomplete="username" placeholder="admin" />
        </div>
        <div class="field">
          <label>Password</label>
          <input id="lp" type="password" autocomplete="current-password" placeholder="••••••••" />
        </div>
      </div>

      <div class="row">
        ${btn("loginBtn", "Login", "primary")}
        <div class="grow"></div>
      </div>
    </section>
  `);

  const doLogin = async () => {
    const username = document.querySelector("#lu").value.trim();
    const password = document.querySelector("#lp").value;

    setStatus("Logging in…");
    try {
      const res = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });

      // If backend returns token (recommended), persist it:
      if (res && res.token) setToken(res.token);
      setUsername(res?.username || username);

      setStatus("");
      await renderLibraries();
    } catch (e) {
      setStatus(`Login failed: ${e.message}`);
    }
  };

  document.querySelector("#loginBtn").onclick = doLogin;
  document.querySelector("#lp").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") doLogin();
  });
}

async function loadLibraries() {
  const data = await api("/api/libraries");
  state.mediaRoot = data.mediaRoot || state.mediaRoot;
  state.libraries = Array.isArray(data.libraries) ? data.libraries : [];
}

async function loadFolders() {
  const data = await api("/api/libraries/discover");
  // backend returns objects: {label, path} :contentReference[oaicite:5]{index=5}
  state.folders = Array.isArray(data.folders) ? data.folders : [];
}

async function renderLibraries() {
  state.view = "libraries";
  setStatus("Loading…");

  try {
    await Promise.all([loadLibraries(), loadFolders()]);
  } catch (e) {
    if (e.status === 401) {
      setToken("");
      setUsername("");
      renderLogin();
      return;
    }
    layout("Error", `<section class="card"><h2>Error</h2><p class="muted">${esc(e.message)}</p></section>`);
    return;
  }

  setStatus("");

  const user = getUsername() ? `<div class="pill">${esc(getUsername())}</div>` : "";
  layout(
    "Libraries",
    `
      <section class="card">
        <div class="cardHead">
          <h2>Libraries</h2>
          <div class="cardActions">
            ${btn("refreshLibs", "Refresh", "ghost")}
            ${btn("logoutBtn", "Logout", "danger")}
          </div>
        </div>

        <div class="subcard">
          <h3>Add library</h3>
          <div class="row">
            <div class="field grow">
              <label>Name</label>
              <input id="newName" placeholder="Movies" />
            </div>
            <div class="field grow">
              <label>Folder</label>
              <select id="folderSelect">
                ${
                  state.folders.length
                    ? state.folders
                        .map((f) => `<option value="${esc(f.path)}">${esc(f.label)}</option>`)
                        .join("")
                    : `<option value="">(no folders discovered)</option>`
                }
              </select>
            </div>
            ${btn("addLibBtn", "Add", "primary")}
          </div>
          <p class="hint">Dropdown shows only top-level folders under <span class="code">${esc(state.mediaRoot)}</span>.</p>
        </div>

        <div class="subcard">
          <h3>Existing</h3>
          ${
            state.libraries.length
              ? `<div class="libList">
                  ${state.libraries
                    .map(
                      (l) => `
                        <div class="libRow">
                          <div class="libMeta">
                            <div class="libName">${esc(l.name)}</div>
                            <div class="libPath code">${esc(l.path)}</div>
                          </div>
                          <div class="libBtns">
                            <button class="btn ghost" data-browse="${l.id}">Browse</button>
                            <button class="btn" data-scan="${l.id}">Scan</button>
                          </div>
                        </div>
                      `
                    )
                    .join("")}
                </div>`
              : `<p class="muted">No libraries yet. Add one above.</p>`
          }
        </div>
      </section>
    `,
    user
  );

  document.querySelector("#logoutBtn").onclick = async () => {
    setStatus("Logging out…");
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (_) {}
    setToken("");
    setUsername("");
    setStatus("");
    renderLogin();
  };

  document.querySelector("#refreshLibs").onclick = async () => {
    await renderLibraries();
  };

  document.querySelector("#addLibBtn").onclick = async () => {
    const name = document.querySelector("#newName").value.trim();
    const path = document.querySelector("#folderSelect").value;

    if (!name) return setStatus("Name is required.");
    if (!path) return setStatus("Folder is required.");

    setStatus("Creating library…");
    try {
      await api("/api/libraries", {
        method: "POST",
        body: JSON.stringify({ name, path }),
      });
      setStatus("Library created.");
      await renderLibraries();
    } catch (e) {
      setStatus(`Add failed: ${e.message}`);
    }
  };

  // Browse
  document.querySelectorAll("[data-browse]").forEach((b) => {
    b.onclick = async () => {
      const id = parseInt(b.getAttribute("data-browse"), 10);
      const lib = state.libraries.find((x) => x.id === id);
      if (!lib) return;
      state.currentLib = lib;
      await renderBrowse();
    };
  });

  // Scan
  document.querySelectorAll("[data-scan]").forEach((b) => {
    b.onclick = async () => {
      const id = parseInt(b.getAttribute("data-scan"), 10);
      setStatus("Scan queued…");
      try {
        await api(`/api/libraries/${id}/scan`, { method: "POST" });
        setStatus("Scan started in background. Go browse in a few seconds.");
      } catch (e) {
        setStatus(`Scan failed: ${e.message}`);
      }
    };
  });
}

async function loadItemsFor(libId) {
  const data = await api(`/api/items?library_id=${encodeURIComponent(libId)}&limit=500&offset=0`);
  state.items = Array.isArray(data.items) ? data.items : [];
}

async function renderBrowse() {
  state.view = "browse";
  setStatus("Loading titles…");

  try {
    await loadItemsFor(state.currentLib.id);
  } catch (e) {
    if (e.status === 401) {
      setToken("");
      setUsername("");
      renderLogin();
      return;
    }
    setStatus(e.message);
  }

  setStatus("");

  layout(
    `Browse • ${state.currentLib.name}`,
    `
      <section class="card">
        <div class="cardHead">
          <div>
            <h2>${esc(state.currentLib.name)}</h2>
            <p class="muted">${esc(state.items.length)} item(s)</p>
          </div>
          <div class="cardActions">
            ${btn("backBtn", "Back", "ghost")}
            ${btn("refreshBtn", "Refresh", "ghost")}
          </div>
        </div>

        <div class="row">
          <div class="field grow">
            <label>Search</label>
            <input id="q" placeholder="Type to filter…" />
          </div>
        </div>

        <div class="items" id="items">
          ${renderItemsHtml(state.items)}
        </div>

        <div class="player" id="playerWrap" style="display:none;">
          <div class="now">
            <div class="muted">Now playing</div>
            <div class="nowTitle" id="nowTitle"></div>
          </div>
          <video id="player" controls playsinline></video>
        </div>
      </section>
    `
  );

  document.querySelector("#backBtn").onclick = async () => renderLibraries();
  document.querySelector("#refreshBtn").onclick = async () => {
    setStatus("Refreshing…");
    await loadItemsFor(state.currentLib.id);
    setStatus("");
    document.querySelector("#items").innerHTML = renderItemsHtml(state.items);
    wireItemClicks();
  };

  const q = document.querySelector("#q");
  q.oninput = () => {
    const s = q.value.trim().toLowerCase();
    const filtered = !s
      ? state.items
      : state.items.filter((i) => (i.title || "").toLowerCase().includes(s));
    document.querySelector("#items").innerHTML = renderItemsHtml(filtered);
    wireItemClicks();
  };

  wireItemClicks();
}

function renderItemsHtml(items) {
  if (!items.length) return `<p class="muted">No items yet. Run Scan.</p>`;
  return items
    .map(
      (i) => `
        <button class="item" data-id="${i.id}">
          <div class="itemTitle">${esc(i.title)}</div>
          <div class="itemMeta">${esc(i.ext || "")}</div>
        </button>
      `
    )
    .join("");
}

function wireItemClicks() {
  const wrap = document.querySelector("#playerWrap");
  const player = document.querySelector("#player");
  const nowTitle = document.querySelector("#nowTitle");

  document.querySelectorAll(".item[data-id]").forEach((btn) => {
    btn.onclick = async () => {
      const id = parseInt(btn.getAttribute("data-id"), 10);
      const item = state.items.find((x) => x.id === id);
      if (!item) return;

      nowTitle.textContent = item.title || `Item ${id}`;
      player.src = `/api/items/${id}/file`;
      wrap.style.display = "";
      try {
        await player.play();
      } catch (_) {
        // autoplay may be blocked
      }
    };
  });
}

boot().catch((e) => {
  layout("Boot error", `
    <section class="card">
      <h2>Boot error</h2>
      <p class="muted">${esc(e.message)}</p>
    </section>
  `);
});
