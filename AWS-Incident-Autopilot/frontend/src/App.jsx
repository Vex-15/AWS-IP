import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  ShieldAlert, TriangleAlert, CheckCircle2, ServerCog, Cpu,
  CheckCircle, XCircle, Info, Loader2, Radio, Zap, TrendingDown,
} from 'lucide-react';
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area,
  BarChart, Bar, CartesianGrid, ReferenceLine,
} from 'recharts';
import './index.css';

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

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

// ── Tiny markdown-lite renderer for the agent's free-text responses ─────
// The agent writes **bold** section headers and plain paragraphs. Render
// those distinctly instead of dumping one grey wall of text.
function CaseFileText({ text }) {
  if (!text) return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const nodes = [];
  let paragraph = [];

  const flush = (key) => {
    if (paragraph.length) {
      nodes.push(<p key={key}>{paragraph.join(' ')}</p>);
      paragraph = [];
    }
  };

  lines.forEach((line, i) => {
    const boldMatch = line.match(/^\*\*(.+?)\*\*:?$/);
    if (boldMatch) {
      flush(`p${i}`);
      nodes.push(<div className="case-file-heading" key={`h${i}`}>{boldMatch[1]}</div>);
    } else {
      paragraph.push(line.replace(/\*\*(.+?)\*\*/g, '$1'));
    }
  });
  flush('pEnd');

  return <div className="case-file">{nodes}</div>;
}

// Looks for lines like "memorySize: 128MB -> 512MB" in the agent's fix
// proposal. Returns real diff rows straight from the agent's own words —
// never invented values — or null if the text isn't shaped that way.
function extractDiffRows(text) {
  if (!text) return null;
  const rows = [];
  const rowPattern = /^[-*\s]*\*{0,2}([\w\s]{2,30}?)\*{0,2}\s*[:\-]?\s*([^\n]*?)\s*(?:→|->)\s*([^\n]+)$/;
  text.split('\n').forEach(line => {
    const m = line.trim().match(rowPattern);
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
        setLatencyData(data.durationData || []);
        setThrottleData(data.throttleData || []);
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
      .then(data => addToast(data.message || "Demo incident triggered.", 'success'))
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
        setInvestigation({ agentResponse: data.agentResponse || "No response from agent." });
        setLoading(false);
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
    fetch(API_URL + "/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: `Based on your investigation, what specific configuration changes do you propose for "${functionName}"? Explain the expected impact. Do NOT apply the fix yet — just propose it.`,
        sessionId: selectedIncident?.id,
      })
    })
      .then(res => res.json())
      .then(data => {
        setSimulation({ response: data.agentResponse || "No simulation response." });
        setLoading(false);
      })
      .catch(err => { console.error(err); setLoading(false); addToast("Couldn't get a fix proposal.", 'error'); });
  };

  // ── Apply Fix & Verify ─────────────────────────────────────────────────
  const handleApply = () => {
    setApplying(true);
    setVerifySeconds(0);
    // Mark "now" on the real metrics timeline so the chart can show exactly
    // where the fix landed, once the post-fix data comes back.
    setAppliedLabel(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
    const functionName = selectedIncident?.functionName || 'unknown';

    fetch(API_URL + "/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: `I approve the fix. Apply it now to "${functionName}" using the applyFix tool. Then call verifyRecovery to wait ~60 seconds and check whether the metrics have actually improved.`,
        sessionId: selectedIncident?.id,
      })
    })
      .then(res => res.json())
      .then(data => {
        setResolved(true);
        setApplying(false);
        setInvestigation(prev => ({
          ...prev,
          agentResponse: (prev?.agentResponse || '') + '\n\n**Post-fix verification**\n' + (data.agentResponse || 'No verification response.'),
        }));
        fetchMetrics(functionName);
        fetchIncidents();
        addToast("Fix applied and verified.", 'success');
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
                          <Area type="monotone" dataKey="latency" stroke={resolved ? '#4ade80' : '#f5a623'} strokeWidth={2} fillOpacity={1} fill="url(#colorLatency)" />
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

                  {!simulation && !resolved && (
                    <div className="action-row">
                      <button className="btn btn-primary" onClick={handleSimulate} disabled={loading}>
                        {loading ? 'Proposing fix…' : 'Propose fix'}
                      </button>
                    </div>
                  )}

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
              <div className="empty-mark"><ServerCog size={26} /></div>
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
