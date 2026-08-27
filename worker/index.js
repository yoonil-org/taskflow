const redis = require("redis");
const { Pool } = require("pg");

const pg = new Pool({ connectionString: process.env.DATABASE_URL });
const client = redis.createClient({ url: process.env.REDIS_URL });

async function run() {
  await client.connect();
  console.log("taskflow-worker ready, polling queue...");
  while (true) {
    const job = await client.brPop("task-queue", 5);
    if (!job) continue;
    const { title } = JSON.parse(job.element);
    await pg.query("INSERT INTO tasks (title) VALUES ($1)", [title]);
    await client.del("tasks"); // invalidate cache
    console.log("processed:", title);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
