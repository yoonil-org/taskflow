const http = require("http");

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const API_URL = process.env.VITE_API_URL ?? "http://localhost:4000";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Taskflow</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; min-height: 100vh; }
    header { background: #6366f1; color: #fff; padding: 1rem 2rem; display: flex; align-items: center; justify-content: space-between; }
    header h1 { font-size: 1.25rem; font-weight: 700; letter-spacing: -.01em; }
    #stats { font-size: .85rem; opacity: .85; }
    main { max-width: 680px; margin: 2rem auto; padding: 0 1rem; }
    .add-form { display: flex; gap: .5rem; margin-bottom: 1.5rem; }
    .add-form input[type=text] {
      flex: 1; padding: .6rem .875rem; border: 1px solid #e2e8f0; border-radius: 8px;
      font-size: .95rem; background: #fff; outline: none; transition: border-color .15s;
    }
    .add-form input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px #e0e7ff; }
    select {
      padding: .6rem .75rem; border: 1px solid #e2e8f0; border-radius: 8px;
      font-size: .9rem; background: #fff; cursor: pointer;
    }
    .btn { padding: .6rem 1.1rem; border: none; border-radius: 8px; font-size: .9rem; font-weight: 600; cursor: pointer; transition: background .15s; }
    .btn-primary { background: #6366f1; color: #fff; }
    .btn-primary:hover { background: #4f46e5; }
    .btn-primary:disabled { background: #a5b4fc; cursor: default; }
    .task-list { list-style: none; display: flex; flex-direction: column; gap: .5rem; }
    .task {
      display: flex; align-items: center; gap: .75rem;
      background: #fff; padding: .8rem 1rem; border-radius: 10px;
      border: 1px solid #e2e8f0; transition: box-shadow .15s;
    }
    .task:hover { box-shadow: 0 1px 6px rgba(0,0,0,.07); }
    .task.done { opacity: .6; }
    .task input[type=checkbox] { width: 1.1rem; height: 1.1rem; cursor: pointer; accent-color: #6366f1; flex-shrink: 0; }
    .task-body { flex: 1; min-width: 0; }
    .task-title { font-size: .95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .task.done .task-title { text-decoration: line-through; color: #94a3b8; }
    .task-meta { font-size: .75rem; color: #94a3b8; margin-top: .2rem; display: flex; gap: .75rem; align-items: center; }
    .badge {
      display: inline-block; font-size: .7rem; font-weight: 600; padding: .1rem .4rem;
      border-radius: 4px; text-transform: uppercase; letter-spacing: .03em;
    }
    .badge-high { background: #fee2e2; color: #dc2626; }
    .badge-normal { background: #e0e7ff; color: #4f46e5; }
    .badge-low { background: #f1f5f9; color: #64748b; }
    .task-actions { display: flex; gap: .35rem; flex-shrink: 0; }
    .btn-icon { background: none; border: none; cursor: pointer; font-size: 1rem; padding: .25rem .4rem; border-radius: 5px; color: #64748b; }
    .btn-icon:hover { background: #f1f5f9; }
    .btn-icon.del:hover { background: #fee2e2; color: #dc2626; }
    .file-badge { font-size: .72rem; color: #6366f1; font-weight: 500; cursor: pointer; text-decoration: underline; }
    .upload-row { display: flex; align-items: center; gap: .4rem; }
    input[type=file] { font-size: .8rem; max-width: 160px; }
    .empty { text-align: center; color: #94a3b8; padding: 2rem; font-size: .95rem; }
    .notice { padding: .5rem .875rem; border-radius: 6px; font-size: .85rem; margin-bottom: 1rem; }
    .notice-err { background: #fee2e2; color: #dc2626; }
    .notice-ok { background: #dcfce7; color: #16a34a; }
    #notice { display: none; }
    .section-title { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #94a3b8; margin: 1.25rem 0 .5rem; }
  </style>
</head>
<body>
<header>
  <h1>⚡ Taskflow</h1>
  <span id="stats">loading...</span>
</header>
<main>
  <form class="add-form" id="addForm">
    <input id="titleInput" type="text" placeholder="New task…" autocomplete="off" required>
    <select id="priority">
      <option value="normal">Normal</option>
      <option value="high">High</option>
      <option value="low">Low</option>
    </select>
    <button class="btn btn-primary" type="submit" id="addBtn">Add</button>
  </form>
  <div id="notice" class="notice"></div>
  <div id="taskList"></div>
</main>

<script>
const API = "${API_URL}";

const listEl = document.getElementById("taskList");
const statsEl = document.getElementById("stats");
const noticeEl = document.getElementById("notice");
const form = document.getElementById("addForm");
const titleInput = document.getElementById("titleInput");
const priorityInput = document.getElementById("priority");
const addBtn = document.getElementById("addBtn");

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function showNotice(msg, type = "ok") {
  noticeEl.className = "notice notice-" + type;
  noticeEl.textContent = msg;
  noticeEl.style.display = "block";
  clearTimeout(noticeEl._t);
  noticeEl._t = setTimeout(() => { noticeEl.style.display = "none"; }, 4000);
}

async function apiFetch(path, opts = {}) {
  const r = await fetch(API + path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (r.status === 204) return null;
  return r.json();
}

async function loadStats() {
  try {
    const s = await apiFetch("/api/stats");
    statsEl.textContent = s.total + " tasks · " + s.done + " done · " + s.pending + " pending";
  } catch {}
}

async function load() {
  try {
    const tasks = await apiFetch("/api/tasks");
    await loadStats();
    if (!tasks.length) {
      listEl.innerHTML = '<p class="empty">No tasks yet. Add one above.</p>';
      return;
    }

    const high = tasks.filter(t => t.priority === "high");
    const normal = tasks.filter(t => t.priority === "normal");
    const low = tasks.filter(t => t.priority === "low");

    let html = "";
    for (const [label, group] of [["High priority", high], ["Normal", normal], ["Low", low]]) {
      if (!group.length) continue;
      html += \`<div class="section-title">\${label}</div><ul class="task-list">\`;
      for (const t of group) {
        html += \`
          <li class="task\${t.done ? " done" : ""}" data-id="\${t.id}">
            <input type="checkbox" \${t.done ? "checked" : ""} onchange="toggle(\${t.id}, this.checked)">
            <div class="task-body">
              <div class="task-title">\${esc(t.title)}</div>
              <div class="task-meta">
                <span class="badge badge-\${t.priority}">\${t.priority}</span>
                <span>\${new Date(t.created_at).toLocaleString()}</span>
                \${t.file_name ? \`<span class="file-badge" onclick="download(\${t.id})">📎 \${esc(t.file_name)}</span>\` : ""}
              </div>
            </div>
            <div class="task-actions">
              <label class="btn-icon" title="Attach file">
                📎<input type="file" style="display:none" onchange="upload(\${t.id}, this)">
              </label>
              <button class="btn-icon del" onclick="del(\${t.id})" title="Delete">✕</button>
            </div>
          </li>
        \`;
      }
      html += "</ul>";
    }
    listEl.innerHTML = html;
  } catch (e) {
    showNotice("Failed to load tasks: " + e.message, "err");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  if (!title) return;
  addBtn.disabled = true;
  try {
    await apiFetch("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title, priority: priorityInput.value }),
    });
    titleInput.value = "";
    showNotice("Task queued — worker will process it shortly.", "ok");
    setTimeout(load, 600);
  } catch (e) {
    showNotice("Failed to add task: " + e.message, "err");
  } finally {
    addBtn.disabled = false;
  }
});

async function toggle(id, done) {
  try {
    await apiFetch("/api/tasks/" + id, { method: "PATCH", body: JSON.stringify({ done }) });
    load();
  } catch { showNotice("Failed to update task", "err"); }
}

async function del(id) {
  try {
    await apiFetch("/api/tasks/" + id, { method: "DELETE" });
    load();
  } catch { showNotice("Failed to delete task", "err"); }
}

async function upload(id, input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const { upload_url } = await apiFetch("/api/tasks/" + id + "/upload", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentType: file.type || "application/octet-stream" }),
    });
    await fetch(upload_url, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
    showNotice("File uploaded: " + file.name, "ok");
    load();
  } catch (e) {
    showNotice("Upload failed: " + e.message, "err");
  }
}

async function download(id) {
  try {
    const { download_url } = await apiFetch("/api/tasks/" + id + "/download");
    window.open(download_url, "_blank");
  } catch (e) {
    showNotice("Download failed: " + e.message, "err");
  }
}

load();
setInterval(load, 5000);
</script>
</body>
</html>`;

http.createServer((req, res) => {
  if (req.url !== "/" && req.url !== "/index.html") {
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}).listen(PORT, "0.0.0.0", () => console.log("taskflow-frontend on :" + PORT));
