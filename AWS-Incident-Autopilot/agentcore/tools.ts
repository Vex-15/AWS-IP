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
export const getMetricsTool = tool({
  name: 'getMetrics',
  description:
    'Retrieve CloudWatch metrics (Average, Maximum, or p95) for a given AWS resource over the last hour.',
  inputSchema: z.object({
    namespace: z.string().describe('e.g. AWS/Lambda, AWS/ApiGateway'),
    metricName: z
      .string()
      .describe('e.g. Duration, Invocations, Throttles, Errors, ConcurrentExecutions'),
    dimensionName: z.string().describe('e.g. FunctionName'),
    dimensionValue: z.string().describe('The resource name'),
    useP95: z
      .boolean()
      .default(false)
      .describe('If true, return p95 via ExtendedStatistics instead of Average/Maximum'),
  }),
  callback: async (input) => {
    console.log('Tool executing: getMetrics', input);
    try {
      const params: any = {
        Namespace: input.namespace,
        MetricName: input.metricName,
        Dimensions: [{ Name: input.dimensionName, Value: input.dimensionValue }],
        StartTime: new Date(Date.now() - 3600_000),
        EndTime: new Date(),
        Period: 60,
      };

      if (input.useP95) {
        params.ExtendedStatistics = ['p95'];
      } else {
        params.Statistics = ['Average', 'Maximum'];
      }

      const response = await cwClient.send(new GetMetricStatisticsCommand(params));

      const sorted = (response.Datapoints ?? []).sort(
        (a: any, b: any) =>
          new Date(a.Timestamp).getTime() - new Date(b.Timestamp).getTime(),
      );

      return {
        metric: input.metricName,
        namespace: input.namespace,
        resource: input.dimensionValue,
        datapoints: sorted.map((dp: any) => ({
          timestamp: dp.Timestamp,
          average: dp.Average,
          maximum: dp.Maximum,
          p95: dp.ExtendedStatistics?.p95,
        })),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});

// ─── queryLogs ────────────────────────────────────────────────────────────────
export const queryLogsTool = tool({
  name: 'queryLogs',
  description: 'Search CloudWatch Logs for a given log group with a filter pattern.',
  inputSchema: z.object({
    logGroupName: z.string().describe('e.g. /aws/lambda/MyFunction'),
    filterPattern: z.string().describe('e.g. "ERROR" or "Timeout" or "Throttl"'),
  }),
  callback: async (input) => {
    console.log('Tool executing: queryLogs', input);
    try {
      const response = await logsClient.send(
        new FilterLogEventsCommand({
          logGroupName: input.logGroupName,
          filterPattern: input.filterPattern,
          startTime: Date.now() - 3600_000,
          limit: 20,
        }),
      );
      const messages = (response.events ?? []).map((e: any) => ({
        timestamp: new Date(e.timestamp).toISOString(),
        message: e.message?.trim(),
      }));
      return { logGroup: input.logGroupName, matchCount: messages.length, events: messages };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});

// ─── getTraces ────────────────────────────────────────────────────────────────
export const getTracesTool = tool({
  name: 'getTraces',
  description: 'Retrieve X-Ray trace summaries for a Lambda function over the last hour.',
  inputSchema: z.object({
    functionName: z.string().describe('The Lambda function name to filter traces by'),
  }),
  callback: async (input) => {
    console.log('Tool executing: getTraces', input);
    try {
      const response = await xrayClient.send(
        new GetTraceSummariesCommand({
          StartTime: new Date(Date.now() - 3600_000),
          EndTime: new Date(),
          FilterExpression: `service("${input.functionName}")`,
        }),
      );
      const summaries = (response.TraceSummaries ?? []).slice(0, 10).map((t: any) => ({
        traceId: t.Id,
        duration: t.Duration,
        responseTime: t.ResponseTime,
        hasError: t.HasError,
        hasFault: t.HasFault,
        hasThrottle: t.HasThrottle,
      }));
      return { functionName: input.functionName, traceCount: summaries.length, traces: summaries };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});

// ─── getLambdaConfig ─────────────────────────────────────────────────────────
export const getLambdaConfigTool = tool({
  name: 'getLambdaConfig',
  description: 'Get the full configuration for a Lambda function including memory, timeout, and reserved concurrency.',
  inputSchema: z.object({
    functionName: z.string(),
  }),
  callback: async (input) => {
    console.log('Tool executing: getLambdaConfig', input);
    try {
      const [configResp, concurrencyResp] = await Promise.all([
        lambdaClient.send(new GetFunctionConfigurationCommand({ FunctionName: input.functionName })),
        lambdaClient.send(new GetFunctionConcurrencyCommand({ FunctionName: input.functionName })).catch(() => null),
      ]);

      return {
        FunctionName: configResp.FunctionName,
        MemorySize: configResp.MemorySize,
        Timeout: configResp.Timeout,
        Runtime: configResp.Runtime,
        ReservedConcurrentExecutions: concurrencyResp?.ReservedConcurrentExecutions ?? 'unreserved',
      };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});

// ─── applyFix ────────────────────────────────────────────────────────────────
export const applyFixTool = tool({
  name: 'applyFix',
  description:
    'Apply a configuration fix to a Lambda function. Can update MemorySize and/or ReservedConcurrentExecutions.',
  inputSchema: z.object({
    functionName: z.string(),
    memorySize: z.number().optional().describe('New memory in MB, e.g. 256, 512, 1024'),
    reservedConcurrency: z
      .number()
      .optional()
      .describe('New reserved concurrency limit, e.g. 50, 100'),
  }),
  callback: async (input) => {
    console.log('Tool executing: applyFix', input);
    const results: any = {};

    try {
      if (input.memorySize) {
        await lambdaClient.send(
          new UpdateFunctionConfigurationCommand({
            FunctionName: input.functionName,
            MemorySize: input.memorySize,
          }),
        );
        results.memoryUpdated = input.memorySize;
      }

      if (input.reservedConcurrency !== undefined) {
        await lambdaClient.send(
          new PutFunctionConcurrencyCommand({
            FunctionName: input.functionName,
            ReservedConcurrentExecutions: input.reservedConcurrency,
          }),
        );
        results.concurrencyUpdated = input.reservedConcurrency;
      }

      return { message: 'Fix applied successfully.', changes: results };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});

// ─── verifyRecovery ──────────────────────────────────────────────────────────
export const verifyRecoveryTool = tool({
  name: 'verifyRecovery',
  description:
    'Wait ~60 seconds, then re-query CloudWatch Duration p95 and Throttle metrics for a function to confirm the fix worked.',
  inputSchema: z.object({
    functionName: z.string(),
    waitSeconds: z.number().default(60).describe('Seconds to wait before checking (default 60)'),
  }),
  callback: async (input) => {
    const wait = input.waitSeconds ?? 60;
    console.log('Tool executing: verifyRecovery — waiting', wait, 'seconds');

    await new Promise((resolve) => setTimeout(resolve, wait * 1000));

    try {
      const now = new Date();
      const twoMinAgo = new Date(now.getTime() - 120_000);

      const [durationResp, throttleResp] = await Promise.all([
        cwClient.send(
          new GetMetricStatisticsCommand({
            Namespace: 'AWS/Lambda',
            MetricName: 'Duration',
            Dimensions: [{ Name: 'FunctionName', Value: input.functionName }],
            StartTime: twoMinAgo,
            EndTime: now,
            Period: 60,
            ExtendedStatistics: ['p95'],
          }),
        ),
        cwClient.send(
          new GetMetricStatisticsCommand({
            Namespace: 'AWS/Lambda',
            MetricName: 'Throttles',
            Dimensions: [{ Name: 'FunctionName', Value: input.functionName }],
            StartTime: twoMinAgo,
            EndTime: now,
            Period: 60,
            Statistics: ['Sum'],
          }),
        ),
      ]);

      const latestDuration = (durationResp.Datapoints ?? [])
        .sort((a: any, b: any) => new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime())[0];
      const latestThrottle = (throttleResp.Datapoints ?? [])
        .sort((a: any, b: any) => new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime())[0];

      const p95Now = latestDuration?.ExtendedStatistics?.p95 ?? null;
      const throttlesNow = latestThrottle?.Sum ?? 0;

      return {
        functionName: input.functionName,
        postFixMetrics: {
          durationP95ms: p95Now,
          throttleCount: throttlesNow,
        },
        verdict:
          p95Now !== null && p95Now < 1000
            ? 'RECOVERED — p95 latency is below 1s threshold.'
            : 'NOT_RECOVERED — latency still elevated or no data available yet.',
      };
    } catch (err: any) {
      return { error: err.message };
    }
  },
});
