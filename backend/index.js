const http = require("http");
const { Pool } = require("pg");
const redis = require("redis");

const PORT = parseInt(process.env.PORT ?? "4000", 10);

// Retry helper — exponential backoff up to maxAttempts
async function withRetry(fn, label, maxAttempts = 10, baseDelayMs = 1000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxAttempts) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (i - 1), 30000);
      console.warn(`[${label}] attempt ${i} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const pg = new Pool({ connectionString: process.env.DATABASE_URL });
let redisClient = null;

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL ?? "*");

  if (req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/api/tasks" && req.method === "GET") {
    if (redisClient) {
      const cached = await redisClient.get("tasks").catch(() => null);
      if (cached) {
        res.writeHead(200, { "X-Cache": "HIT" });
        res.end(cached);
        return;
      }
    }
    const { rows } = await pg.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50");
    if (redisClient) {
      await redisClient.setEx("tasks", 30, JSON.stringify(rows)).catch(() => null);
    }
    res.writeHead(200, { "X-Cache": "MISS" });
    res.end(JSON.stringify(rows));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`taskflow-api listening on :${PORT}`);

  // Connect to Postgres with retry
  await withRetry(
    () => pg.query("SELECT 1"),
    "postgres"
  );
  await pg.query(`CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    done BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  console.log("[postgres] connected");

  // Connect to Redis with retry (optional — degrades gracefully if unavailable)
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
});
