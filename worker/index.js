const redis = require("redis");
const { Pool } = require("pg");

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

function makeRedisClient() {
  return redis.createClient({ url: process.env.REDIS_URL });
}

async function connectRedis(client) {
  await withRetry(() => client.connect(), "redis");
  console.log("[redis] connected");
  return client;
}

async function run() {
  await withRetry(() => pg.query("SELECT 1"), "postgres");
  console.log("[postgres] connected");

  let client = await connectRedis(makeRedisClient());
  console.log("taskflow-worker ready, polling task-queue...");

  while (true) {
    let job;
    try {
      job = await client.brPop("task-queue", 5);
    } catch (err) {
      console.warn("[redis] brPop error:", err.message, "— reconnecting...");
      try { await client.quit(); } catch (_) {}
      client = await connectRedis(makeRedisClient());
      continue;
    }

    if (!job) continue;

    let payload;
    try { payload = JSON.parse(job.element); } catch {
      console.warn("invalid job payload, skipping:", job.element); continue;
    }

    const { action, title, priority, id, done } = payload;

    try {
      if (action === "create" && title) {
        const { rows } = await pg.query(
          "INSERT INTO tasks (title, priority) VALUES ($1, $2) RETURNING id, title",
          [title, priority ?? "normal"]
        );
        console.log(`[worker] created task #${rows[0].id}: "${rows[0].title}"`);
      } else if (action === "toggle" && id !== undefined) {
        await pg.query("UPDATE tasks SET done = $1 WHERE id = $2", [!!done, id]);
        console.log(`[worker] task #${id} done=${done}`);
      } else if (action === "delete" && id) {
        await pg.query("DELETE FROM tasks WHERE id = $1", [id]);
        console.log(`[worker] deleted task #${id}`);
      } else {
        console.warn("[worker] unknown job:", payload); continue;
      }
      // Bust cache after every write
      await client.del("tasks").catch(() => null);
    } catch (err) {
      console.error("[worker] job failed:", err.message, payload);
    }
  }
}

run().catch(e => { console.error(e); process.exit(1); });
