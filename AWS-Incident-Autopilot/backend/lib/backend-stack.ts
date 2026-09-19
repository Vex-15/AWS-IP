import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as path from 'path';

export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── 1. DynamoDB Table ─────────────────────────────────────────────────
    const incidentsTable = new dynamodb.Table(this, 'IncidentsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── 2. DemoSlowLambda — our controlled test incident ─────────────────
    // Delay = 1400ms, memory = 128MB, reserved concurrency = 5.
    // The "fix" the agent should discover: raise concurrency to 50+ (eliminates throttles)
    // and optionally raise memory (won't help much here, but the agent should figure that out).
    const demoSlowLambda = new lambda.Function(this, 'DemoSlowLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const start = Date.now();
  // Simulate slow DB call — 800ms to 1400ms of jitter
  const delay = 800 + Math.floor(Math.random() * 600);
  await new Promise(r => setTimeout(r, delay));
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "OK", durationMs: Date.now() - start })
  };
};
      `),
      handler: 'index.handler',
      functionName: `${this.stackName}-DemoSlowLambda`,
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),

      tracing: lambda.Tracing.ACTIVE, // Enable X-Ray
    });

    // ── 3. AgentCore App — compiled TypeScript Lambda ────────────────────
    // PRE-REQUISITE: Run `cd ../agentcore && npm ci && npm run build` before `cdk deploy`
    // CDK bundles the built dist/ + node_modules from the agentcore directory.
    const agentCoreApp = new lambda.Function(this, 'AgentCoreApp', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../agentcore'), {
        exclude: ['*.ts', 'tsconfig.json', '.git'],
      }),
      handler: 'dist/main.handler',
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        NODE_OPTIONS: '--experimental-vm-modules',
        DEMO_LAMBDA_NAME: demoSlowLambda.functionName,
      },
    });

    // IAM: CloudWatch read (metrics need * resource)
    agentCoreApp.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: [
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:GetMetricData',
      ],
      resources: ['*'],
    }));

    // IAM: X-Ray read (traces need * resource)
    agentCoreApp.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: [
        'xray:GetTraceSummaries',
        'xray:BatchGetTraces',
      ],
      resources: ['*'],
    }));

    // IAM: Logs — scoped to DemoSlowLambda log group
    agentCoreApp.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['logs:FilterLogEvents'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${demoSlowLambda.functionName}:*`,
      ],
    }));

    // IAM: Lambda config — scoped to DemoSlowLambda
    agentCoreApp.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: [
        'lambda:GetFunctionConfiguration',
        'lambda:GetFunctionConcurrency',
        'lambda:UpdateFunctionConfiguration',
        'lambda:PutFunctionConcurrency',
      ],
      resources: [demoSlowLambda.functionArn],
    }));

    // Function URL (AWS_IAM secured)
    const agentCoreUrl = agentCoreApp.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // ── 4. API Handler Lambda ────────────────────────────────────────────
    const apiHandler = new lambda.Function(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'api.handler',
      environment: {
        TABLE_NAME: incidentsTable.tableName,
        DEMO_LAMBDA_NAME: demoSlowLambda.functionName,
      },
    });

    // Let ApiHandler describe alarms and invoke DemoSlowLambda
    apiHandler.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));
    demoSlowLambda.grantInvoke(apiHandler);
    incidentsTable.grantReadWriteData(apiHandler);

    // ── 5. Agent Proxy Lambda ────────────────────────────────────────────
    // Uses Lambda Invoke (SDK) to call AgentCore — simpler than Function URL + SigV4
    const agentHandler = new lambda.Function(this, 'AgentHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'agent.handler',
      environment: {
        TABLE_NAME: incidentsTable.tableName,
        AGENT_CORE_ENDPOINT: agentCoreUrl.url,
        AGENT_CORE_FUNCTION_NAME: agentCoreApp.functionName,
      },
      timeout: cdk.Duration.seconds(300),
    });

    agentCoreApp.grantInvoke(agentHandler);
    incidentsTable.grantReadWriteData(agentHandler);

    // ── 6. API Gateway ───────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'IncidentAutopilotApi', {
      restApiName: 'Incident Autopilot Service',
      description: 'API for AWS Incident Autopilot',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const incidentsIntegration = new apigateway.LambdaIntegration(apiHandler);
    const agentIntegration = new apigateway.LambdaIntegration(agentHandler);

    // GET /incidents — list active CloudWatch alarms
    const incidents = api.root.addResource('incidents');
    incidents.addMethod('GET', incidentsIntegration);

    // POST /incidents/trigger — fire 20 invocations at DemoSlowLambda
    const trigger = incidents.addResource('trigger');
    trigger.addMethod('POST', incidentsIntegration);

    // GET /incidents/metrics?functionName=X — fetch real CloudWatch data for graphs
    const metrics = incidents.addResource('metrics');
    metrics.addMethod('GET', incidentsIntegration);

    // POST /agent — proxy to AgentCore
    const agent = api.root.addResource('agent');
    agent.addMethod('POST', agentIntegration);

    // ── 7. CloudWatch Alarm ──────────────────────────────────────────────
    const latencyAlarm = new cloudwatch.Alarm(this, 'DemoSlowLambdaLatencyAlarm', {
      metric: demoSlowLambda.metricDuration({
        statistic: 'p95',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1000,
      evaluationPeriods: 1,
      alarmName: `DemoSlowLambda-HighLatency`,
      alarmDescription: `P95 latency > 1s for ${demoSlowLambda.functionName}`,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // ── Outputs ──────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });
    new cdk.CfnOutput(this, 'DemoLambdaName', {
      value: demoSlowLambda.functionName,
      description: 'Name of the demo Lambda for testing',
    });
  }
}
