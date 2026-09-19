import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as Backend from '../lib/backend-stack';

test('DemoSlowLambda is created with correct config', () => {
  const app = new cdk.App();
  const stack = new Backend.BackendStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  // DemoSlowLambda should have 128MB memory and X-Ray active tracing
  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    MemorySize: 128,
    TracingConfig: { Mode: 'Active' },
  });
});

test('CloudWatch Alarm is created for latency', () => {
  const app = new cdk.App();
  const stack = new Backend.BackendStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Threshold: 1000,
    EvaluationPeriods: 1,
  });
});

test('API Gateway is created', () => {
  const app = new cdk.App();
  const stack = new Backend.BackendStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    Name: 'Incident Autopilot Service',
  });
});
