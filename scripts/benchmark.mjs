import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:8080")
  .replace(/\/+$/, "");

const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 1000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 25);
const UNITS = Number(process.env.BENCH_UNITS ?? 1);

function validatePositiveInteger(name, value, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
}

validatePositiveInteger("BENCH_REQUESTS", REQUESTS, 100000);
validatePositiveInteger("BENCH_CONCURRENCY", CONCURRENCY, 1000);
validatePositiveInteger("BENCH_UNITS", UNITS);

const requiredAllowance = REQUESTS * UNITS + 1000;

if (!Number.isSafeInteger(requiredAllowance)) {
  throw new Error("Requested benchmark workload is too large.");
}

async function api(path, { method = "GET", apiKey, body } = {}) {
  const headers = {};

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${path}: server returned invalid JSON.`);
  }

  if (!response.ok) {
    throw new Error(
      `${method} ${path} returned ${response.status}: ${JSON.stringify(data)}`,
    );
  }

  return data;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;

  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );

  return Number(sorted[index].toFixed(2));
}

async function main() {
  console.log("Checking service readiness...");

  await api("/health/ready");

  const runId = randomUUID();
  const accountName = `Benchmark ${runId.slice(0, 8)}`;
  const accountPlanName = `Bench Account ${runId.slice(0, 8)}`;
  const userPlanName = `Bench User ${runId.slice(0, 8)}`;

  // Use a dedicated account so existing demo usage cannot exhaust
  // the benchmark quotas.
  const accountResult = await api("/api/accounts", {
    method: "POST",
    body: { name: accountName },
  });

  const apiKey = accountResult.apiKey;

  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("Account provisioning did not return an API key.");
  }

  const allowance = Math.max(requiredAllowance, UNITS, 10000);
  const requestLimit = Math.max(UNITS, 100);

  const accountPlanResult = await api("/api/plans", {
    method: "POST",
    apiKey,
    body: {
      name: accountPlanName,
      scope: "account",
      monthlyAllowance: allowance,
      maxUnitsPerRequest: requestLimit,
    },
  });

  await api("/api/account/plan", {
    method: "PATCH",
    apiKey,
    body: { planId: accountPlanResult.plan.id },
  });

  const userPlanResult = await api("/api/plans", {
    method: "POST",
    apiKey,
    body: {
      name: userPlanName,
      scope: "user",
      monthlyAllowance: allowance,
      maxUnitsPerRequest: requestLimit,
    },
  });

  const userResult = await api("/api/users", {
    method: "POST",
    apiKey,
    body: {
      externalUserId: `bench-${runId}`,
      displayName: "Benchmark User",
      planId: userPlanResult.plan.id,
    },
  });

  const userId = userResult.user.id;

  console.log(`Account prepared. Requests: ${REQUESTS}`);
  console.log(`Concurrency: ${CONCURRENCY}; units/request: ${UNITS}`);
  console.log("Starting workload...");

  const latencies = [];
  const statusCounts = {};
  const errors = [];
  let accepted = 0;
  let rejected = 0;
  let nextRequest = 0;

  const startedAt = new Date().toISOString();
  const start = performance.now();

  async function worker() {
    while (true) {
      // Allocation is synchronous between awaits, so each request
      // receives a unique index.
      const index = nextRequest++;

      if (index >= REQUESTS) return;

      const requestId = `bench-${runId}-${index}`;
      const requestStart = performance.now();

      try {
        const response = await fetch(`${BASE_URL}/api/consume`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            userId,
            units: UNITS,
            requestId,
          }),
        });

        // Include receipt of the complete response body in latency.
        const text = await response.text();
        // Measure latency through the complete response body.
        const latency = performance.now() - requestStart;
        latencies.push(latency);

        statusCounts[response.status] =
          (statusCounts[response.status] ?? 0) + 1;
        let data;

        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          throw new Error(`Request ${index}: invalid JSON response.`);
        }

        if (!response.ok) {
          errors.push({
            request: index,
            status: response.status,
            message: data?.error?.message ?? "HTTP error",
          });
        } else if (data.accepted === true) {
          accepted++;
        } else if (data.accepted === false) {
          rejected++;
        } else {
          errors.push({
            request: index,
            status: response.status,
            message: "Response did not contain a boolean accepted field.",
          });
        }
      } catch (error) {
        latencies.push(performance.now() - requestStart);

        errors.push({
          request: index,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, REQUESTS) },
      () => worker(),
    ),
  );

  const elapsedSeconds = (performance.now() - start) / 1000;
  const finishedAt = new Date().toISOString();
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const completed = latencies.length;

  // Verify persisted usage after the measured workload has finished.
  const finalUsage = await api("/api/usage", { apiKey });
  const benchmarkUser = finalUsage.users.find(
    (item) => item.id === userId,
  );
  const expectedUnits = REQUESTS * UNITS;
  const accountConsumedUnits = Number(finalUsage.account.consumedUnits);
  const userConsumedUnits = Number(benchmarkUser?.consumedUnits ?? -1);
  const accountUsageMatchesExpected =
    accountConsumedUnits === expectedUnits;
  const userUsageMatchesExpected =
    userConsumedUnits === expectedUnits;

  const report = {
    runId,
    baseUrl: BASE_URL,
    startedAt,
    finishedAt,
    configuration: {
      requests: REQUESTS,
      concurrency: Math.min(CONCURRENCY, REQUESTS),
      unitsPerRequest: UNITS,
    },
    results: {
      completed,
      accepted,
      rejected,
      errors: errors.length,
      httpStatusCounts: statusCounts,
      dataIntegrity: {
        expectedUnits,
        accountConsumedUnits,
        userConsumedUnits,
        accountUsageMatchesExpected,
        userUsageMatchesExpected,
      },
      durationSeconds: Number(elapsedSeconds.toFixed(3)),
      requestsPerSecond: Number((completed / elapsedSeconds).toFixed(2)),
      acceptedRequestsPerSecond: Number((accepted / elapsedSeconds).toFixed(2)),
      latencyMs: {
        min: sortedLatencies.length
          ? Number(sortedLatencies[0].toFixed(2))
          : null,
        median: percentile(sortedLatencies, 0.50),
        p95: percentile(sortedLatencies, 0.95),
        p99: percentile(sortedLatencies, 0.99),
        max: sortedLatencies.length
          ? Number(sortedLatencies.at(-1).toFixed(2))
          : null,
      },
    },
    sampleErrors: errors.slice(0, 10),
    passed:
      completed === REQUESTS &&
      accepted === REQUESTS &&
      rejected === 0 &&
      errors.length === 0 &&
      accountUsageMatchesExpected &&
      userUsageMatchesExpected,
    notes: [
      "Latency measures each HTTP request from dispatch until the response body was received.",
      "The workload uses one account and one user, so requests contend on the shared account quota lock.",
      "Benchmark account and request history are persisted in PostgreSQL for auditability.",
      "Results depend on the host machine, Docker configuration, and workload settings.",
    ],
  };

  await mkdir("benchmark-results", { recursive: true });

  const fileName = `benchmark-${new Date()
    .toISOString()
    .replaceAll(":", "-")}.json`;

  await writeFile(
    `benchmark-results/${fileName}`,
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log("\n===== BENCHMARK RESULTS =====");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nSaved report: benchmark-results/${fileName}`);

  if (!report.passed) {
    console.error(
      "\nBenchmark did not meet the all-accepted, zero-error expectation.",
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Benchmark setup or execution failed:");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
