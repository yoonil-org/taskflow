const http = require("http");
const { Pool } = require("pg");
const redis = require("redis");

const PORT = parseInt(process.env.PORT ?? "4000", 10);
const pg = new Pool({ connectionString: process.env.DATABASE_URL });
const redisClient = redis.createClient({ url: process.env.REDIS_URL });

redisClient.connect().catch(console.error);

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL ?? "*");

  if (req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/api/tasks" && req.method === "GET") {
    const cached = await redisClient.get("tasks");
    if (cached) {
      res.writeHead(200, { "X-Cache": "HIT" });
      res.end(cached);
      return;
    }
    const { rows } = await pg.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50");
    await redisClient.setEx("tasks", 30, JSON.stringify(rows));
    res.writeHead(200, { "X-Cache": "MISS" });
    res.end(JSON.stringify(rows));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", async () => {
  await pg.query(`CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    done BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  console.log(`taskflow-api listening on :${PORT}`);
});
