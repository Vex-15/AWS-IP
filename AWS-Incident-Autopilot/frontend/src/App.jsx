import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import {
  ShieldAlert, TriangleAlert, CheckCircle2, ServerCog, Cpu,
  CheckCircle, XCircle, Info, Loader2, Radio, Zap, TrendingDown,
} from 'lucide-react';
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area,
  BarChart, Bar, CartesianGrid, ReferenceLine,
} from 'recharts';
import './index.css';

const AgentTopology = lazy(() => import('./components/AgentTopology.jsx'));

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

// Single source of truth for turning a timestamp into the "2:47 PM"-style
// label used on the metrics charts AND the "fix applied" marker. The backend
// sends raw ISO timestamps for exactly this reason — formatting must happen
// once, here, in the viewer's own timezone, or the chart's x-axis labels and
// the reference line (matched by exact string equality) silently drift apart
// whenever the Lambda's runtime timezone differs from the browser's.
const formatChartTime = (isoOrDate) => {
  if (!isoOrDate) return 'Invalid Date';
  let d = new Date(isoOrDate);
  if (isNaN(d.valueOf()) && !isNaN(Number(isoOrDate))) {
    d = new Date(Number(isoOrDate));
  }
  return isNaN(d.valueOf()) ? 'Invalid Date' : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
};

// The agent's real workflow, always in this order. Used to render the
// stepper and to figure out which stage the current incident is in.
const STEPS = [
  { key: 'detected', label: 'Detected' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'root-cause', label: 'Root cause' },
  { key: 'fix-proposed', label: 'Fix proposed' },
  { key: 'applying', label: 'Applying' },
  { key: 'verified', label: 'Verified' },
];

// ── Structured Agent Response Parser ──────────────────────────────────────
function parseAgentResponse(text) {
  if (!text) return { sections: {}, isInsufficient: false, rawText: '' };

  // Strip <thinking>...</thinking> tags (including multiline)
  const cleanText = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();

  // Extract named sections by ### headers
  const sectionRegex = /### ([\w\s]+)\n([\s\S]*?)(?=### |\s*$)/g;
  const sections = {};
  let match;
  while ((match = sectionRegex.exec(cleanText)) !== null) {
    const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
    sections[key] = match[2].trim();
  }

  // Handle old agent format gracefully so the new UI still works for old payloads
  if (sections.evidence_summary && !sections.evidence) {
    sections.evidence = sections.evidence_summary;
  }
  if (sections.proposed_fix && !sections.recommended_action) {
    sections.recommended_action = sections.proposed_fix;
  }

  // Determine if evidence is insufficient based on keywords
  const isInsufficient = /insufficient evidence/i.test(cleanText) || /insufficient/i.test(sections.root_cause || '');

  // Parse bullet items from a section string
  const parseBullets = (str) =>
    str ? str.split('\n').map(l => l.trim()).filter(l => /^[-•]/.test(l)).map(l => l.replace(/^[-•]\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1')) : [];

  // Parse numbered items
  const parseNumbered = (str) =>
    str ? str.split('\n').map(l => l.trim()).filter(l => /^\d+\./.test(l)).map(l => l.replace(/^\d+\.\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1')) : [];

  // Extract confidence percentage or level
  const confidenceMatch = (sections.root_cause || '').match(/Confidence:\s*(High|Medium|Low|\d+%?)/i);
  let confidence = null;
  let confidenceStr = '';
  if (confidenceMatch) {
    const val = confidenceMatch[1].replace('%', '');
    if (val.toLowerCase() === 'high') confidence = 90;
    else if (val.toLowerCase() === 'medium') confidence = 50;
    else if (val.toLowerCase() === 'low') confidence = 20;
    else confidence = parseInt(val, 10);
    confidenceStr = confidenceMatch[1];
  }

  // Extract root cause headline (skip confidence/alternative lines)
  const rootCauseLines = (sections.root_cause || '').split('\n').filter(l => l.trim() && !/Confidence:/i.test(l) && !/Alternative explanation/i.test(l));
  const rootCauseHeadline = rootCauseLines.length > 0
    ? rootCauseLines.join(' ').replace(/\*\*(.*?)\*\*/g, '$1').trim()
    : '';

  // Extract incident info
  const lambdaMatch = (sections.incident || '').match(/Lambda:\s*(.+)/i);
  const symptomMatch = (sections.incident || '').match(/Symptom:\s*(.+)/i);

  // Extract risk level
  const riskMatch = (sections.risk || '').match(/^(Low|Medium|High)\s*[—–-]\s*(.+)/i);

  // Parse recommended action: separate description from experiment steps
  const actionText = sections.recommended_action || '';
  const experimentIdx = actionText.search(/Proposed experiment:/i);
  const actionDescription = experimentIdx >= 0 ? actionText.slice(0, experimentIdx).trim() : actionText;
  const experimentSteps = experimentIdx >= 0
    ? actionText.slice(experimentIdx).split('\n').filter(l => /^[-•→]/.test(l.trim())).map(l => l.trim().replace(/^[-•→]\s*/, ''))
    : [];

  return {
    sections,
    isInsufficient,
    rawText: cleanText,
    incident: {
      lambda: lambdaMatch ? lambdaMatch[1].trim() : null,
      symptom: symptomMatch ? symptomMatch[1].trim() : null,
    },
    configuration: parseBullets(sections.configuration),
    evidence: parseBullets(sections.evidence),
    rootCauseHeadline,
    confidenceStr,
    why: parseNumbered(sections.why),
    actionDescription,
    experimentSteps,
    expectedResult: parseBullets(sections.expected_result),
    risk: riskMatch ? { level: riskMatch[1], reason: riskMatch[2].trim() } : null,
  };
}

// ── Polished Case File Renderer ──────────────────────────────────────────
function CaseFileText({ text }) {
  if (!text) return null;
  const parsed = parseAgentResponse(text);

  // Fallback: if we couldn't extract any sections, render clean paragraphs
  if (!parsed.rootCauseHeadline && !parsed.evidence.length && !parsed.sections.root_cause) {
    // Strip thinking tags even in fallback
    const clean = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').replace(/### /g, '').replace(/\*\*(.*?)\*\*/g, '$1').trim();
    return (
      <div className="case-file">
        {clean.split('\n\n').filter(Boolean).map((para, i) => (
          <p key={i} className="rca-body-text">{para.trim()}</p>
        ))}
      </div>
    );
  }

  const riskClass = parsed.risk
    ? parsed.risk.level.toLowerCase() === 'low' ? 'risk-low'
      : parsed.risk.level.toLowerCase() === 'medium' ? 'risk-med'
        : 'risk-high'
    : '';

  return (
    <div className="case-file rca-layout">
      {/* Incident */}
      {parsed.incident.lambda && (
        <div className="rca-section rca-incident">
          <div className="case-file-heading">Incident</div>
          <div className="rca-kv-list">
            <div className="rca-kv"><span className="rca-kv-key">Lambda</span><span className="rca-kv-val rca-mono">{parsed.incident.lambda}</span></div>
            {parsed.incident.symptom && (
              <div className="rca-kv"><span className="rca-kv-key">Symptom</span><span className="rca-kv-val">{parsed.incident.symptom}</span></div>
            )}
          </div>
        </div>
      )}

      {/* Configuration */}
      {parsed.configuration.length > 0 && (
        <div className="rca-section rca-config">
          <div className="case-file-heading">Configuration</div>
          <div className="rca-config-grid">
            {parsed.configuration.map((item, i) => {
              const colonIdx = item.indexOf(':');
              const label = colonIdx >= 0 ? item.slice(0, colonIdx).trim() : item;
              const val = colonIdx >= 0 ? item.slice(colonIdx + 1).trim() : '';
              return (
                <div className="rca-config-item" key={i}>
                  <span className="rca-config-label">{label}</span>
                  <span className="rca-config-value">{val || '—'}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Evidence */}
      {parsed.evidence.length > 0 && (
        <div className="rca-section rca-evidence">
          <div className="case-file-heading">Evidence</div>
          <ul className="rca-evidence-list">
            {parsed.evidence.map((item, i) => {
              const noData = /\b0\b|None|No traces|NO DATAPOINTS|zero matches|zero traces|no signal/i.test(item) || parsed.isInsufficient;
              return (
                <li className={`rca-evidence-row ${noData ? 'is-warn' : ''}`} key={i}>
                  <span className="rca-evidence-icon">
                    {noData ? <TriangleAlert size={13} /> : <CheckCircle2 size={13} />}
                  </span>
                  <span className="rca-evidence-text">{item}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Root Cause */}
      {parsed.rootCauseHeadline && (
        <div className="rca-section rca-root-cause">
          <div className="rca-root-cause-header">
            <div className="case-file-heading">Root Cause</div>
            {parsed.confidence !== null && (
              <div className="rca-confidence-badge">
                <svg viewBox="0 0 36 36" className="rca-confidence-ring">
                  <circle cx="18" cy="18" r="15.5" className="rca-conf-track" />
                  <circle cx="18" cy="18" r="15.5" className="rca-conf-fill"
                    strokeDasharray={`${parsed.confidence} ${100 - parsed.confidence}`}
                    strokeDashoffset="25"
                  />
                </svg>
                <span className="rca-confidence-num">{parsed.confidenceStr}</span>
              </div>
            )}
          </div>
          <p className="rca-root-cause-text">{parsed.rootCauseHeadline}</p>
        </div>
      )}

      {/* Why */}
      {parsed.why.length > 0 && (
        <div className="rca-section rca-why">
          <div className="case-file-heading">Why</div>
          <ol className="rca-why-list">
            {parsed.why.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Recommended Action */}
      {parsed.actionDescription && (
        <div className="rca-section rca-action">
          <div className="case-file-heading">Recommended Action</div>
          <p className="rca-body-text">{parsed.actionDescription}</p>
          {parsed.experimentSteps.length > 0 && (
            <div className="rca-experiment">
              <div className="rca-experiment-label">Proposed experiment</div>
              {parsed.experimentSteps.map((step, i) => (
                <div className="rca-experiment-step" key={i}>
                  <span className="rca-step-arrow">→</span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Expected Result */}
      {parsed.expectedResult.length > 0 && (
        <div className="rca-section rca-expected">
          <div className="case-file-heading">Expected Result</div>
          <div className="rca-expected-list">
            {parsed.expectedResult.map((item, i) => {
              const isDown = /↓|decrease|drop|reduce/i.test(item);
              const isUp = /↑|increase/i.test(item);
              return (
                <div className={`rca-expected-item ${isDown ? 'is-good' : isUp ? 'is-bad' : ''}`} key={i}>
                  <span className="rca-expected-arrow">{isDown ? '↓' : isUp ? '↑' : '→'}</span>
                  <span>{item.replace(/[↓↑→]/g, '').trim()}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Risk */}
      {parsed.risk && (
        <div className="rca-section rca-risk">
          <div className="case-file-heading">Risk</div>
          <div className="rca-risk-row">
            <span className={`rca-risk-badge ${riskClass}`}>{parsed.risk.level}</span>
            <span className="rca-risk-reason">{parsed.risk.reason}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Looks for lines like "memorySize: 128MB -> 512MB" in the agent's fix
// proposal. Returns real diff rows straight from the agent's own words —
// never invented values — or null if the text isn't shaped that way.
function extractDiffRows(text) {
  if (!text) return null;
  const rows = [];
  text.split('\n').forEach(line => {
    const cleanLine = line.trim().replace(/\*/g, '');
    const m = cleanLine.match(/^[-]*\s*([^:]+?)\s*[:\-]\s*(.*?)\s*(?:→|->)\s*(.+)$/);
    if (m && m[2] && m[3]) {
      rows.push({ key: m[1].trim(), from: m[2].trim(), to: m[3].trim() });
    }
  });
  return rows.length ? rows : null;
}

function AgentStepper({ stepIndex, resolved }) {
  return (
    <div className="stepper">
      {STEPS.map((step, i) => {
        const isDone = i < stepIndex || (resolved && i <= stepIndex);
        const isActive = i === stepIndex && !resolved;
        const isFinalDone = resolved && i === STEPS.length - 1;
        const cls = [
          'step',
          isDone ? 'is-done' : '',
          isActive ? 'is-active' : '',
          isFinalDone ? 'is-final-done' : '',
        ].join(' ').trim();
        return (
          <div className={cls} key={step.key}>
            {i < STEPS.length - 1 && <div className="step-connector" />}
            <div className="step-node">
              {isDone || isFinalDone ? <CheckCircle2 size={14} /> : isActive ? <Loader2 size={13} className="spin" /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />}
            </div>
            <div className="step-label">{step.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// A bespoke progress ring rather than a stock donut chart — shows the real,
// measured drop in p95 latency between its worst point and its latest
// reading. Only rendered once there is real before/after data to show.
function RecoveryGauge({ percent, fromMs, toMs }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.min(Math.max(percent, 0), 100) / 100) * c;
  return (
    <div className="gauge-row">
      <svg viewBox="0 0 108 108" className="gauge-svg">
        <circle cx="54" cy="54" r={r} className="gauge-track" />
        <circle
          cx="54" cy="54" r={r}
          className="gauge-fill"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="gauge-figure">
        <div className="gauge-number">{percent}<span>%</span></div>
        <div className="gauge-label">faster p95</div>
      </div>
      <div className="gauge-detail">
        <div><span className="diff-old" style={{ textDecoration: 'none' }}>{fromMs}ms</span> peak</div>
        <div><span className="diff-new">{toMs}ms</span> now</div>
      </div>
    </div>
  );
}

function Toasts({ toasts, dismiss }) {
  const icon = { success: <CheckCircle size={18} />, error: <XCircle size={18} />, info: <Info size={18} /> };
  return (
    <div className="toast-stack">
      {toasts.map(t => (
        <div className={`toast ${t.type}`} key={t.id} onClick={() => dismiss(t.id)}>
          {icon[t.type] || icon.info}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [incidents, setIncidents] = useState([]);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [investigation, setInvestigation] = useState(null);
  const [simulation, setSimulation] = useState(null);
  const [applying, setApplying] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [latencyData, setLatencyData] = useState([]);
  const [throttleData, setThrottleData] = useState([]);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [verifySeconds, setVerifySeconds] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [appliedLabel, setAppliedLabel] = useState(null);
  const [celebrate, setCelebrate] = useState(false);

  const toastId = useRef(0);
  const addToast = useCallback((message, type = 'info') => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500);
  }, []);
  const dismissToast = (id) => setToasts(t => t.filter(x => x.id !== id));

  // ── Fetch active alarms ────────────────────────────────────────────────
  const fetchIncidents = () => {
    fetch(API_URL + "/incidents")
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setIncidents(data);
      })
      .catch(err => console.error("Failed to fetch incidents:", err));
  };

  useEffect(() => {
    fetchIncidents();
    const interval = setInterval(fetchIncidents, 15000);
    return () => clearInterval(interval);
  }, []);

  // ── Fetch real CloudWatch metrics for graph ─────────────────────────────
  const fetchMetrics = (functionName) => {
    if (!functionName) return;
    setLoadingMetrics(true);
    fetch(API_URL + `/incidents/metrics?functionName=${encodeURIComponent(functionName)}`)
      .then(res => res.json())
      .then(data => {
        // Debug: log first datapoint to see what the API actually sends
        const dur = data.durationData || [];
        const thr = data.throttleData || [];
        if (dur.length) console.log('[metrics] first duration point:', JSON.stringify(dur[0]));

        // The backend generates 1-minute intervals over the last hour.
        // Compute timestamps client-side as fallback when the API field is missing.
        const now = Date.now();
        const getTime = (arr, i, d) => {
          const raw = d.timestamp || d.Timestamp || d.time;
          if (raw) {
            const parsed = new Date(raw);
            if (!isNaN(parsed.valueOf())) return formatChartTime(parsed);
          }
          // Fallback: derive from array position (arr.length points, 1 minute apart, ending now)
          return formatChartTime(new Date(now - (arr.length - 1 - i) * 60_000));
        };

        setLatencyData(dur.map((d, i) => ({ time: getTime(dur, i, d), latency: d.latency })));
        setThrottleData(thr.map((d, i) => ({ time: getTime(thr, i, d), throttles: d.throttles })));
        setLoadingMetrics(false);
      })
      .catch(err => {
        console.error("Failed to fetch metrics:", err);
        setLoadingMetrics(false);
      });
  };

  // ── Trigger demo incident ──────────────────────────────────────────────
  const triggerDemoIncident = () => {
    fetch(API_URL + "/incidents/trigger", { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        addToast(data.message || "Demo incident triggered.", 'success');
        // Re-fetch incidents after a short delay so the alarm appears in the sidebar
        setTimeout(fetchIncidents, 2000);
      })
      .catch(err => { console.error(err); addToast("Could not trigger the demo incident.", 'error'); });
  };

  // ── Investigate ────────────────────────────────────────────────────────
  const handleInvestigate = (incident) => {
    setSelectedIncident(incident);
    setInvestigation(null);
    setSimulation(null);
    setResolved(false);
    setAppliedLabel(null);
    setLoading(true);

    fetchMetrics(incident.functionName);

    const functionName = incident.functionName || 'unknown';

    // Start the async agent invocation
    fetch(API_URL + "/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: `Investigate the CloudWatch alarm "${incident.title}" for Lambda function "${functionName}". Use getMetrics, queryLogs, getTraces, and getLambdaConfig to gather evidence. Then determine the root cause and propose a fix.`,
        sessionId: incident.id,
      })
    })
      .then(res => res.json())
      .then(data => {
        if (data.status === "accepted" || data.jobId) {
          // Poll for results
          const jobId = data.jobId || incident.id;
          const pollInterval = setInterval(() => {
            fetch(API_URL + "/agent", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "poll",
                sessionId: jobId,
              })
            })
              .then(r => r.json())
              .then(pollData => {
                if (pollData.status === "done") {
                  clearInterval(pollInterval);
                  setInvestigation({ agentResponse: pollData.agentResponse || "Investigation complete." });
                  setLoading(false);
                } else if (pollData.status === "error") {
                  clearInterval(pollInterval);
                  setInvestigation({ agentResponse: pollData.error || pollData.agentResponse || "Agent encountered an error." });
                  setLoading(false);
                }
                // if "running", keep polling
              })
              .catch(err => {
                console.error("Poll error:", err);
                // Don't stop polling on network glitch
              });
          }, 3000);

          // Safety: stop polling after 5 minutes
          setTimeout(() => {
            clearInterval(pollInterval);
            if (!investigation) {
              setLoading(false);
              addToast("Agent is taking too long. Check CloudWatch logs.", 'error');
            }
          }, 300000);
        } else if (data.agentResponse) {
          // Direct response (shouldn't happen but handle it)
          setInvestigation({ agentResponse: data.agentResponse });
          setLoading(false);
        } else {
          setInvestigation({ agentResponse: "No response from agent." });
          setLoading(false);
        }
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
        addToast("The agent didn't respond. Check the API connection.", 'error');
      });
  };

  // ── Simulate / Propose Fix ─────────────────────────────────────────────
  const handleSimulate = () => {
    setLoading(true);
    const functionName = selectedIncident?.functionName || 'unknown';
    const simSessionId = `${selectedIncident?.id}-sim-${Date.now()}`;
    fetch(API_URL + "/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: `Based on your investigation, what specific configuration changes do you propose for "${functionName}"? Explain the expected impact. Do NOT apply the fix yet — just propose it.`,
        sessionId: simSessionId,
      })
    })
      .then(res => res.json())
      .then(data => {
        if (data.status === "accepted" || data.jobId) {
          const jobId = data.jobId || simSessionId;
          const pollInterval = setInterval(() => {
            fetch(API_URL + "/agent", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "poll", sessionId: jobId })
            })
              .then(r => r.json())
              .then(pollData => {
                if (pollData.status === "done" || pollData.status === "error") {
                  clearInterval(pollInterval);
                  setSimulation({ response: pollData.agentResponse || pollData.error || "No simulation response." });
                  setLoading(false);
                }
              })
              .catch(err => console.error("Poll error:", err));
          }, 3000);
          setTimeout(() => { clearInterval(pollInterval); setLoading(false); }, 300000);
        } else {
          setSimulation({ response: data.agentResponse || "No simulation response." });
          setLoading(false);
        }
      })
      .catch(err => { console.error(err); setLoading(false); addToast("Couldn't get a fix proposal.", 'error'); });
  };

  // ── Apply Fix & Verify ─────────────────────────────────────────────────
  const handleApply = () => {
    setApplying(true);
    setVerifySeconds(0);
    setAppliedLabel(formatChartTime(new Date()));
    const functionName = selectedIncident?.functionName || 'unknown';
    const applySessionId = `${selectedIncident?.id}-apply-${Date.now()}`;

    fetch(API_URL + "/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: `I approve the fix. Apply it now to "${functionName}" using the applyFix tool. Then call verifyRecovery to wait ~60 seconds and check whether the metrics have actually improved.`,
        sessionId: applySessionId,
      })
    })
      .then(res => res.json())
      .then(data => {
        if (data.status === "accepted" || data.jobId) {
          const jobId = data.jobId || applySessionId;
          const pollInterval = setInterval(() => {
            fetch(API_URL + "/agent", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "poll", sessionId: jobId })
            })
              .then(r => r.json())
              .then(pollData => {
                if (pollData.status === "done" || pollData.status === "error") {
                  clearInterval(pollInterval);
                  setResolved(true);
                  setApplying(false);
                  setInvestigation(prev => ({
                    ...prev,
                    agentResponse: (prev?.agentResponse || '') + '\n\n**Post-fix verification**\n' + (pollData.agentResponse || 'No verification response.'),
                  }));
                  fetchMetrics(functionName);
                  fetchIncidents();
                  addToast("Fix applied and verified.", 'success');
                }
              })
              .catch(err => console.error("Poll error:", err));
          }, 3000);
          setTimeout(() => { clearInterval(pollInterval); setApplying(false); }, 300000);
        } else {
          setResolved(true);
          setApplying(false);
          setInvestigation(prev => ({
            ...prev,
            agentResponse: (prev?.agentResponse || '') + '\n\n**Post-fix verification**\n' + (data.agentResponse || 'No verification response.'),
          }));
          fetchMetrics(functionName);
          fetchIncidents();
          addToast("Fix applied and verified.", 'success');
        }
      })
      .catch(err => { console.error(err); setApplying(false); addToast("The fix could not be applied.", 'error'); });
  };

  // Cosmetic progress for the ~60s verify wait — an estimate of elapsed
  // time, not a claim about the real result, which still comes from the API.
  useEffect(() => {
    if (!applying) return;
    const t = setInterval(() => setVerifySeconds(s => Math.min(s + 1, 60)), 1000);
    return () => clearInterval(t);
  }, [applying]);

  // One orchestrated payoff moment when a fix is verified — not a scattered
  // set of effects, just a single fade wash across the panel.
  useEffect(() => {
    if (!resolved) return;
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 1600);
    return () => clearTimeout(t);
  }, [resolved]);

  // ── Derived, real numbers only — nothing here is invented ───────────────
  const activeCount = incidents.filter(i => i.status !== 'resolved').length;
  const resolvedCount = incidents.filter(i => i.status === 'resolved').length;
  const currentP95 = latencyData.length ? latencyData[latencyData.length - 1].latency : null;
  const throttleSum = throttleData.reduce((sum, d) => sum + (d.throttles || 0), 0);

  const recovery = useMemo(() => {
    if (!resolved || latencyData.length < 2) return null;
    const peak = Math.max(...latencyData.map(d => d.latency));
    const latest = latencyData[latencyData.length - 1].latency;
    if (!(peak > 0) || latest >= peak) return null;
    return { percent: Math.round(((peak - latest) / peak) * 100), peak, latest };
  }, [resolved, latencyData]);

  // ── Derive the agent's current stage for the stepper ────────────────────
  let stepIndex = 0;
  if (selectedIncident) {
    if (loading && !investigation) stepIndex = 1;
    else if (investigation && !simulation) stepIndex = 2;
    else if (simulation && !applying && !resolved) stepIndex = 3;
    else if (applying) stepIndex = 4;
    else if (resolved) stepIndex = 5;
    else stepIndex = investigation ? 2 : 0;
  }

  const diffRows = simulation ? extractDiffRows(simulation.response) : null;

  return (
    <>
      <div className="aurora" aria-hidden="true" />

      <header className="topbar">
        <div className="topbar-brand">
          <div className="topbar-mark"><ShieldAlert size={17} /></div>
          <div>
            <div className="topbar-title">Incident Autopilot</div>
            <div className="topbar-sub">autonomous AWS SRE agent</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="live-tag"><span className="live-dot" /> live monitoring</div>
        </div>
      </header>

      <div className="stats-strip">
        <div className="stat-tile">
          <div className="stat-icon amber"><TriangleAlert size={14} /></div>
          <div><div className="stat-value">{activeCount}</div><div className="stat-label">active signals</div></div>
        </div>
        <div className="stat-tile">
          <div className="stat-icon green"><CheckCircle2 size={14} /></div>
          <div><div className="stat-value">{resolvedCount}</div><div className="stat-label">resolved</div></div>
        </div>
        <div className="stat-tile">
          <div className="stat-icon cyan"><Radio size={14} /></div>
          <div><div className="stat-value">{currentP95 !== null ? `${currentP95}ms` : '—'}</div><div className="stat-label">p95 latency now</div></div>
        </div>
        <div className="stat-tile">
          <div className="stat-icon amber"><Zap size={14} /></div>
          <div><div className="stat-value">{selectedIncident ? throttleSum : '—'}</div><div className="stat-label">throttles, 1h window</div></div>
        </div>
      </div>

      <main className="workspace">
        {/* Signal rail: the incident queue */}
        <aside className="signal-rail">
          <div className="rail-head">
            <span className="rail-label">Signals</span>
            <span className="rail-count">{incidents.length}</span>
          </div>
          <div className="signal-list">
            {incidents.length === 0 ? (
              <div className="signal-empty">No alarms firing right now. Trigger a demo incident to see the agent work.</div>
            ) : (
              incidents.map(inc => {
                const isResolved = inc.status === 'resolved';
                return (
                  <button
                    key={inc.id}
                    className={`signal-card ${selectedIncident?.id === inc.id ? 'is-active' : ''} ${isResolved ? 'is-resolved' : ''}`}
                    onClick={() => handleInvestigate(inc)}
                  >
                    <div className="signal-card-top">
                      <span className="signal-glyph">
                        {isResolved ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}
                      </span>
                      <span className="signal-title">{inc.title}</span>
                    </div>
                    <div className="signal-fn">{inc.functionName || inc.service}</div>
                    <div className="signal-meta">
                      <span className={`signal-status ${isResolved ? 'resolved' : 'investigating'}`}>{inc.status}</span>
                      <span className="signal-time">{new Date(inc.time).toLocaleTimeString()}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div className="rail-foot">
            <button className="btn btn-ghost btn-full" onClick={triggerDemoIncident}>
              Trigger demo incident
            </button>
          </div>
        </aside>

        {/* Case panel: investigation & remediation */}
        <section className={`case-panel ${celebrate ? 'is-celebrating' : ''}`}>
          {selectedIncident ? (
            <div className="case-enter" key={selectedIncident.id}>
              <div className="case-head">
                <div>
                  <h1 className="case-title">{selectedIncident.title}</h1>
                  <span className="case-fn">{selectedIncident.functionName || 'unknown function'}</span>
                </div>
                {resolved && (
                  <div className="resolved-flag"><CheckCircle size={16} /> Verified resolved</div>
                )}
              </div>

              <AgentStepper stepIndex={stepIndex} resolved={resolved} />

              <div className="panel topology-panel">
                <div className="panel-label"><Cpu size={13} /> Agent tools</div>
                <Suspense fallback={<div className="topology-fallback" />}>
                  <AgentTopology stepIndex={stepIndex} resolved={resolved} compact />
                </Suspense>
              </div>

              <div className="chart-grid">
                <div className="panel">
                  <div className="panel-label"><ServerCog size={13} /> p95 latency, last hour</div>
                  <div className="chart-wrap">
                    {loadingMetrics ? (
                      <div className="chart-placeholder">Reading CloudWatch metrics…</div>
                    ) : latencyData.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={latencyData}>
                          <defs>
                            <linearGradient id="colorLatency" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={resolved ? '#4ade80' : '#f5a623'} stopOpacity={0.45} />
                              <stop offset="95%" stopColor={resolved ? '#4ade80' : '#f5a623'} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="time" stroke="#545e6b" fontSize={11} tickLine={false} axisLine={false} />
                          <YAxis stroke="#545e6b" fontSize={11} unit="ms" tickLine={false} axisLine={false} width={48} />
                          <Tooltip
                            contentStyle={{ background: '#12161d', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                            formatter={(value) => [`${value}ms`, 'p95 latency']}
                          />
                          {appliedLabel && (
                            <ReferenceLine
                              x={appliedLabel}
                              stroke="#35d6cd"
                              strokeDasharray="4 4"
                              label={{ value: 'fix applied', position: 'insideTopLeft', fill: '#35d6cd', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
                            />
                          )}
                          <Area type="monotone" dataKey="latency" stroke={resolved ? '#4ade80' : '#f5a623'} strokeWidth={2} fillOpacity={1} fill="url(#colorLatency)" connectNulls />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="chart-placeholder">No metric data yet. Trigger invocations to generate a signal.</div>
                    )}
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-label"><Zap size={13} /> throttles, last hour</div>
                  <div className="chart-wrap chart-wrap-sm">
                    {loadingMetrics ? (
                      <div className="chart-placeholder">Reading CloudWatch metrics…</div>
                    ) : throttleData.some(d => d.throttles > 0) ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={throttleData}>
                          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="time" stroke="#545e6b" fontSize={11} tickLine={false} axisLine={false} />
                          <YAxis stroke="#545e6b" fontSize={11} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                          <Tooltip
                            contentStyle={{ background: '#12161d', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                            formatter={(value) => [value, 'throttled invocations']}
                          />
                          <Bar dataKey="throttles" fill="#ef4565" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="chart-placeholder">{throttleData.length ? 'No throttling in this window — capacity looks healthy.' : 'No throttle data yet.'}</div>
                    )}
                  </div>
                </div>
              </div>

              {recovery && (
                <div className="panel">
                  <div className="panel-label" style={{ color: '#4ade80' }}><TrendingDown size={13} /> measured recovery</div>
                  <RecoveryGauge percent={recovery.percent} fromMs={recovery.peak} toMs={recovery.latest} />
                </div>
              )}

              {!investigation && loading ? (
                <div className="panel">
                  <div className="thinking-line">
                    <div className="dot-flash"><span /><span /><span /></div>
                    Agent is querying CloudWatch, X-Ray, and Lambda config…
                  </div>
                </div>
              ) : investigation && (
                <>
                  <div className="panel">
                    <div className="panel-label"><Cpu size={13} /> Case file</div>
                    <CaseFileText text={investigation.agentResponse} />
                  </div>

                  {!simulation && !resolved && (() => {
                    const { isInsufficient } = parseAgentResponse(investigation.agentResponse);
                    return (
                      <div className="action-row">
                        <button
                          className="btn btn-primary"
                          onClick={handleSimulate}
                          disabled={loading || isInsufficient}
                          title={isInsufficient ? "Cannot propose fix with insufficient evidence" : ""}
                        >
                          {loading ? 'Proposing fix…' : isInsufficient ? 'Insufficient Evidence' : 'Propose fix'}
                        </button>
                      </div>
                    );
                  })()}

                  {simulation && (
                    <div className="panel fix-panel">
                      <div className="panel-label" style={{ color: '#35d6cd' }}>Proposed fix</div>
                      {diffRows ? (
                        <div className="diff-table">
                          {diffRows.map((row, i) => (
                            <div className="diff-row" key={i}>
                              <span className="diff-key">{row.key}</span>
                              <span className="diff-old">{row.from}</span>
                              <span className="diff-arrow">→</span>
                              <span className="diff-new">{row.to}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <CaseFileText text={simulation.response} />
                      )}

                      {!resolved && (
                        <>
                          {applying && (
                            <>
                              <div className="verify-bar-track">
                                <div className="verify-bar-fill" style={{ width: `${(verifySeconds / 60) * 100}%` }} />
                              </div>
                              <div className="verify-caption">Applying config and re-checking metrics — ~{Math.max(60 - verifySeconds, 0)}s remaining</div>
                            </>
                          )}
                          <div className="action-row">
                            <button className="btn btn-primary" onClick={handleApply} disabled={applying}>
                              {applying ? 'Applying & verifying…' : 'Approve & apply fix'}
                            </button>
                            <button className="btn btn-danger-ghost" onClick={() => setSimulation(null)} disabled={applying}>
                              Reject
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <Suspense fallback={<div className="topology-fallback topology-fallback-lg" />}>
                <AgentTopology stepIndex={-1} resolved={false} />
              </Suspense>
              <h2>Select a signal to start an investigation</h2>
              <p>Or trigger a demo incident from the sidebar to watch the agent detect, diagnose, and fix it end to end.</p>
            </div>
          )}
        </section>
      </main>

      <Toasts toasts={toasts} dismiss={dismissToast} />
    </>
  );
}