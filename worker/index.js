const redis = require("redis");
const { Pool } = require("pg");

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
const client = redis.createClient({ url: process.env.REDIS_URL });

async function run() {
  await withRetry(() => pg.query("SELECT 1"), "postgres");
  console.log("[postgres] connected");

  await withRetry(() => client.connect(), "redis");
  console.log("taskflow-worker ready, polling queue...");

  while (true) {
    const job = await client.brPop("task-queue", 5);
    if (!job) continue;
    const { title } = JSON.parse(job.element);
    await pg.query("INSERT INTO tasks (title) VALUES ($1)", [title]);
    await client.del("tasks");
    console.log("processed:", title);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
