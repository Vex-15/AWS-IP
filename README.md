# 🚨 AWS Incident Autopilot

An **Agentic AI SRE** for AWS that autonomously detects incidents from real CloudWatch alarms, investigates live infrastructure telemetry (CloudWatch Metrics, Logs, X-Ray Traces), identifies evidence-backed root causes, proposes fixes, and — upon human approval — applies real configuration changes and verifies recovery.

## Architecture

```
┌──────────────┐     GET /incidents        ┌─────────────────┐
│              │     POST /incidents/trigger│                 │
│  React/Vite  │◄───GET /incidents/metrics──►  API Gateway    │
│  Dashboard   │     POST /agent           │                 │
└──────────────┘                           └────────┬────────┘
                                                    │
                                    ┌───────────────┼───────────────┐
                                    ▼                               ▼
                            ┌──────────────┐              ┌──────────────┐
                            │  ApiHandler  │              │ AgentHandler │
                            │  Lambda      │              │ Lambda       │
                            │              │              │ (proxy)      │
                            └──────┬───────┘              └──────┬───────┘
                                   │                             │
                    ┌──────────────┤                    Lambda.Invoke
                    ▼              ▼                             │
            ┌─────────────┐ ┌───────────┐              ┌────────▼───────┐
            │ CloudWatch  │ │ DemoSlow  │              │  AgentCore     │
            │ DescribeAlarms│ Lambda    │              │  Lambda        │
            │ GetMetrics  │ │ (invoke)  │              │  (Strands SDK) │
            └─────────────┘ └───────────┘              └────────┬───────┘
                                                                │
                                                   ┌────────────┼────────────┐
                                                   ▼            ▼            ▼
                                            ┌──────────┐ ┌──────────┐ ┌──────────┐
                                            │CloudWatch│ │  X-Ray   │ │  Lambda  │
                                            │Metrics+  │ │  Traces  │ │  Config  │
                                            │Logs      │ │          │ │  + Apply │
                                            └──────────┘ └──────────┘ └──────────┘
```

## Agent Tools (AWS SDK v3)

| Tool | What it does |
|------|-------------|
| `getMetrics` | CloudWatch `GetMetricStatistics` with proper `ExtendedStatistics: ['p95']` |
| `queryLogs` | CloudWatch Logs `FilterLogEvents` for errors/timeouts |
| `getTraces` | X-Ray `GetTraceSummaries` filtered by function name |
| `getLambdaConfig` | `GetFunctionConfiguration` + `GetFunctionConcurrency` |
| `applyFix` | `UpdateFunctionConfiguration` + `PutFunctionConcurrency` |
| `verifyRecovery` | Waits 60s → re-queries CloudWatch → returns RECOVERED/NOT_RECOVERED |

## Demo Flow

```
1. Trigger Demo Incident  →  20 async invocations to DemoSlowLambda
2. CloudWatch Alarm fires  →  p95 > 1000ms threshold breached
3. Click alarm in dashboard  →  Agent investigates (real telemetry)
4. Agent reports evidence + root cause + proposed fix
5. Click "Propose Fix"  →  Agent explains specific config changes
6. Click "Approve & Apply Fix"  →  Agent calls applyFix + verifyRecovery
7. Agent waits 60s, re-queries metrics, reports RECOVERED/NOT_RECOVERED
```

## Deployment

### Prerequisites
- AWS CLI configured with credentials
- Node.js 20+
- AWS CDK (`npm install -g aws-cdk`)

### 1. Build AgentCore
```bash
cd agentcore
npm install
npm run build
```

### 2. Deploy Infrastructure
```bash
cd backend
npm install
npx aws-cdk bootstrap   # first time only
npx aws-cdk deploy
```

Copy the `ApiUrl` output from the deploy.

### 3. Configure & Run Frontend
```bash
cd frontend
echo "VITE_API_URL=https://<your-api-id>.execute-api.<region>.amazonaws.com/prod" > .env
npm install
npm run dev
```

## Project Structure

```
AWS-Incident-Autopilot/
├── agentcore/                 # Strands Agent + MCP tools (TypeScript)
│   ├── main.ts                # Lambda handler with Agent + system prompt
│   ├── tools.ts               # 6 AWS SDK v3 tools
│   ├── tsconfig.json
│   └── package.json
├── backend/                   # AWS CDK infrastructure
│   ├── lib/backend-stack.ts   # All AWS resources
│   ├── lambda/
│   │   ├── api.js             # GET /incidents, POST /trigger, GET /metrics
│   │   └── agent.js           # POST /agent → Lambda.Invoke → AgentCore
│   └── test/backend.test.ts
├── frontend/                  # React + Vite dashboard
│   └── src/App.jsx            # Real-time CloudWatch graphs + agent flow
└── README.md
```
