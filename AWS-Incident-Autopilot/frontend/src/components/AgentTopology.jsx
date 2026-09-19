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
            const pulse = 1 + Math.sin(t * 3) * (anyActive ? 0.06 : 0.02);
            core.scale.setScalar(pulse);
            coreGlow.scale.setScalar(pulse);

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
            });

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
            nodes.forEach(n => {
                n.mesh.geometry.dispose();
                n.mesh.material.dispose();
                n.line.geometry.dispose();
                n.line.material.dispose();
            });
            if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
        };
    }, []); // scene is built once; live state flows through stateRef

    return <div ref={mountRef} className={`topology-canvas ${compact ? 'is-compact' : ''}`} />;
}
