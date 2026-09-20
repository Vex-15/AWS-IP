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

      // Sort datapoints chronologically
      const sortByTime = (
        arr: any[]
      ) =>
        arr.sort(
          (
            a: any,
            b: any
          ) =>
            new Date(
              a.Timestamp
            ).getTime() -
            new Date(
              b.Timestamp
            ).getTime()
        );

      // Duration / P95 data
      const durationData =
        sortByTime(
          durationResp.Datapoints || []
        ).map(
          (dp: any) => ({
            time:
              new Date(
                dp.Timestamp
              ).toLocaleTimeString(
                "en-US",
                {
                  hour:
                    "2-digit",

                  minute:
                    "2-digit",
                }
              ),

            latency:
              Math.round(
                dp
                  .ExtendedStatistics
                  ?.p95 ?? 0
              ),
          })
        );

      // Throttle data
      const throttleData =
        sortByTime(
          throttleResp.Datapoints || []
        ).map(
          (dp: any) => ({
            time:
              new Date(
                dp.Timestamp
              ).toLocaleTimeString(
                "en-US",
                {
                  hour:
                    "2-digit",

                  minute:
                    "2-digit",
                }
              ),

            throttles:
              dp.Sum ?? 0,
          })
        );

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