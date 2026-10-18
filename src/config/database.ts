import "dotenv/config";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

export const pool = new Pool({
  ...(connectionString ? { connectionString } : {}),
  max: 40,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

pool.on("error", (error: Error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});
