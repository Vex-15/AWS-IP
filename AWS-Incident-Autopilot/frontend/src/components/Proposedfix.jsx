import { useState } from 'react';
import {
    Sparkles, CheckCircle2, ChevronDown, Loader2,
    AlertTriangle, ShieldCheck, ArrowRight, Activity,
    Clock, RotateCcw, Zap, Server, X
} from 'lucide-react';
import './Proposedfix.css';

/**
 * Enhanced ProposedFix Component
 * Sleek cyber-SRE panel presenting autonomous remediation proposals,
 * metric deltas, impact rationale, diff view, and zero-downtime safety metadata.
 */
export function ProposedFix({
    simulation,
    diffRows,
    applying,
    verifySeconds = 0,
    onApply,
    onReject,
    reasoningData = {}
}) {
    const [showDetails, setShowDetails] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    const {
        title = "Memory Allocation Tuning",
        subtitle = "Automated telemetry-guided resource adjustment",
        preamble = "Based on evidence gathered across CloudWatch and execution traces, the agent recommends the following reconfiguration:",
        parameter = "MemorySize",
        currentValue = "512 MB",
        proposedValue = "1024 MB",
        deltaLabel = "+100%",
        whyMatters = [],
        impactZone = "Production Lambda Container",
        riskLevel = "low",
        rollbackWindow = "30 minutes (automated)",
        successRate = "99.4%",
        downtime = "0s (zero-downtime rolling update)"
    } = reasoningData;

    const riskBadgeStyles = {
        low: { bg: 'rgba(74, 222, 128, 0.12)', text: '#4ade80', border: 'rgba(74, 222, 128, 0.3)', label: 'Low Risk' },
        medium: { bg: 'rgba(245, 166, 35, 0.12)', text: '#f5a623', border: 'rgba(245, 166, 35, 0.3)', label: 'Medium Risk' },
        high: { bg: 'rgba(239, 69, 101, 0.12)', text: '#ef4565', border: 'rgba(239, 69, 101, 0.3)', label: 'High Risk' },
    };

    const currentRisk = riskBadgeStyles[riskLevel] || riskBadgeStyles.low;

    return (
        <div className="proposed-fix-card">
            {/* Top Banner with Badge */}
            <div className="fix-header-row">
                <div className="fix-header-left">
                    <div className="fix-icon-badge">
                        <Sparkles size={18} />
                    </div>
                    <div>
                        <div className="fix-kicker">
                            <span className="fix-tag">Autonomous Remediation</span>
                            <span className="fix-tag-dot">•</span>
                            <span className="fix-tag-muted">Safe in-place update</span>
                        </div>
                        <h2 className="fix-main-title">{title}</h2>
                        <p className="fix-subtitle-text">{subtitle}</p>
                    </div>
                </div>

                <div className="fix-header-right">
                    <span
                        className="fix-risk-pill"
                        style={{
                            background: currentRisk.bg,
                            color: currentRisk.text,
                            borderColor: currentRisk.border
                        }}
                    >
                        <ShieldCheck size={13} />
                        {currentRisk.label}
                    </span>
                </div>
            </div>

            {/* Agent Preamble / Insight Note */}
            {preamble && (
                <div className="fix-agent-note">
                    <div className="fix-note-icon">
                        <Activity size={14} />
                    </div>
                    <div className="fix-note-text">{preamble}</div>
                </div>
            )}

            {/* Visual Metric Comparison Grid */}
            <div className="fix-metric-comparison">
                {/* Current Value Card */}
                <div className="metric-box is-current">
                    <div className="metric-box-label">
                        <span className="metric-status-dot dot-warn" /> Current Allocation
                    </div>
                    <div className="metric-box-value">{currentValue}</div>
                    <div className="metric-box-sub">Suboptimal headroom • High GC pressure</div>
                </div>

                {/* Transition Indicator */}
                <div className="metric-transition">
                    <div className="metric-delta-pill">{deltaLabel}</div>
                    <div className="metric-arrow-circle">
                        <ArrowRight size={16} />
                    </div>
                </div>

                {/* Proposed Value Card */}
                <div className="metric-box is-proposed">
                    <div className="metric-box-label">
                        <span className="metric-status-dot dot-good" /> Recommended Target
                    </div>
                    <div className="metric-box-value">{proposedValue}</div>
                    <div className="metric-box-sub">Optimal capacity • Target p95 latency</div>
                </div>
            </div>

            {/* Why This Matters / Impact Rationale */}
            {whyMatters && whyMatters.length > 0 && (
                <div className="fix-impact-section">
                    <div className="fix-section-title">
                        <Zap size={14} />
                        <span>Why this remediation matters</span>
                    </div>
                    <div className="fix-impact-grid">
                        {whyMatters.map((reason, i) => (
                            <div className="fix-impact-item" key={i}>
                                <div className="fix-impact-num">{i + 1}</div>
                                <div className="fix-impact-text">{reason}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Configuration Changes Terminal Diff */}
            {diffRows && diffRows.length > 0 && (
                <div className="fix-diff-section">
                    <div className="diff-header-bar">
                        <div className="diff-dots">
                            <span className="dot dot-r" />
                            <span className="dot dot-y" />
                            <span className="dot dot-g" />
                        </div>
                        <span className="diff-title-bar">aws:lambda:function-configuration</span>
                    </div>
                    <div className="diff-body">
                        {diffRows.map((row, i) => (
                            <div className="diff-line-row" key={i}>
                                <span className="diff-param-name">{row.key}</span>
                                <span className="diff-val-old">- {row.from}</span>
                                <span className="diff-arrow-sym">→</span>
                                <span className="diff-val-new">+ {row.to}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Advanced Safety Details Accordion */}
            <div className="fix-accordion">
                <button
                    className="fix-accordion-btn"
                    onClick={() => setShowDetails(!showDetails)}
                    type="button"
                >
                    <span className="accordion-label">
                        <ShieldCheck size={14} /> Safety, Rollback & Deployment Metadata
                    </span>
                    <ChevronDown size={15} className={`accordion-chevron ${showDetails ? 'is-open' : ''}`} />
                </button>

                {showDetails && (
                    <div className="fix-accordion-content">
                        <div className="safety-grid">
                            <div className="safety-card">
                                <span className="safety-key"><Server size={12} /> Target Scope</span>
                                <span className="safety-val">{impactZone}</span>
                            </div>
                            <div className="safety-card">
                                <span className="safety-key"><RotateCcw size={12} /> Rollback Window</span>
                                <span className="safety-val">{rollbackWindow}</span>
                            </div>
                            <div className="safety-card">
                                <span className="safety-key"><Clock size={12} /> Estimated Downtime</span>
                                <span className="safety-val">{downtime}</span>
                            </div>
                            <div className="safety-card">
                                <span className="safety-key"><CheckCircle2 size={12} /> Automated Verification</span>
                                <span className="safety-val">60s CloudWatch telemetry check</span>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Progress Track when applying */}
            {applying && (
                <div className="fix-progress-box">
                    <div className="verify-bar-track">
                        <div className="verify-bar-fill" style={{ width: `${Math.min((verifySeconds / 60) * 100, 100)}%` }} />
                    </div>
                    <div className="verify-caption-row">
                        <Loader2 size={14} className="spin-icon" />
                        <span>Applying configuration patch & validating CloudWatch signals — ~{Math.max(60 - verifySeconds, 0)}s remaining</span>
                    </div>
                </div>
            )}

            {/* Primary Action Buttons */}
            <div className="fix-actions-row">
                <button
                    className="btn-apply-remediation"
                    onClick={() => setShowConfirm(true)}
                    disabled={applying}
                >
                    {applying ? (
                        <>
                            <Loader2 size={16} className="spin-icon" />
                            <span>Applying & Verifying Patch…</span>
                        </>
                    ) : (
                        <>
                            <CheckCircle2 size={16} />
                            <span>Approve & Apply Fix</span>
                        </>
                    )}
                </button>

                <button
                    className="btn-reject-remediation"
                    onClick={onReject}
                    disabled={applying}
                    title="Dismiss this proposal"
                >
                    <X size={15} />
                    <span>Dismiss</span>
                </button>
            </div>

            {/* Confirmation Modal */}
            {showConfirm && (
                <div className="fix-modal-backdrop" onClick={() => setShowConfirm(false)}>
                    <div className="fix-modal-box" onClick={e => e.stopPropagation()}>
                        <div className="fix-modal-icon-wrap">
                            <AlertTriangle size={22} />
                        </div>
                        <h3 className="fix-modal-title">Confirm Configuration Update</h3>
                        <p className="fix-modal-desc">
                            This will update <strong className="text-cyan">{parameter}</strong> from <strong className="text-amber">{currentValue}</strong> to <strong className="text-green">{proposedValue}</strong>.
                        </p>
                        <div className="fix-modal-banner">
                            <ShieldCheck size={16} />
                            <span>Zero downtime update with 30m automated rollback guard.</span>
                        </div>
                        <div className="fix-modal-actions">
                            <button
                                className="btn-apply-remediation"
                                onClick={() => {
                                    setShowConfirm(false);
                                    onApply();
                                }}
                            >
                                Confirm & Deploy Now
                            </button>
                            <button
                                className="btn-reject-remediation"
                                onClick={() => setShowConfirm(false)}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ProposedFix;