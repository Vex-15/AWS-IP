import { Agent } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import {
  getMetricsTool,
  queryLogsTool,
  getTracesTool,
  getLambdaConfigTool,
  applyFixTool,
  verifyRecoveryTool,
} from './tools.js';

const SYSTEM_PROMPT = `You are AWS Incident Autopilot — an autonomous AI SRE agent.

You have six tools. You MUST use them to gather real evidence. NEVER invent metrics or guess.

## Investigation Flow
1. **Gather Metrics**: Call getMetrics with namespace AWS/Lambda for Duration (useP95=true), Throttles, Errors, ConcurrentExecutions.
2. **Query Logs**: Call queryLogs on /aws/lambda/<functionName> for "ERROR", "Timeout", "Throttl".
3. **Get Traces**: Call getTraces to see X-Ray trace durations, errors, and throttle flags.
4. **Get Config**: Call getLambdaConfig to see current MemorySize, Timeout, ReservedConcurrentExecutions.
5. **Root Cause**: Based on ALL evidence above, determine the root cause. Be specific: cite the actual metric values.
6. **Propose Fix**: State exactly what configuration change you recommend and why, based on the evidence.

## Fix & Verify Flow (only when user says "apply" or "approve")
7. **Apply Fix**: Call applyFix with the exact parameters (memorySize and/or reservedConcurrency).
8. **Verify Recovery**: Call verifyRecovery which waits ~60s then re-checks CloudWatch. Report the before/after comparison and whether the incident is truly resolved.

IMPORTANT RULES:
- You MUST call tools. Do not fabricate data.
- Report real numbers from real CloudWatch/X-Ray responses.
- When proposing a fix, explain the specific values you want to change and why.
- NEVER apply a fix without the user explicitly saying "approve" or "apply".
`;

const tools = [
  getMetricsTool,
  queryLogsTool,
  getTracesTool,
  getLambdaConfigTool,
  applyFixTool,
  verifyRecoveryTool,
];

function createModel(): BedrockModel {
  return new BedrockModel({
    modelId: 'us.amazon.nova-lite-v1:0',
    region: 'us-east-1',
  });
}

// Session cache for conversational continuity within the same Lambda container
const sessionAgents = new Map<string, Agent>();

function getAgent(sessionId: string): Agent {
  let agent = sessionAgents.get(sessionId);
  if (!agent) {
    agent = new Agent({
      model: createModel(),
      systemPrompt: SYSTEM_PROMPT,
      tools,
    });
    sessionAgents.set(sessionId, agent);
  }
  return agent;
}

// ─── Lambda Handler ──────────────────────────────────────────────────────────
export const handler = async (event: any) => {
  let body: any;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event;
  } catch {
    body = event;
  }

  const prompt = body.prompt ?? 'No prompt provided.';
  const sessionId = body.sessionId ?? 'default';

  console.log(`[AgentCore] session=${sessionId} prompt="${prompt.slice(0, 120)}"`);

  const agent = getAgent(sessionId);

  try {
    let fullResponse = '';
    for await (const evt of agent.stream(prompt)) {
      if (
        evt.type === 'modelStreamUpdateEvent' &&
        evt.event?.type === 'modelContentBlockDeltaEvent' &&
        evt.event.delta?.type === 'textDelta'
      ) {
        fullResponse += evt.event.delta.text;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ agentResponse: fullResponse }),
    };
  } catch (err: any) {
    console.error('[AgentCore] Error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
