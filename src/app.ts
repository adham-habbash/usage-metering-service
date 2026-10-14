import express from "express";
import { resolve } from "node:path";
import { pool } from "./config/database.js";
import apiRouter from "./routes/api.js";

const app = express();

app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "usage-metering-service",
  });
});

app.get("/health/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.status(200).json({
      status: "ok",
      database: "connected",
    });
  } catch {
    res.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
});

app.use("/api", apiRouter);

app.use("/demo", express.static(resolve(process.cwd(), "public")));

app.get("/", (_req, res) => {
  res.redirect("/demo/");
});

export default app;
