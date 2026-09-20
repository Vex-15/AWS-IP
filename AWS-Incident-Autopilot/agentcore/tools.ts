import { z } from 'zod';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
  GetFunctionConcurrencyCommand,
  GetAccountSettingsCommand,
  UpdateFunctionConfigurationCommand,
  PutFunctionConcurrencyCommand,
} from '@aws-sdk/client-lambda';
import { XRayClient, GetTraceSummariesCommand } from '@aws-sdk/client-xray';
import { tool } from '@strands-agents/sdk';

const cwClient = new CloudWatchClient({});
const logsClient = new CloudWatchLogsClient({});
const lambdaClient = new LambdaClient({});
const xrayClient = new XRayClient({});

// ─── getMetrics ────────────────────────────────────────────────────────────────
// Returns ALL statistics for a metric in one call: Average, Maximum, p95, Sum.
// Explicitly reports when there are zero datapoints.
export const getMetricsTool = tool({
  name: 'getMetrics',
  description:
    'Retrieve CloudWatch metrics for a Lambda function over the last hour. Returns Average, Maximum, p95, and Sum for each 1-minute period. If no datapoints exist, returns datapointCount: 0.',
  inputSchema: z.object({
    namespace: z.string().describe('AWS metric namespace, e.g. AWS/Lambda'),
    metricName: z
      .string()
      .describe('Metric name: Duration, Invocations, Throttles, Errors, ConcurrentExecutions'),
    functionName: z.string().describe('The Lambda function name (used as FunctionName dimension)'),
  }),
  callback: async (input) => {
    console.log('Tool executing: getMetrics', JSON.stringify(input));
    try {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600_000);

      let raw: any[] = [];
      let attempts = 0;
      const maxAttempts = 9; // Wait up to ~90 seconds for CW metrics to propagate

      while (attempts < maxAttempts) {
        const response = await cwClient.send(
          new GetMetricStatisticsCommand({
            Namespace: input.namespace,
            MetricName: input.metricName,
            Dimensions: [{ Name: 'FunctionName', Value: input.functionName }],
            StartTime: oneHourAgo,
            EndTime: now,
            Period: 60,
            Statistics: ['Average', 'Maximum', 'Sum', 'SampleCount'],
            ExtendedStatistics: ['p95'],
          }),
        );
        
        raw = response.Datapoints ?? [];
        if (raw.length > 0) break; // Found data, proceed
        
        attempts++;
        if (attempts < maxAttempts) {
          console.log(`No datapoints for ${input.metricName}, waiting 10s (attempt ${attempts}/${maxAttempts})...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }

      if (raw.length === 0) {
        return {
          metric: input.metricName,
          namespace: input.namespace,
          functionName: input.functionName,
          datapointCount: 0,
          message: `NO DATAPOINTS for ${input.metricName} in the last hour. The function may not have been invoked recently.`,
          datapoints: [],
        };
      }

      const sorted = raw.sort(
        (a: any, b: any) =>
          new Date(a.Timestamp).getTime() - new Date(b.Timestamp).getTime(),
      );

      const datapoints = sorted.map((dp: any) => ({
        timestamp: dp.Timestamp,
        average: dp.Average != null ? Math.round(dp.Average * 100) / 100 : null,
        maximum: dp.Maximum != null ? Math.round(dp.Maximum * 100) / 100 : null,
        sum: dp.Sum != null ? Math.round(dp.Sum * 100) / 100 : null,
        sampleCount: dp.SampleCount ?? null,
        p95: dp.ExtendedStatistics?.p95 != null
          ? Math.round(dp.ExtendedStatistics.p95 * 100) / 100
          : null,
      }));

      // Compute summary across all datapoints
      const allP95 = datapoints.map((d: any) => d.p95).filter((v: any) => v != null);
      const allMax = datapoints.map((d: any) => d.maximum).filter((v: any) => v != null);
      const allAvg = datapoints.map((d: any) => d.average).filter((v: any) => v != null);
      const allSum = datapoints.map((d: any) => d.sum).filter((v: any) => v != null);

      return {
        metric: input.metricName,
        namespace: input.namespace,
        functionName: input.functionName,
        datapointCount: datapoints.length,
        summary: {
          overallMaxP95: allP95.length > 0 ? Math.max(...allP95) : null,
          overallMax: allMax.length > 0 ? Math.max(...allMax) : null,
          overallAvg:
            allAvg.length > 0
              ? Math.round((allAvg.reduce((a: number, b: number) => a + b, 0) / allAvg.length) * 100) / 100
              : null,
          totalSum: allSum.length > 0 ? allSum.reduce((a: number, b: number) => a + b, 0) : null,
        },
        // Return last 10 datapoints to keep context size reasonable
        recentDatapoints: datapoints.slice(-10),
      };
    } catch (err: any) {
      return { error: err.message, metric: input.metricName, functionName: input.functionName };
    }
  },
});

// ─── queryLogs ────────────────────────────────────────────────────────────────
export const queryLogsTool = tool({
  name: 'queryLogs',
  description:
    'Search CloudWatch Logs for a given log group. Returns matching log events or explicitly reports zero matches.',
  inputSchema: z.object({
    logGroupName: z.string().describe('e.g. /aws/lambda/BackendStack-DemoSlowLambda'),
    filterPattern: z.string().describe('CloudWatch filter pattern, e.g. "ERROR" or "Timeout"'),
  }),
  callback: async (input) => {
    console.log('Tool executing: queryLogs', JSON.stringify(input));
    try {
      const response = await logsClient.send(
        new FilterLogEventsCommand({
          logGroupName: input.logGroupName,
          filterPattern: input.filterPattern,
          startTime: Date.now() - 3600_000,
          limit: 20,
        }),
      );
      const events = (response.events ?? []).map((e: any) => ({
        timestamp: new Date(e.timestamp).toISOString(),
        message: e.message?.trim(),
      }));

      if (events.length === 0) {
        return {
          logGroup: input.logGroupName,
          filterPattern: input.filterPattern,
          matchCount: 0,
          message: `No log events matched "${input.filterPattern}" in the last hour. This suggests the function is NOT producing ${input.filterPattern}-related log output.`,
          events: [],
        };
      }

      return {
        logGroup: input.logGroupName,
        filterPattern: input.filterPattern,
        matchCount: events.length,
        events,
      };
    } catch (err: any) {
      return { error: err.message, logGroup: input.logGroupName };
    }
  },
});

// ─── getTraces ────────────────────────────────────────────────────────────────
// Uses X-Ray filter expression to scope traces to the target function only.
export const getTracesTool = tool({
  name: 'getTraces',
  description:
    'Retrieve X-Ray trace summaries for a specific Lambda function over the last hour. Returns duration, errors, faults, and throttle status for each trace.',
  inputSchema: z.object({
    functionName: z
      .string()
      .describe('The exact Lambda function name to filter traces by'),
  }),
  callback: async (input) => {
    console.log('Tool executing: getTraces', JSON.stringify(input));
    try {
      // Use annotation filter to ensure we only get traces for THIS function
      const filterExpression = `service("${input.functionName}")`;

      const response = await xrayClient.send(
        new GetTraceSummariesCommand({
          StartTime: new Date(Date.now() - 3600_000),
          EndTime: new Date(),
          FilterExpression: filterExpression,
          Sampling: false, // Get all traces, not sampled subset
        }),
      );

      const allSummaries = response.TraceSummaries ?? [];

      if (allSummaries.length === 0) {
        return {
          functionName: input.functionName,
          traceCount: 0,
          message: `No X-Ray traces found for "${input.functionName}" in the last hour. Tracing may not be active, or the function was not invoked.`,
          traces: [],
          summary: null,
        };
      }

      // Take up to 15 most recent traces
      const recent = allSummaries
        .sort((a: any, b: any) => {
          const tA = a.ResponseTime ?? a.Duration ?? 0;
          const tB = b.ResponseTime ?? b.Duration ?? 0;
          return tB - tA; // Sort by longest first
        })
        .slice(0, 15);

      const traces = recent.map((t: any) => ({
        traceId: t.Id,
        durationSec: t.Duration != null ? Math.round(t.Duration * 1000) / 1000 : null,
        responseTimeSec: t.ResponseTime != null ? Math.round(t.ResponseTime * 1000) / 1000 : null,
        hasError: t.HasError ?? false,
        hasFault: t.HasFault ?? false,
        hasThrottle: t.HasThrottle ?? false,
      }));

      // Compute summary stats
      const durations = traces
        .map((t: any) => t.durationSec)
        .filter((d: any) => d != null) as number[];

      const errorCount = traces.filter((t: any) => t.hasError).length;
      const faultCount = traces.filter((t: any) => t.hasFault).length;
      const throttleCount = traces.filter((t: any) => t.hasThrottle).length;

      return {
        functionName: input.functionName,
        traceCount: allSummaries.length,
        tracesReturned: traces.length,
        summary: {
          avgDurationSec:
            durations.length > 0
              ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 1000) / 1000
              : null,
          maxDurationSec: durations.length > 0 ? Math.max(...durations) : null,
          errorCount,
          faultCount,
          throttleCount,
        },
        traces,
      };
    } catch (err: any) {
      return { error: err.message, functionName: input.functionName };
    }
  },
});

// ─── getLambdaConfig ─────────────────────────────────────────────────────────
// Returns the ACTUAL current config from AWS, plus account-level limits.
export const getLambdaConfigTool = tool({
  name: 'getLambdaConfig',
  description:
    'Get the ACTUAL current configuration for a Lambda function (MemorySize, Timeout, Runtime) and the account\'s concurrency limits. Use this to understand the current state before proposing any changes.',
  inputSchema: z.object({
    functionName: z.string().describe('The exact Lambda function name'),
  }),
  callback: async (input) => {
    console.log('Tool executing: getLambdaConfig', JSON.stringify(input));
    try {
      const [configResp, concurrencyResp, accountResp] = await Promise.all([
        lambdaClient.send(
          new GetFunctionConfigurationCommand({ FunctionName: input.functionName }),
        ),
        lambdaClient
          .send(new GetFunctionConcurrencyCommand({ FunctionName: input.functionName }))
          .catch(() => null),
        lambdaClient.send(new GetAccountSettingsCommand({})).catch(() => null),
      ]);

      const accountConcurrencyLimit =
        accountResp?.AccountLimit?.ConcurrentExecutions ?? 'unknown';
      const unreservedConcurrency =
        accountResp?.AccountLimit?.UnreservedConcurrentExecutions ?? 'unknown';

      return {
        functionName: configResp.FunctionName,
        memoryMB: configResp.MemorySize,
        timeoutSec: configResp.Timeout,
        runtime: configResp.Runtime,
        codeSize: configResp.CodeSize,
        lastModified: configResp.LastModified,
        reservedConcurrency:
          concurrencyResp?.ReservedConcurrentExecutions ?? 'unreserved (none set)',
        accountLimits: {
          totalConcurrencyLimit: accountConcurrencyLimit,
          currentUnreservedConcurrency: unreservedConcurrency,
          note: 'AWS requires at least 10 unreserved concurrency. Do NOT set reservedConcurrency if the account has ≤ 10 total concurrency.',
        },
      };
    } catch (err: any) {
      return { error: err.message, functionName: input.functionName };
    }
  },
});

// ─── applyFix ────────────────────────────────────────────────────────────────
// Validates inputs against AWS limits BEFORE applying.
export const applyFixTool = tool({
  name: 'applyFix',
  description:
    'Apply a configuration fix to a Lambda function. Can update MemorySize (128-10240 MB). Validates against account limits before applying. Do NOT call unless the user has explicitly approved.',
  inputSchema: z.object({
    functionName: z.string(),
    memorySize: z
      .number()
      .optional()
      .describe('New memory in MB. Must be between 128 and 10240. Lambda CPU scales linearly with memory.'),
    reservedConcurrency: z
      .number()
      .optional()
      .describe(
        'New reserved concurrency. WARNING: requires sufficient unreserved account concurrency. Check getLambdaConfig first.',
      ),
  }),
  callback: async (input) => {
    console.log('Tool executing: applyFix', JSON.stringify(input));
    const results: any = { functionName: input.functionName, applied: [] as string[], skipped: [] as string[] };

    // ── Validate memory ──
    if (input.memorySize != null) {
      if (input.memorySize < 128 || input.memorySize > 10240) {
        results.skipped.push(
          `memorySize=${input.memorySize} MB is outside AWS limits [128, 10240]. Not applied.`,
        );
      } else {
        try {
          await lambdaClient.send(
            new UpdateFunctionConfigurationCommand({
              FunctionName: input.functionName,
              MemorySize: input.memorySize,
            }),
          );
          results.applied.push(`MemorySize updated to ${input.memorySize} MB`);
        } catch (err: any) {
          results.skipped.push(`MemorySize update failed: ${err.message}`);
        }
      }
    }

    // ── Validate concurrency ──
    if (input.reservedConcurrency != null) {
      // Check account limits first
      try {
        const accountResp = await lambdaClient.send(new GetAccountSettingsCommand({}));
        const totalLimit =
          accountResp.AccountLimit?.ConcurrentExecutions ?? 0;
        const unreserved =
          accountResp.AccountLimit?.UnreservedConcurrentExecutions ?? 0;

        // HARD BLOCK: never set reserved concurrency on small accounts.
        // Setting it caused ReservedFunctionConcurrentInvocationLimitExceeded
        // which throttled ALL invocations and broke the entire demo.
        if (totalLimit <= 50) {
          results.skipped.push(
            `BLOCKED: Cannot set reservedConcurrency. Account total concurrency is only ${totalLimit}. Setting reserved concurrency on a small account will throttle ALL invocations. This is an account-level constraint.`,
          );
        } else if (unreserved <= 10) {
          results.skipped.push(
            `Cannot set reservedConcurrency: account only has ${unreserved} unreserved concurrency (AWS requires ≥10 unreserved).`,
          );
        } else if (input.reservedConcurrency > unreserved - 10) {
          results.skipped.push(
            `Cannot reserve ${input.reservedConcurrency}: only ${unreserved - 10} concurrency available after keeping 10 unreserved.`,
          );
        } else {
          await lambdaClient.send(
            new PutFunctionConcurrencyCommand({
              FunctionName: input.functionName,
              ReservedConcurrentExecutions: input.reservedConcurrency,
            }),
          );
          results.applied.push(
            `ReservedConcurrentExecutions set to ${input.reservedConcurrency}`,
          );
        }
      } catch (err: any) {
        results.skipped.push(`Concurrency update failed: ${err.message}`);
      }
    }

    if (results.applied.length === 0 && results.skipped.length === 0) {
      return { error: 'No changes specified. Provide memorySize and/or reservedConcurrency.' };
    }

    return results;
  },
});

// ─── verifyRecovery ──────────────────────────────────────────────────────────
export const verifyRecoveryTool = tool({
  name: 'verifyRecovery',
  description:
    'Wait, then re-query CloudWatch Duration p95 and Throttle metrics and the current Lambda config to confirm the fix worked. Reports concrete before/after numbers.',
  inputSchema: z.object({
    functionName: z.string(),
    waitSeconds: z
      .number()
      .default(60)
      .describe('Seconds to wait before re-checking metrics (default 60)'),
  }),
  callback: async (input) => {
    const wait = input.waitSeconds ?? 60;
    console.log(`Tool executing: verifyRecovery — waiting ${wait}s`);

    await new Promise((resolve) => setTimeout(resolve, wait * 1000));

    try {
      const now = new Date();
      const threeMinAgo = new Date(now.getTime() - 180_000);

      const [durationResp, throttleResp, configResp] = await Promise.all([
        cwClient.send(
          new GetMetricStatisticsCommand({
            Namespace: 'AWS/Lambda',
            MetricName: 'Duration',
            Dimensions: [{ Name: 'FunctionName', Value: input.functionName }],
            StartTime: threeMinAgo,
            EndTime: now,
            Period: 60,
            Statistics: ['Average', 'Maximum'],
            ExtendedStatistics: ['p95'],
          }),
        ),
        cwClient.send(
          new GetMetricStatisticsCommand({
            Namespace: 'AWS/Lambda',
            MetricName: 'Throttles',
            Dimensions: [{ Name: 'FunctionName', Value: input.functionName }],
            StartTime: threeMinAgo,
            EndTime: now,
            Period: 60,
            Statistics: ['Sum'],
          }),
        ),
        lambdaClient.send(
          new GetFunctionConfigurationCommand({ FunctionName: input.functionName }),
        ),
      ]);

      const durationDPs = (durationResp.Datapoints ?? []).sort(
        (a: any, b: any) =>
          new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime(),
      );
      const throttleDPs = (throttleResp.Datapoints ?? []).sort(
        (a: any, b: any) =>
          new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime(),
      );

      const latestDuration = durationDPs[0];
      const latestThrottle = throttleDPs[0];

      const p95Now = latestDuration?.ExtendedStatistics?.p95 ?? null;
      const avgNow = latestDuration?.Average ?? null;
      const maxNow = latestDuration?.Maximum ?? null;
      const throttlesNow = latestThrottle?.Sum ?? 0;

      const hasData = p95Now !== null || avgNow !== null;
      let verdict: string;

      if (!hasData) {
        verdict =
          'INSUFFICIENT_DATA — No post-fix metric datapoints available yet. The function may need more invocations to generate new data.';
      } else if (p95Now !== null && p95Now < 1000) {
        verdict = `RECOVERED — P95 latency is ${Math.round(p95Now)}ms, below the 1000ms threshold.`;
      } else if (p95Now !== null) {
        verdict = `NOT_RECOVERED — P95 latency is still ${Math.round(p95Now)}ms (threshold: 1000ms).`;
      } else {
        verdict = `PARTIAL_DATA — Average: ${avgNow != null ? Math.round(avgNow) : '?'}ms, Max: ${maxNow != null ? Math.round(maxNow) : '?'}ms. P95 not available.`;
      }

      return {
        functionName: input.functionName,
        currentConfig: {
          memoryMB: configResp.MemorySize,
          timeoutSec: configResp.Timeout,
        },
        postFixMetrics: {
          durationP95ms: p95Now != null ? Math.round(p95Now) : null,
          durationAvgMs: avgNow != null ? Math.round(avgNow) : null,
          durationMaxMs: maxNow != null ? Math.round(maxNow) : null,
          throttleSum: throttlesNow,
          datapointsAvailable: durationDPs.length,
        },
        verdict,
      };
    } catch (err: any) {
      return { error: err.message, functionName: input.functionName };
    }
  },
});
