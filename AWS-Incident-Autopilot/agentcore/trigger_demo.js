import { LambdaClient, InvokeCommand, ListFunctionsCommand } from '@aws-sdk/client-lambda';

// This script triggers the demo incident manually by invoking the DemoSlowLambda 20 times.
// Run it via: node trigger_demo.js

const lambdaClient = new LambdaClient({});

async function triggerIncident() {
  console.log("🔍 Looking for DemoSlowLambda...");
  
  let demoLambdaName = process.env.DEMO_LAMBDA_NAME;

  if (!demoLambdaName) {
    try {
      const response = await lambdaClient.send(new ListFunctionsCommand({}));
      const funcs = response.Functions || [];
      const demoFunc = funcs.find(f => f.FunctionName && f.FunctionName.includes('DemoSlowLambda'));
      
      if (demoFunc) {
        demoLambdaName = demoFunc.FunctionName;
        console.log(`✅ Found DemoSlowLambda: ${demoLambdaName}`);
      } else {
        console.error("❌ Could not find a Lambda function containing 'DemoSlowLambda' in the name.");
        console.log("Make sure you have deployed the backend stack first.");
        process.exit(1);
      }
    } catch (err) {
      console.error("❌ Failed to list Lambda functions:", err.message);
      process.exit(1);
    }
  }

  console.log(`🚀 Firing 20 concurrent invocations to ${demoLambdaName} to trigger the CloudWatch latency alarm...`);
  
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(
      lambdaClient.send(new InvokeCommand({
        FunctionName: demoLambdaName,
        InvocationType: 'Event', // Async invocation
      })).then(() => {
        process.stdout.write('⚡');
      }).catch((err) => {
        process.stdout.write('❌');
      })
    );
  }

  await Promise.all(promises);
  console.log("\n\n✅ Successfully triggered invocations!");
  console.log("⏱️ Wait about 1-2 minutes for the CloudWatch alarm to trigger and show up on the dashboard.");
}

triggerIncident();
