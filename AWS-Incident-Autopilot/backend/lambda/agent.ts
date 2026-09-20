const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const lambdaClient = new LambdaClient({});
const ddbClient = new DynamoDBClient({});

exports.handler = async (event: any) => {
  let body: any;

  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    body = {};
  }

  const { prompt, sessionId, action } = body;
  const tableName = process.env.TABLE_NAME;

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
  };

  // ── POLL: GET status of an async agent invocation ──
  if (action === "poll" && sessionId) {
    try {
      const result = await ddbClient.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { id: { S: `agent-${sessionId}` } },
        })
      );

      if (!result.Item) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ status: "running" }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: result.Item.status?.S || "running",
          agentResponse: result.Item.agentResponse?.S || null,
          error: result.Item.error?.S || null,
        }),
      };
    } catch (err: unknown) {
      console.error("Poll error:", err);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Failed to poll status" }),
      };
    }
  }

  // ── INVOKE: Start async agent invocation ──
  const functionName = process.env.AGENT_CORE_FUNCTION_NAME;

  if (!functionName) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "AGENT_CORE_FUNCTION_NAME not set" }),
    };
  }

  // Generate a job ID for tracking
  const jobId = sessionId || `job-${Date.now()}`;

  // Write initial "running" status to DynamoDB
  try {
    await ddbClient.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          id: { S: `agent-${jobId}` },
          status: { S: "running" },
          prompt: { S: prompt || "No prompt" },
          startedAt: { S: new Date().toISOString() },
        },
      })
    );
  } catch (err) {
    console.error("Failed to write initial status:", err);
  }

  // Invoke AgentCore synchronously within THIS Lambda (5-min timeout).
  // API Gateway will get an immediate response, and the actual work
  // happens in a SEPARATE async invocation of this same handler.

  // Check if this is the "worker" invocation (not from API Gateway)
  if (event._isWorker) {
    // This is the async worker — do the actual agent work
    try {
      const payload = JSON.stringify({
        prompt: event._prompt || "Investigate DemoSlowLambda incident",
        sessionId: event._jobId || "default",
      });

      const invokeResp = await lambdaClient.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "RequestResponse",
          Payload: payload,
        })
      );

      const responsePayload = JSON.parse(
        new TextDecoder().decode(invokeResp.Payload)
      );

      let agentBody: any;
      try {
        agentBody =
          typeof responsePayload.body === "string"
            ? JSON.parse(responsePayload.body)
            : responsePayload;
      } catch {
        agentBody = responsePayload;
      }

      const agentResponse =
        agentBody.agentResponse ||
        agentBody.error ||
        JSON.stringify(agentBody);

      // Write result to DynamoDB
      await ddbClient.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            id: { S: `agent-${event._jobId}` },
            status: { S: agentBody.error ? "error" : "done" },
            agentResponse: { S: agentResponse },
            completedAt: { S: new Date().toISOString() },
          },
        })
      );

      return { statusCode: 200 };
    } catch (err: unknown) {
      console.error("Worker error:", err);
      const errorMessage =
        err instanceof Error ? err.message : String(err);

      await ddbClient.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            id: { S: `agent-${event._jobId}` },
            status: { S: "error" },
            error: { S: errorMessage },
            completedAt: { S: new Date().toISOString() },
          },
        })
      ).catch(() => {});

      return { statusCode: 500 };
    }
  }

  // ── API Gateway path: Kick off async worker, return immediately ──
  try {
    // Get OUR function name to self-invoke
    const selfFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: selfFunctionName,
        InvocationType: "Event", // Async — returns immediately
        Payload: JSON.stringify({
          _isWorker: true,
          _prompt: prompt || "Investigate DemoSlowLambda incident",
          _jobId: jobId,
        }),
      })
    );

    return {
      statusCode: 202,
      headers,
      body: JSON.stringify({
        status: "accepted",
        jobId: jobId,
        message: "Agent investigation started. Poll for results.",
      }),
    };
  } catch (err: unknown) {
    console.error("Failed to start agent:", err);
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Failed to start agent: " + errorMessage,
      }),
    };
  }
};