const {
  CloudWatchClient,
  DescribeAlarmsCommand,
  GetMetricStatisticsCommand,
  SetAlarmStateCommand,
} = require('@aws-sdk/client-cloudwatch');

const {
  LambdaClient,
  InvokeCommand,
} = require('@aws-sdk/client-lambda');

const cwClient = new CloudWatchClient({});
const lambdaClient = new LambdaClient({});

exports.handler = async (event: any) => {
  console.log("Deployed V2 API Handler!");
  const method = event.httpMethod;
  const path = event.resource || event.path;

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
  };

  // ── GET /incidents — list active CloudWatch alarms ────────────────
  if (method === "GET" && path.endsWith("/incidents")) {
    try {
      const response = await cwClient.send(
        new DescribeAlarmsCommand({
          StateValue: "ALARM"
        })
      );

      const activeAlarms = (
        response.MetricAlarms || []
      ).map((alarm: any) => {

        // Extract FunctionName from alarm dimensions
        const fnDim = (
          alarm.Dimensions || []
        ).find(
          (d: any) => d.Name === "FunctionName"
        );

        return {
          id: alarm.AlarmArn,

          service:
            alarm.Namespace ||
            "AWS/Lambda",

          title:
            alarm.AlarmName,

          description:
            alarm.AlarmDescription ||
            "",

          status:
            "investigating",

          functionName:
            fnDim
              ? fnDim.Value
              : null,

          time:
            alarm.StateUpdatedTimestamp
              ? alarm.StateUpdatedTimestamp.toISOString()
              : new Date().toISOString(),
        };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(activeAlarms),
      };

    } catch (err: unknown) {
      console.error(err);

      const errorMessage =
        err instanceof Error
          ? err.message
          : String(err);

      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: errorMessage,
        }),
      };
    }
  }

  // ── POST /incidents/trigger ──────────────────────────────────────
  // Fire invocations to DemoSlowLambda
  if (
    method === "POST" &&
    path.includes("/trigger")
  ) {
    const demoLambda =
      process.env.DEMO_LAMBDA_NAME;

    if (!demoLambda) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error:
            "DEMO_LAMBDA_NAME not configured",
        }),
      };
    }

    try {
      // Fire invocations in small batches to avoid throttling.
      // Account only has 10 total concurrency — 50 concurrent invokes
      // will ALL get throttled. Instead, do 10 invocations in batches of 2.
      const TOTAL = 10;
      const BATCH = 2;
      let invoked = 0;

      for (let batch = 0; batch < TOTAL; batch += BATCH) {
        const batchPromises: Promise<any>[] = [];
        for (let i = 0; i < BATCH && (batch + i) < TOTAL; i++) {
          batchPromises.push(
            lambdaClient.send(
              new InvokeCommand({
                FunctionName: demoLambda,
                InvocationType: "Event",
              })
            )
          );
        }
        await Promise.all(batchPromises);
        invoked += batchPromises.length;
      }

      // Force alarm to ALARM state immediately so the incident
      // appears in the UI without waiting for CloudWatch evaluation.
      const alarmName = process.env.ALARM_NAME || 'DemoSlowLambda-HighLatency';
      try {
        await cwClient.send(
          new SetAlarmStateCommand({
            AlarmName: alarmName,
            StateValue: 'ALARM',
            StateReason: 'Demo incident triggered — high latency invocations fired.',
          })
        );
      } catch (alarmErr: unknown) {
        console.warn('Could not set alarm state:', alarmErr);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message:
            `Triggered 20 async invocations to ${demoLambda} and set alarm to ALARM.`,
        }),
      };

    } catch (err: unknown) {
      console.error(err);

      const errorMessage =
        err instanceof Error
          ? err.message
          : String(err);

      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: errorMessage,
        }),
      };
    }
  }

  // ── GET /incidents/metrics ──────────────────────────────────────
  // Real CloudWatch data for graphs
  if (
    method === "GET" &&
    path.includes("/metrics")
  ) {
    const functionName =
      event.queryStringParameters
        ?.functionName;

    if (!functionName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error:
            "functionName query param required",
        }),
      };
    }

    try {
      const endTime = new Date();

      const startTime = new Date(
        endTime.getTime() -
        3600_000
      );

      const [
        durationResp,
        throttleResp,
      ] = await Promise.all([

        // P95 duration
        cwClient.send(
          new GetMetricStatisticsCommand({
            Namespace:
              "AWS/Lambda",

            MetricName:
              "Duration",

            Dimensions: [
              {
                Name:
                  "FunctionName",

                Value:
                  functionName,
              },
            ],

            StartTime:
              startTime,

            EndTime:
              endTime,

            Period: 60,

            ExtendedStatistics:
              ["p95"],
          })
        ),

        // Throttles
        cwClient.send(
          new GetMetricStatisticsCommand({
            Namespace:
              "AWS/Lambda",

            MetricName:
              "Throttles",

            Dimensions: [
              {
                Name:
                  "FunctionName",

                Value:
                  functionName,
              },
            ],

            StartTime:
              startTime,

            EndTime:
              endTime,

            Period: 60,

            Statistics:
              ["Sum"],
          })
        ),
      ]);

      // Both metrics are mapped onto the SAME per-minute timeline, and we
      // return raw ISO timestamps (not pre-formatted local-time strings).
      // Formatting time as a string here would bake in the Lambda runtime's
      // timezone (usually UTC), which then silently fails to match anything
      // formatted in the browser's timezone on the frontend (e.g. the
      // "fix applied" marker) — always ship timestamps, format at the edge.
      const bucketKey = (d: Date | string) => new Date(d).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM

      const timeline: Date[] = [];
      for (let ts = startTime.getTime(); ts < endTime.getTime(); ts += 60_000) {
        timeline.push(new Date(ts));
      }

      const durationByBucket = new Map(
        (durationResp.Datapoints || []).map((dp: any) => [
          bucketKey(dp.Timestamp),
          Math.round(dp.ExtendedStatistics?.p95 ?? 0),
        ])
      );
      const throttleByBucket = new Map(
        (throttleResp.Datapoints || []).map((dp: any) => [bucketKey(dp.Timestamp), dp.Sum ?? 0])
      );

      // Duration / P95 data — a minute with no invocations is a real gap
      // (null), not a fake 0ms latency, so it isn't drawn as "instant".
      const durationData = timeline.map((ts) => {
        const key = bucketKey(ts);
        return {
          timestamp: ts.toISOString(),
          latency: durationByBucket.has(key) ? durationByBucket.get(key) : null,
        };
      });

      // Throttle data — a minute with no throttle datapoint genuinely means
      // zero throttles, so 0 is the correct fill (unlike latency above).
      const throttleData = timeline.map((ts) => {
        const key = bucketKey(ts);
        return {
          timestamp: ts.toISOString(),
          throttles: throttleByBucket.has(key) ? throttleByBucket.get(key) : 0,
        };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          functionName,
          durationData,
          throttleData,
        }),
      };

    } catch (err: unknown) {
      console.error(err);

      const errorMessage =
        err instanceof Error
          ? err.message
          : String(err);

      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: errorMessage,
        }),
      };
    }
  }

  // ── Unknown route ────────────────────────────────────────────────

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({
      error:
        "Method not allowed",
    }),
  };
};