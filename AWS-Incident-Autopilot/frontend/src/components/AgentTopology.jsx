import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// The agent's real tool graph (see README: getMetrics, queryLogs, getTraces,
// getLambdaConfig, applyFix, verifyRecovery) rendered as an orbiting node
// graph around the agent core. Which nodes light up is driven by the same
// stepIndex/resolved state as the 2D stepper — this isn't decoration, it's
// the same investigation shown from a different angle.
const TOOLS = [
    { label: 'CloudWatch', group: 'investigate' },
    { label: 'Logs', group: 'investigate' },
    { label: 'X-Ray', group: 'investigate' },
    { label: 'Lambda Config', group: 'investigate' },
    { label: 'Apply Fix', group: 'apply' },
    { label: 'Verify', group: 'verify' },
];

const AMBER = new THREE.Color('#f5a623');
const CYAN = new THREE.Color('#35d6cd');
const GREEN = new THREE.Color('#4ade80');
const IDLE = new THREE.Color('#3a4250');

function nodeState(i, stepIndex, resolved) {
    const tool = TOOLS[i];
    if (resolved) return tool.group === 'verify' ? 'final' : 'done';
    if (stepIndex < 0) return 'idle';
    if (tool.group === 'investigate') {
        if (stepIndex === 1) return 'active';
        if (stepIndex > 1) return 'done';
        return 'idle';
    }
    if (tool.group === 'apply') {
        if (stepIndex === 4) return 'active';
        if (stepIndex > 4) return 'done';
        return 'idle';
    }
    return 'idle'; // verify, pre-resolution
}

function colorFor(state) {
    if (state === 'final') return GREEN;
    if (state === 'active') return CYAN;
    if (state === 'done') return AMBER;
    return IDLE;
}

export default function AgentTopology({ stepIndex = -1, resolved = false, compact = false }) {
    const mountRef = useRef(null);
    const stateRef = useRef({ stepIndex, resolved });
    stateRef.current = { stepIndex, resolved };

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
        camera.position.set(0, 0.4, 7.2);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        mount.appendChild(renderer.domElement);

        // Faint starfield for depth
        const starGeo = new THREE.BufferGeometry();
        const starCount = 140;
        const starPos = new Float32Array(starCount * 3);
        for (let i = 0; i < starCount; i++) {
            starPos[i * 3] = (Math.random() - 0.5) * 16;
            starPos[i * 3 + 1] = (Math.random() - 0.5) * 10;
            starPos[i * 3 + 2] = (Math.random() - 0.5) * 10 - 4;
        }
        starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
        const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x2a3140, size: 0.035 }));
        scene.add(stars);

        const rig = new THREE.Group();
        scene.add(rig);

        // Agent core
        const core = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.62, 1),
            new THREE.MeshBasicMaterial({ color: CYAN, wireframe: true, transparent: true, opacity: 0.55 })
        );
        rig.add(core);
        const coreGlow = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.5, 1),
            new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.08 })
        );
        rig.add(coreGlow);

        // One-shot "verified" shockwave — fires once when resolved flips true,
        // not a looping decoration. See renderFrame for the trigger.
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.66, 0.72, 48),
            new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0, side: THREE.DoubleSide })
        );
        ring.visible = false;
        rig.add(ring);

        // Satellite nodes + connecting lines
        const radius = 2.35;
        const nodes = TOOLS.map((tool, i) => {
            const theta = (i / TOOLS.length) * Math.PI * 2;
            const phi = (i % 2 === 0 ? 1 : -1) * 0.35;
            const x = Math.cos(theta) * radius;
            const y = Math.sin(phi) * 1.1;
            const z = Math.sin(theta) * radius * 0.55;

            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(0.16, 16, 16),
                new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, opacity: 0.5 })
            );
            mesh.position.set(x, y, z);
            rig.add(mesh);

            const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), mesh.position]);
            const lineMat = new THREE.LineBasicMaterial({ color: IDLE, transparent: true, opacity: 0.25 });
            const line = new THREE.Line(lineGeo, lineMat);
            rig.add(line);

            return { mesh, line, base: { x, y, z } };
        });

        // Small traveling glow along the line to an active node — shows a tool
        // call actually in flight, not just a color change on the endpoint.
        const pulses = TOOLS.map(() => {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(0.055, 8, 8),
                new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0 })
            );
            mesh.visible = false;
            rig.add(mesh);
            return mesh;
        });

        // HTML labels projected from each node's 3D position — the tool names
        // already existed in TOOLS but were never actually shown anywhere.
        // Skipped in compact mode to keep the small widget glanceable.
        let labelLayer = null;
        let labelEls = [];
        if (!compact) {
            labelLayer = document.createElement('div');
            labelLayer.className = 'topology-label-layer';
            mount.appendChild(labelLayer);
            labelEls = TOOLS.map((tool) => {
                const el = document.createElement('span');
                el.className = 'topology-label';
                el.textContent = tool.label;
                labelLayer.appendChild(el);
                return el;
            });
        }
        const projected = new THREE.Vector3();

        // Pointer parallax
        const pointer = { x: 0, y: 0 };
        const onPointerMove = (e) => {
            const rect = mount.getBoundingClientRect();
            pointer.x = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
            pointer.y = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
        };
        mount.addEventListener('pointermove', onPointerMove);

        const resize = () => {
            const w = mount.clientWidth;
            const h = mount.clientHeight;
            if (!w || !h) return;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
        };
        const ro = new ResizeObserver(resize);
        ro.observe(mount);
        resize();

        let raf;
        const clock = new THREE.Clock();
        let prevResolved = resolved;
        let ringStart = null;

        const renderFrame = () => {
            const t = clock.getElapsedTime();
            const { stepIndex: si, resolved: res } = stateRef.current;

            if (!reduceMotion) {
                rig.rotation.y = t * 0.12;
                rig.rotation.x = THREE.MathUtils.lerp(rig.rotation.x, pointer.y * 0.15, 0.04);
                rig.rotation.y += pointer.x * 0.08;
                core.rotation.x += 0.004;
                core.rotation.y += 0.006;
                stars.rotation.y = t * 0.01;
            }

            const anyActive = si === 1 || si === 4;
            const coreColor = res ? GREEN : anyActive ? CYAN : new THREE.Color('#2f6f6b');
            core.material.color.lerp(coreColor, 0.08);
            const corePulse = 1 + Math.sin(t * 3) * (anyActive ? 0.06 : 0.02);
            core.scale.setScalar(corePulse);
            coreGlow.scale.setScalar(corePulse);

            nodes.forEach((n, i) => {
                const state = nodeState(i, si, res);
                const targetColor = colorFor(state);
                n.mesh.material.color.lerp(targetColor, 0.1);
                n.line.material.color.lerp(targetColor, 0.1);

                const targetOpacity = state === 'idle' ? 0.35 : state === 'active' ? 1 : 0.85;
                n.mesh.material.opacity = THREE.MathUtils.lerp(n.mesh.material.opacity, targetOpacity, 0.08);
                n.line.material.opacity = THREE.MathUtils.lerp(n.line.material.opacity, state === 'idle' ? 0.15 : 0.55, 0.08);

                const scale = state === 'active' ? 1 + Math.sin(t * 5 + i) * 0.18 : 1;
                n.mesh.scale.setScalar(scale);

                // Traveling glow while this tool call is in flight
                const pulse = pulses[i];
                if (!reduceMotion && state === 'active') {
                    const tp = (t * 1.1 + i * 0.18) % 1;
                    pulse.position.lerpVectors(new THREE.Vector3(0, 0, 0), n.mesh.position, tp);
                    pulse.material.opacity = Math.sin(tp * Math.PI) * 0.9;
                    pulse.visible = true;
                } else {
                    pulse.visible = false;
                }
            });

            // One-shot shockwave the moment resolved flips true — a single
            // orchestrated payoff, not a repeating loop.
            if (!reduceMotion && res && !prevResolved) ringStart = t;
            prevResolved = res;
            if (ringStart !== null) {
                const elapsed = t - ringStart;
                if (elapsed > 1.1) {
                    ring.visible = false;
                    ringStart = null;
                } else {
                    ring.visible = true;
                    ring.quaternion.copy(camera.quaternion);
                    const k = elapsed / 1.1;
                    ring.scale.setScalar(1 + k * 3.2);
                    ring.material.opacity = (1 - k) * 0.8;
                }
            }

            // Project each node's live 3D position onto the 2D label layer
            if (labelLayer) {
                const w = mount.clientWidth || 1;
                const h = mount.clientHeight || 1;
                nodes.forEach((n, i) => {
                    n.mesh.getWorldPosition(projected);
                    projected.project(camera);
                    const x = (projected.x * 0.5 + 0.5) * w;
                    const y = (-projected.y * 0.5 + 0.5) * h;
                    const depthFade = THREE.MathUtils.clamp(1 - Math.abs(projected.z) * 0.6, 0.4, 1);
                    const el = labelEls[i];
                    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, 10px)`;
                    el.style.opacity = String(n.mesh.material.opacity * depthFade);
                });
            }

            renderer.render(scene, camera);
            raf = requestAnimationFrame(renderFrame);
        };
        renderFrame();

        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            mount.removeEventListener('pointermove', onPointerMove);
            renderer.dispose();
            starGeo.dispose();
            core.geometry.dispose();
            core.material.dispose();
            coreGlow.geometry.dispose();
            coreGlow.material.dispose();
            ring.geometry.dispose();
            ring.material.dispose();
            nodes.forEach(n => {
                n.mesh.geometry.dispose();
                n.mesh.material.dispose();
                n.line.geometry.dispose();
                n.line.material.dispose();
            });
            pulses.forEach(p => {
                p.geometry.dispose();
                p.material.dispose();
            });
            if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
            if (labelLayer && labelLayer.parentNode === mount) mount.removeChild(labelLayer);
        };
    }, []); // scene is built once; live state flows through stateRef

    // Canvas is purely visual — give screen readers a text summary of what's
    // actually happening, kept in sync with the props that drive the scene.
    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return;
        mount.setAttribute('role', 'img');
        mount.setAttribute(
            'aria-label',
            resolved
                ? 'Agent topology: incident verified as fixed.'
                : stepIndex < 0
                    ? 'Agent topology: idle, no active incident.'
                    : stepIndex === 1
                        ? 'Agent topology: investigating via CloudWatch, Logs, X-Ray, and Lambda Config.'
                        : stepIndex === 4
                            ? 'Agent topology: applying fix.'
                            : 'Agent topology: agent working.'
        );
    }, [stepIndex, resolved]);

    return <div ref={mountRef} className={`topology-canvas ${compact ? 'is-compact' : ''}`} />;
}