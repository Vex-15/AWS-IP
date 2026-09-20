import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class BackendStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    // ================================================================
    // 1. DYNAMODB
    // ================================================================

    const incidentsTable = new dynamodb.Table(this, 'IncidentsTable', {
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ================================================================
    // 2. DEMO / CONTROLLED LAMBDA
    // ================================================================

    // IMPORTANT:
    // Do NOT set reservedConcurrentExecutions here.
    //
    // Your AWS account currently has only 10 total concurrency and AWS
    // requires 10 unreserved concurrency. Reserving even 1 can therefore
    // cause deployment failure.

    const demoSlowLambda = new lambda.Function(this, 'DemoSlowLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,

      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const start = Date.now();

  // CPU-intensive: prime sieve via trial division.
  // Lambda allocates CPU proportional to memory:
  //   128 MB  (~0.07 vCPU) → ~1200-1500ms  (breaches P95 > 1000ms alarm)
  //   256 MB  (~0.15 vCPU) → ~600-750ms    (below threshold)
  //   512 MB  (~0.29 vCPU) → ~300-400ms    (well below)
  // The CORRECT fix is to increase MemorySize, not concurrency.
  const LIMIT = 120000;
  let primes = 0;
  for (let n = 2; n <= LIMIT; n++) {
    let isPrime = true;
    for (let d = 2; d * d <= n; d++) {
      if (n % d === 0) { isPrime = false; break; }
    }
    if (isPrime) primes++;
  }

  const durationMs = Date.now() - start;
  console.log(JSON.stringify({
    durationMs,
    primes,
    memoryMB: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "OK",
      durationMs,
      primesFound: primes,
      memoryMB: parseInt(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE || "0"),
    })
  };
};
      `),

      handler: 'index.handler',

      functionName: `${this.stackName}-DemoSlowLambda`,

      memorySize: 128,

      timeout: cdk.Duration.seconds(10),

      tracing: lambda.Tracing.ACTIVE,
    });

    // ================================================================
    // 3. AGENTCORE APP
    // ================================================================

    const agentCoreApp = new lambdaNodejs.NodejsFunction(this, 'AgentCoreApp', {
      runtime: lambda.Runtime.NODEJS_22_X,

      entry: path.join(
        __dirname,
        '../../agentcore/main.ts'
      ),
      projectRoot: path.join(__dirname, '../../agentcore'),
      depsLockFilePath: path.join(__dirname, '../../agentcore/package-lock.json'),

      handler: 'handler',

      timeout: cdk.Duration.seconds(300),

      memorySize: 1024,

      environment: {
        NODE_OPTIONS: '--experimental-vm-modules',
        DEMO_LAMBDA_NAME: demoSlowLambda.functionName,
      },

      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: [], // Force bundle @aws-sdk/* and @smithy/*
      },
    });

    // ================================================================
    // AGENTCORE IAM — CLOUDWATCH
    // ================================================================

    agentCoreApp.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudwatch:GetMetricStatistics',
          'cloudwatch:GetMetricData',
        ],
        resources: ['*'],
      }),
    );

    // ================================================================
    // AGENTCORE IAM — X-RAY
    // ================================================================

    agentCoreApp.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'xray:GetTraceSummaries',
          'xray:BatchGetTraces',
        ],
        resources: ['*'],
      }),
    );

    // ================================================================
    // AGENTCORE IAM — CLOUDWATCH LOGS
    // ================================================================

    agentCoreApp.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:FilterLogEvents',
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${demoSlowLambda.functionName}:*`,
        ],
      }),
    );

    // ================================================================
    // AGENTCORE IAM — LAMBDA CONFIGURATION
    // ================================================================

    agentCoreApp.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'lambda:GetFunctionConfiguration',
          'lambda:GetFunctionConcurrency',
          'lambda:UpdateFunctionConfiguration',
          'lambda:PutFunctionConcurrency',
        ],
        resources: [
          demoSlowLambda.functionArn,
        ],
      }),
    );

    // GetAccountSettings requires * resource
    agentCoreApp.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:GetAccountSettings'],
        resources: ['*'],
      }),
    );

    // ================================================================
    // AGENTCORE IAM — BEDROCK
    // ================================================================

    // Allows AgentCoreApp to invoke Amazon Nova Lite.
    //
    // Using "*" here avoids inference-profile / cross-region resource
    // mismatches while getting the hackathon system working.
    //
    // The error you received specifically requires:
    // bedrock:InvokeModelWithResponseStream

    agentCoreApp.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,

        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:GetInferenceProfile',
        ],

        resources: ['*'],
      }),
    );

    // ================================================================
    // 4. AGENTCORE FUNCTION URL
    // ================================================================

    const agentCoreUrl = agentCoreApp.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // ================================================================
    // 5. API HANDLER
    // ================================================================

    // NodejsFunction bundles the TypeScript source with esbuild.
    // This prevents:
    //
    // "Cannot use import statement outside a module"

    const apiHandler = new lambdaNodejs.NodejsFunction(
      this,
      'ApiHandler',
      {
        runtime: lambda.Runtime.NODEJS_22_X,

        entry: path.join(
          __dirname,
          '../lambda/api.ts',
        ),

        handler: 'handler',

        environment: {
          TABLE_NAME: incidentsTable.tableName,
          DEMO_LAMBDA_NAME: demoSlowLambda.functionName,
        },

        bundling: {
          minify: true,
          sourceMap: false,
          externalModules: [],
        },
      },
    );

    // ================================================================
    // API HANDLER IAM
    // ================================================================

    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudwatch:DescribeAlarms',
          'cloudwatch:GetMetricStatistics',
          'cloudwatch:GetMetricData',
          'cloudwatch:SetAlarmState',
        ],
        resources: ['*'],
      }),
    );

    // Allow API handler to invoke DemoSlowLambda.
    demoSlowLambda.grantInvoke(apiHandler);

    // DynamoDB access.
    incidentsTable.grantReadWriteData(apiHandler);

    // ================================================================
    // 6. AGENT PROXY HANDLER
    // ================================================================

    const agentHandler = new lambdaNodejs.NodejsFunction(
      this,
      'AgentHandler',
      {
        runtime: lambda.Runtime.NODEJS_22_X,

        entry: path.join(
          __dirname,
          '../lambda/agent.ts',
        ),

        handler: 'handler',

        timeout: cdk.Duration.seconds(300),

        environment: {
          TABLE_NAME: incidentsTable.tableName,

          AGENT_CORE_ENDPOINT: agentCoreUrl.url,

          AGENT_CORE_FUNCTION_NAME:
            agentCoreApp.functionName,
        },

        bundling: {
          minify: true,
          sourceMap: false,
          externalModules: [],
        },
      },
    );

    // Allow proxy to invoke AgentCore Lambda.
    agentCoreApp.grantInvoke(agentHandler);

    // Allow agent handler to invoke ITSELF asynchronously
    // (async worker pattern to avoid 29s API Gateway timeout).
    // Using explicit policy to avoid circular dependency from grantInvoke(self).
    agentHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: ['*'],
      }),
    );

    // DynamoDB access.
    incidentsTable.grantReadWriteData(agentHandler);

    // ================================================================
    // 7. API GATEWAY
    // ================================================================

    const api = new apigateway.RestApi(
      this,
      'IncidentAutopilotApi',
      {
        restApiName: 'Incident Autopilot Service',

        description:
          'API for AWS Incident Autopilot',

        defaultCorsPreflightOptions: {
          allowOrigins:
            apigateway.Cors.ALL_ORIGINS,

          allowMethods:
            apigateway.Cors.ALL_METHODS,

          allowHeaders: [
            'Content-Type',
            'Authorization',
          ],
        },
      },
    );

    const incidentsIntegration =
      new apigateway.LambdaIntegration(
        apiHandler,
      );

    const agentIntegration =
      new apigateway.LambdaIntegration(
        agentHandler,
      );

    // ================================================================
    // GET /incidents
    // ================================================================

    const incidents =
      api.root.addResource('incidents');

    incidents.addMethod(
      'GET',
      incidentsIntegration,
    );

    // ================================================================
    // POST /incidents/trigger
    // ================================================================

    const trigger =
      incidents.addResource('trigger');

    trigger.addMethod(
      'POST',
      incidentsIntegration,
    );

    // ================================================================
    // GET /incidents/metrics
    // ================================================================

    const metrics =
      incidents.addResource('metrics');

    metrics.addMethod(
      'GET',
      incidentsIntegration,
    );

    // ================================================================
    // POST /agent
    // ================================================================

    const agent =
      api.root.addResource('agent');

    agent.addMethod(
      'POST',
      agentIntegration,
    );

    // ================================================================
    // 8. CLOUDWATCH ALARM
    // ================================================================

    new cloudwatch.Alarm(
      this,
      'DemoSlowLambdaLatencyAlarm',
      {
        metric:
          demoSlowLambda.metricDuration({
            statistic: 'p95',
            period:
              cdk.Duration.minutes(1),
          }),

        threshold: 1000,

        evaluationPeriods: 1,

        alarmName:
          'DemoSlowLambda-HighLatency',

        alarmDescription:
          `P95 latency > 1s for ${demoSlowLambda.functionName}`,

        comparisonOperator:
          cloudwatch.ComparisonOperator
            .GREATER_THAN_THRESHOLD,

        treatMissingData:
          cloudwatch.TreatMissingData.IGNORE,
      },
    );

    // ================================================================
    // 9. CLOUDFORMATION OUTPUTS
    // ================================================================

    new cdk.CfnOutput(
      this,
      'ApiUrl',
      {
        value: api.url,

        description:
          'API Gateway URL',
      },
    );

    new cdk.CfnOutput(
      this,
      'DemoLambdaName',
      {
        value:
          demoSlowLambda.functionName,

        description:
          'Name of the demo Lambda',
      },
    );

    new cdk.CfnOutput(
      this,
      'AgentCoreFunctionName',
      {
        value:
          agentCoreApp.functionName,

        description:
          'AgentCore Lambda function name',
      },
    );
  }
}