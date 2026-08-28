const http = require("http");
const { Pool } = require("pg");
const redis = require("redis");
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const PORT = parseInt(process.env.PORT ?? "4000", 10);
const FRONTEND_URL = process.env.FRONTEND_URL ?? "*";

// S3 / MinIO bucket config
const BUCKET_ENDPOINT = process.env.BUCKET_ENDPOINT ?? "";
const BUCKET_NAME = process.env.BUCKET_NAME ?? "";
const BUCKET_ACCESS_KEY = process.env.BUCKET_ACCESS_KEY ?? "";
const BUCKET_SECRET_KEY = process.env.BUCKET_SECRET_KEY ?? "";

const s3 = BUCKET_NAME
  ? new S3Client({
      endpoint: BUCKET_ENDPOINT || undefined,
      region: process.env.BUCKET_REGION ?? "eu-fsn1",
      credentials: { accessKeyId: BUCKET_ACCESS_KEY, secretAccessKey: BUCKET_SECRET_KEY },
      forcePathStyle: true,
    })
  : null;

async function withRetry(fn, label, maxAttempts = 10, baseDelayMs = 1000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try { return await fn(); } catch (err) {
      if (i === maxAttempts) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (i - 1), 30000);
      console.warn(`[${label}] attempt ${i} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const pg = new Pool({ connectionString: process.env.DATABASE_URL });
let redisClient = null;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function parseId(url, prefix) {
  const m = url.match(new RegExp(`^${prefix}/(\\d+)$`));
  return m ? parseInt(m[1]) : null;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", FRONTEND_URL);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const { url, method } = req;

  try {
    // ── Health ──────────────────────────────────────────────────────────────
    if (url === "/health") {
      json(res, 200, { ok: true, redis: !!redisClient, s3: !!s3 });
      return;
    }

    // ── GET /api/tasks ──────────────────────────────────────────────────────
    if (url === "/api/tasks" && method === "GET") {
      if (redisClient) {
        const cached = await redisClient.get("tasks").catch(() => null);
        if (cached) { res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "HIT" }); res.end(cached); return; }
      }
      const { rows } = await pg.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100");
      const out = JSON.stringify(rows);
      if (redisClient) await redisClient.setEx("tasks", 30, out).catch(() => null);
      res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "MISS" });
      res.end(out);
      return;
    }

    // ── POST /api/tasks ─────────────────────────────────────────────────────
    // Enqueues via Redis so the worker handles the insert asynchronously.
    if (url === "/api/tasks" && method === "POST") {
      const { title, priority } = await readBody(req);
      if (!title || typeof title !== "string" || !title.trim()) {
        json(res, 422, { error: "title is required" }); return;
      }
      const job = { action: "create", title: title.trim(), priority: priority ?? "normal" };
      if (redisClient) {
        await redisClient.lPush("task-queue", JSON.stringify(job));
        await redisClient.del("tasks").catch(() => null);
        json(res, 202, { queued: true, title: title.trim() });
      } else {
        const { rows } = await pg.query(
          "INSERT INTO tasks (title, priority) VALUES ($1, $2) RETURNING *",
          [title.trim(), job.priority]
        );
        if (redisClient) await redisClient.del("tasks").catch(() => null);
        json(res, 201, rows[0]);
      }
      return;
    }

    // ── PATCH /api/tasks/:id — toggle done or update title ──────────────────
    const taskId = parseId(url, "/api/tasks");
    if (taskId !== null && method === "PATCH") {
      const body = await readBody(req);
      const fields = [];
      const vals = [];
      if (body.done !== undefined) { fields.push(`done = $${vals.push(!!body.done)}`); }
      if (body.title !== undefined && body.title.trim()) { fields.push(`title = $${vals.push(body.title.trim())}`); }
      if (!fields.length) { json(res, 422, { error: "no updatable fields" }); return; }
      vals.push(taskId);
      const { rows } = await pg.query(
        `UPDATE tasks SET ${fields.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals
      );
      if (!rows.length) { json(res, 404, { error: "not found" }); return; }
      if (redisClient) await redisClient.del("tasks").catch(() => null);
      json(res, 200, rows[0]);
      return;
    }

    // ── DELETE /api/tasks/:id ───────────────────────────────────────────────
    if (taskId !== null && method === "DELETE") {
      const { rows } = await pg.query("DELETE FROM tasks WHERE id = $1 RETURNING file_key", [taskId]);
      if (!rows.length) { json(res, 404, { error: "not found" }); return; }
      // Delete associated S3 file if any
      if (s3 && rows[0].file_key) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: rows[0].file_key })).catch(() => null);
      }
      if (redisClient) await redisClient.del("tasks").catch(() => null);
      res.writeHead(204); res.end();
      return;
    }

    // ── POST /api/tasks/:id/upload — get a presigned S3 PUT URL ─────────────
    const uploadMatch = url.match(/^\/api\/tasks\/(\d+)\/upload$/);
    if (uploadMatch && method === "POST") {
      if (!s3) { json(res, 503, { error: "S3 not configured" }); return; }
      const id = parseInt(uploadMatch[1]);
      const { filename, contentType } = await readBody(req);
      if (!filename) { json(res, 422, { error: "filename required" }); return; }
      const key = `tasks/${id}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const putCmd = new PutObjectCommand({
        Bucket: BUCKET_NAME, Key: key,
        ContentType: contentType ?? "application/octet-stream",
      });
      const presignedUrl = await getSignedUrl(s3, putCmd, { expiresIn: 300 });
      // Record the key on the task
      await pg.query("UPDATE tasks SET file_key = $1, file_name = $2 WHERE id = $3", [key, filename, id]);
      if (redisClient) await redisClient.del("tasks").catch(() => null);
      json(res, 200, { upload_url: presignedUrl, key });
      return;
    }

    // ── GET /api/tasks/:id/download — get a presigned S3 GET URL ────────────
    const downloadMatch = url.match(/^\/api\/tasks\/(\d+)\/download$/);
    if (downloadMatch && method === "GET") {
      if (!s3) { json(res, 503, { error: "S3 not configured" }); return; }
      const id = parseInt(downloadMatch[1]);
      const { rows } = await pg.query("SELECT file_key, file_name FROM tasks WHERE id = $1", [id]);
      if (!rows.length || !rows[0].file_key) { json(res, 404, { error: "no file attached" }); return; }
      const getCmd = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: rows[0].file_key });
      const url2 = await getSignedUrl(s3, getCmd, { expiresIn: 300 });
      json(res, 200, { download_url: url2, file_name: rows[0].file_name });
      return;
    }

    // ── GET /api/stats ───────────────────────────────────────────────────────
    if (url === "/api/stats" && method === "GET") {
      const { rows } = await pg.query(
        "SELECT COUNT(*) total, COUNT(*) FILTER (WHERE done) done, COUNT(*) FILTER (WHERE file_key IS NOT NULL) with_files FROM tasks"
      );
      json(res, 200, {
        total: parseInt(rows[0].total),
        done: parseInt(rows[0].done),
        pending: parseInt(rows[0].total) - parseInt(rows[0].done),
        with_files: parseInt(rows[0].with_files),
      });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`taskflow-api listening on :${PORT}`);

  await withRetry(() => pg.query("SELECT 1"), "postgres");
  await pg.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      done        BOOLEAN NOT NULL DEFAULT FALSE,
      priority    TEXT NOT NULL DEFAULT 'normal',
      file_key    TEXT,
      file_name   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Idempotent column additions for upgrades from earlier schema
  await pg.query(`
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS priority  TEXT NOT NULL DEFAULT 'normal',
      ADD COLUMN IF NOT EXISTS file_key  TEXT,
      ADD COLUMN IF NOT EXISTS file_name TEXT
  `);
  console.log("[postgres] connected");

  if (process.env.REDIS_URL) {
    try {
      redisClient = redis.createClient({ url: process.env.REDIS_URL });
      await withRetry(() => redisClient.connect(), "redis", 5);
      console.log("[redis] connected");
    } catch (err) {
      console.warn("[redis] unavailable, continuing without cache:", err.message);
      redisClient = null;
    }
  }

  if (s3) console.log("[s3] configured →", BUCKET_NAME);
});
