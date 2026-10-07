// Sequence preview viewer: map + trajectory, magnetometer coloring, curtain, linked plot,
// other runs overlay, playback with camera thumbnails, satellite basemap.
// Data from scripts/export_preview.py (<seq>.bin, <seq>_thumbs.jpg, runs.json).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const DATA = 'assets/preview';
const AVAILABLE = new Set([
    'library_day_fwd_03', 'campus_day_fwd_04', 'campus_day_rev_05', 'circle_day_fwd_rev_06',
    'campus_day_rev_07', 'campus_day_fwd_08', 'campus_day_fwd_09', 'circle_day_fwd_rev_10',
    'campus_night_rev_11', 'campus_circle_night_rev_12',
    'campus_day_fwd_01', 'campus_night_fwd_00', 'circle_day_fwd_rev_02', 'circle_night_fwd_rev_00',
]);
// Path coloring: elapsed time, or magnetometer on a range shared by all sequences
// (1–99 % of the calibrated sequences, so uncalibrated ones saturate)
const PATH_MODES = [
    { key: 'time' },
    { key: '|M|', lo: 15, hi: 55 },
    { key: 'Mx', lo: -45, hi: 45, axis: 0 },
    { key: 'My', lo: -45, hi: 45, axis: 1 },
    { key: 'Mz', lo: -20, hi: 20, axis: 2 },
];
const THUMB = { period: 5, w: 192, h: 108, cols: 16 };  // matches export_preview.py
const PLAY_SPEED = 30;  // x real time
// WGS84 -> map frame (UTM 52N minus ORIGIN), affine fit on paired GT poses (max err 4 mm)
const LON0 = 128.455, LAT0 = 35.704;
const GEO = [90462.17081520878, 616.3126563683446, 97.30563621836245,
    -503.1302461776269, 110910.92617553701, -224.61525661912822];
const SAT_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

const $ = id => document.getElementById(id);
const box = $('preview'), msg = $('preview-msg'), info = $('preview-info');
const START = new THREE.Color(0x22c55e), END = new THREE.Color(0xef4444);
const ramp = (t, c) => c.setHSL(0.7 * (1 - t), 0.9, 0.5);  // blue (low) → red (high)
const clamp01 = v => Math.min(Math.max(v, 0), 1);

let renderer, scene, camera, controls, lineMat, runMat, loadId = 0;
let objects = [], bounds, cur = null, runs = null;
let colorMode = 'rgb', pathMode = 1, showCurtain = false, showRuns = false, showSat = true;
let hoverIdx = null, playing = false, playT = 0, lastFrame = 0;
const satGroup = new THREE.Group(), satCache = new Map(), texLoader = new THREE.TextureLoader();
let hoverDot, curtain = null, runLines = [];

const render = () => renderer && renderer.render(scene, camera);
const mode = () => (cur && cur.mag ? PATH_MODES[pathMode] : PATH_MODES[0]);
const valueMode = () => (mode().key === 'time' ? PATH_MODES[1] : mode());  // curtain/plot need a value
const valueAt = (mag, i, m) => (m.axis === undefined
    ? Math.hypot(mag[3 * i], mag[3 * i + 1], mag[3 * i + 2]) : mag[3 * i + m.axis]);

function init() {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    box.prepend(renderer.domElement);
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1418);
    scene.add(satGroup);
    camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
    camera.up.set(0, 0, 1);  // data is z-up (UTM)
    controls = new OrbitControls(camera, renderer.domElement);
    controls.addEventListener('change', render);
    lineMat = new LineMaterial({ linewidth: 4, vertexColors: true, depthTest: false });
    runMat = new LineMaterial({ linewidth: 2, vertexColors: true, depthTest: false, transparent: true, opacity: 0.75 });
    new ResizeObserver(() => {
        const w = box.clientWidth, h = box.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        lineMat.resolution.set(w, h);
        runMat.resolution.set(w, h);
        drawPlot();
        render();
    }).observe(box);
    hoverDot = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)),
        new THREE.PointsMaterial({ color: 0xfacc15, size: 16, sizeAttenuation: false, depthTest: false }));
    hoverDot.renderOrder = 3;
    hoverDot.visible = false;
    scene.add(hoverDot);

    box.querySelectorAll('[hidden]').forEach(el => el.hidden = false);
    box.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
    $('preview-path').onclick = () => { pathMode = (pathMode + 1) % PATH_MODES.length; applyPath(); };
    $('preview-color').onclick = () => { colorMode = colorMode === 'rgb' ? 'height' : 'rgb'; applyColors(); };
    $('preview-curtain').onclick = () => {
        showCurtain = !showCurtain;
        buildCurtain();
        if (showCurtain && camera.position.z - controls.target.z > 0.9 * camera.position.distanceTo(controls.target)) setView('3d');
    };
    $('preview-runs').onclick = () => { showRuns = !showRuns; buildRuns(); };
    $('preview-sat').onclick = () => { showSat = !showSat; satGroup.visible = showSat; updateButtons(); render(); };
    $('preview-play').onclick = () => (playing ? stop() : play());

    const plot = $('preview-plot');
    plot.onmousemove = e => {
        if (!cur) return;
        const r = plot.getBoundingClientRect(), { x0, x1 } = plotArea(r.width);
        const t = clamp01((e.clientX - r.left - x0) / (x1 - x0)) * cur.t[cur.n - 1];
        setHover(indexAt(t));
    };
    plot.onmouseleave = () => { if (!playing) setHover(null); };
    let dragging = false;
    renderer.domElement.addEventListener('pointerdown', () => dragging = true);
    addEventListener('pointerup', () => dragging = false);
    renderer.domElement.addEventListener('pointermove', e => { if (!dragging && !playing) hoverFromScreen(e); });
    renderer.domElement.addEventListener('pointerleave', () => { if (!playing) setHover(null); });
}

// ── map / path ──────────────────────────────────────────────────────────────
function parse(buf) {
    const [nMap, nTraj] = new Int32Array(buf, 0, 2);
    const off = new Float32Array(buf, 8, 3);
    const q = new Uint16Array(buf, 20, nMap * 3);
    const trajOff = 20 + Math.ceil(nMap * 3 / 2) * 4;
    const traj = new Float32Array(buf, trajOff, nTraj * 3);
    const rgbOff = trajOff + nTraj * 12;
    const rgb = buf.byteLength >= rgbOff + nMap * 3 ? new Uint8Array(buf, rgbOff, nMap * 3) : null;
    const magOff = rgbOff + Math.ceil(nMap * 3 / 4) * 4;
    const mag = buf.byteLength >= magOff + nTraj * 12 ? new Float32Array(buf, magOff, nTraj * 3) : null;
    const pos = new Float32Array(nMap * 3);
    for (let i = 0; i < pos.length; i++) pos[i] = q[i] * 0.01 + off[i % 3];
    return { pos, traj, rgb, mag };
}

function heightColors(pos, zs) {
    const lo = zs[Math.floor(zs.length * 0.02)], hi = zs[Math.floor(zs.length * 0.98)];
    const col = new Float32Array(pos.length), c = new THREE.Color();
    for (let i = 0; i < pos.length; i += 3) {
        c.setHSL(0.62 - 0.5 * clamp01((pos[i + 2] - lo) / (hi - lo)), 0.5, 0.28 + 0.2 * clamp01((pos[i + 2] - lo) / (hi - lo)));
        col.set([c.r, c.g, c.b], i);
    }
    return col;
}

function applyColors() {
    const m = cur.mapColors.rgb ? colorMode : 'height';
    cur.mapGeom.setAttribute('color', cur.mapColors[m]);
    $('preview-color').textContent = m === 'rgb' ? 'Color: RGB' : 'Color: Height';
    $('preview-color').hidden = !cur.mapColors.rgb;
    $('preview-color-label').textContent = m === 'rgb' ? 'camera RGB' : 'height';
    render();
}

function pathColors(n, mag, m) {
    const tc = new Float32Array(n * 3), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
        if (m.key === 'time') c.lerpColors(START, END, i / (n - 1));
        else ramp(clamp01((valueAt(mag, i, m) - m.lo) / (m.hi - m.lo)), c);
        tc.set([c.r, c.g, c.b], i * 3);
    }
    return tc;
}

function applyPath() {
    const m = mode(), c = new THREE.Color();
    cur.pathGeom.setColors(pathColors(cur.n, cur.mag, m));
    $('preview-path').textContent = `Path: ${m.key}`;
    $('preview-path').hidden = !cur.mag;
    const cbar = $('preview-cbar');
    cbar.hidden = m.key === 'time';
    if (!cbar.hidden) {
        const stops = [0, 0.25, 0.5, 0.75, 1].map(t => ramp(t, c).getStyle());
        $('cbar-grad').style.background = `linear-gradient(to top, ${stops.join(', ')})`;
        $('cbar-title').textContent = `${m.key} (µT)`;
        $('cbar-ticks').innerHTML = [m.hi, (m.lo + m.hi) / 2, m.lo].map(v => `<span>${v}</span>`).join('');
    }
    buildCurtain();
    buildRuns();
    drawPlot();
}

function setView(v) {
    const c = bounds.getCenter(new THREE.Vector3()), s = bounds.getSize(new THREE.Vector3()), d = Math.max(s.x, s.y);
    const side = showCurtain ? new THREE.Vector3(0, -d * 1.05, d * 0.5) : new THREE.Vector3(0, -d * 0.95, d * 0.8);  // lower angle shows the curtain
    camera.position.copy(c).add(v === 'top' ? new THREE.Vector3(0, -0.01, d * 1.25) : side);
    controls.target.copy(c);
    controls.update();
    render();
}

// ── 1. magnetic curtain: vertical ribbon, height + color = field value ──────
function buildCurtain() {
    if (curtain) { scene.remove(curtain); curtain.geometry.dispose(); curtain = null; }
    if (showCurtain && cur.mag) {
        const m = valueMode(), n = cur.n, L = cur.lift, hMax = 0.12 * cur.extent;
        const pos = new Float32Array(n * 6), col = new Float32Array(n * 8), idx = [], c = new THREE.Color();
        for (let i = 0; i < n; i++) {
            const t = clamp01((valueAt(cur.mag, i, m) - m.lo) / (m.hi - m.lo));
            ramp(t, c);
            pos.set([L[3 * i], L[3 * i + 1], L[3 * i + 2], L[3 * i], L[3 * i + 1], L[3 * i + 2] + 0.5 + hMax * t], i * 6);
            col.set([c.r, c.g, c.b, 0.12, c.r, c.g, c.b, 0.85], i * 8);
            if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 4));
        g.setIndex(idx);
        curtain = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
        curtain.renderOrder = 1;
        scene.add(curtain);
    }
    updateButtons();
    render();
}

// ── 3. other runs of the same route ─────────────────────────────────────────
const routeOf = s => (s.startsWith('campus_circle') ? ['campus', 'circle'] : [s.split('_')[0]]);
function otherRuns() {
    if (!runs || !cur) return [];
    const mine = routeOf(cur.seq);
    return Object.keys(runs).filter(s => s !== cur.seq && routeOf(s).some(r => mine.includes(r)));
}

function buildRuns() {
    runLines.forEach(l => { scene.remove(l); l.geometry.dispose(); });
    runLines = [];
    if (showRuns) {
        const m = mode();
        for (const s of otherRuns()) {
            const r = runs[s], n = r.t.length;
            const lg = new LineGeometry();
            lg.setPositions(r.xyz.map((v, i) => (i % 3 === 2 ? v + 0.8 : v)));
            lg.setColors(m.key === 'time' ? new Float32Array(n * 3).fill(0.6) : pathColors(n, r.mag, m));
            const line = new Line2(lg, runMat);
            line.renderOrder = 0.5;
            runLines.push(line);
        }
        if (runLines.length) scene.add(...runLines);
    }
    updateButtons();
    render();
}

// ── 5. satellite basemap (Esri World Imagery tiles, placed via the affine fit) ──
const toMap = (lon, lat) => [GEO[0] * (lon - LON0) + GEO[1] * (lat - LAT0) + GEO[2],
    GEO[3] * (lon - LON0) + GEO[4] * (lat - LAT0) + GEO[5]];
function toGeo(x, y) {  // inverse of toMap
    const [a, b, c, d, e, f] = GEO, det = a * e - b * d;
    return [LON0 + (e * (x - c) - b * (y - f)) / det, LAT0 + (a * (y - f) - d * (x - c)) / det];
}
const tileLon = (x, z) => x / 2 ** z * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;
const lonTile = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const latTile = (lat, z) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);

function buildSatellite(zGround) {
    satGroup.clear();
    const pad = 0.15 * cur.extent, z = cur.extent < 250 ? 19 : 18;
    const [lonA, latA] = toGeo(bounds.min.x - pad, bounds.min.y - pad);
    const [lonB, latB] = toGeo(bounds.max.x + pad, bounds.max.y + pad);
    for (let tx = lonTile(lonA, z); tx <= lonTile(lonB, z); tx++) {
        for (let ty = latTile(latB, z); ty <= latTile(latA, z); ty++) {
            const key = `${z}/${tx}/${ty}`;
            if (!satCache.has(key)) {
                const tex = texLoader.load(SAT_URL(z, tx, ty), render);
                tex.colorSpace = THREE.SRGBColorSpace;
                satCache.set(key, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.8, depthWrite: false }));
            }
            const corners = [[tx, ty + 1], [tx + 1, ty + 1], [tx + 1, ty], [tx, ty]]
                .map(([x, y]) => [...toMap(tileLon(x, z), tileLat(y, z)), zGround]);
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(corners.flat()), 3));
            g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
            g.setIndex([0, 1, 2, 0, 2, 3]);
            const mesh = new THREE.Mesh(g, satCache.get(key));
            mesh.renderOrder = -1;
            satGroup.add(mesh);
        }
    }
    satGroup.visible = showSat;
}

// ── 2. linked plot + 4. playback with camera thumbnails ─────────────────────
const plotArea = w => ({ x0: 44, x1: w - 12, y0: 10, y1: 108 });
function indexAt(t) {  // last trajectory point with time <= t
    let lo = 0, hi = cur.n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cur.t[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
}

function drawPlot() {
    const cv = $('preview-plot');
    if (!cur || !cur.mag) { cv.hidden = true; return; }
    cv.hidden = false;
    const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(devicePixelRatio, 2);
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d'), { x0, x1, y0, y1 } = plotArea(w), m = valueMode(), T = cur.t[cur.n - 1], c = new THREE.Color();
    g.scale(dpr, dpr);
    g.fillStyle = '#0b1418'; g.fillRect(0, 0, w, h);
    g.font = '11px "Segoe UI", sans-serif'; g.fillStyle = '#94a3b8'; g.strokeStyle = 'rgba(255,255,255,0.08)';
    const X = t => x0 + (x1 - x0) * t / T, Y = v => y1 - (y1 - y0) * clamp01((v - m.lo) / (m.hi - m.lo));
    for (const v of [m.lo, (m.lo + m.hi) / 2, m.hi]) {
        g.beginPath(); g.moveTo(x0, Y(v)); g.lineTo(x1, Y(v)); g.stroke();
        g.textAlign = 'right'; g.fillText(v, x0 - 6, Y(v) + 4);
    }
    const step = T > 600 ? 200 : T > 200 ? 50 : 20;
    g.textAlign = 'center';
    for (let t = 0; t <= T; t += step) g.fillText(`${t}s`, X(t), y1 + 16);
    g.textAlign = 'left'; g.fillText(`${m.key} (µT)`, x0 + 4, y0 + 10);
    g.lineWidth = 1.5;
    for (let i = 1; i < cur.n; i++) {
        const v = valueAt(cur.mag, i, m);
        g.strokeStyle = ramp(clamp01((v - m.lo) / (m.hi - m.lo)), c).getStyle();
        g.beginPath(); g.moveTo(X(cur.t[i - 1]), Y(valueAt(cur.mag, i - 1, m))); g.lineTo(X(cur.t[i]), Y(v)); g.stroke();
    }
    if (hoverIdx !== null) {
        g.strokeStyle = '#facc15'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(X(cur.t[hoverIdx]), y0); g.lineTo(X(cur.t[hoverIdx]), y1); g.stroke();
    }
}

function setHover(i) {
    hoverIdx = i;
    const thumb = $('preview-thumb');
    if (i === null) { hoverDot.visible = false; thumb.hidden = true; drawPlot(); render(); return; }
    hoverDot.geometry.attributes.position.array.set(cur.lift.subarray(3 * i, 3 * i + 3));
    hoverDot.geometry.attributes.position.needsUpdate = true;
    hoverDot.visible = true;
    const k = Math.round(cur.t[i] / THUMB.period), img = $('thumb-img');
    img.style.backgroundImage = `url(${DATA}/${cur.seq}_thumbs.jpg)`;
    img.style.backgroundPosition = `-${(k % THUMB.cols) * THUMB.w}px -${Math.floor(k / THUMB.cols) * THUMB.h}px`;
    const m = valueMode();
    $('thumb-cap').textContent = `t = ${cur.t[i].toFixed(0)} s` + (cur.mag ? ` · ${m.key} = ${valueAt(cur.mag, i, m).toFixed(1)} µT` : '');
    thumb.hidden = false;
    drawPlot();
    render();
}

function hoverFromScreen(e) {
    if (!cur) return;
    const r = renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3();
    let best = null, bestD = 12 * 12;
    for (let i = 0; i < cur.n; i++) {
        v.set(cur.lift[3 * i], cur.lift[3 * i + 1], cur.lift[3 * i + 2]).project(camera);
        const dx = (v.x + 1) / 2 * r.width - (e.clientX - r.left), dy = (1 - v.y) / 2 * r.height - (e.clientY - r.top);
        if (dx * dx + dy * dy < bestD) { bestD = dx * dx + dy * dy; best = i; }
    }
    if (best !== hoverIdx) setHover(best);
}

function play() {
    playing = true;
    if (hoverIdx === null || hoverIdx >= cur.n - 1) playT = 0;
    else playT = cur.t[hoverIdx];
    lastFrame = performance.now();
    updateButtons();
    requestAnimationFrame(tick);
}
function stop() { playing = false; updateButtons(); }
function tick(now) {
    if (!playing || !cur) return;
    playT += (now - lastFrame) / 1000 * PLAY_SPEED;
    lastFrame = now;
    if (playT >= cur.t[cur.n - 1]) { setHover(cur.n - 1); stop(); return; }
    setHover(indexAt(playT));
    requestAnimationFrame(tick);
}

function updateButtons() {
    if (!cur) return;
    $('preview-curtain').textContent = `Curtain: ${showCurtain ? 'on' : 'off'}`;
    $('preview-curtain').hidden = !cur.mag;
    const nRuns = otherRuns().length;
    $('preview-runs').textContent = `Other runs: ${showRuns ? `on (${nRuns})` : 'off'}`;
    $('preview-runs').hidden = !nRuns;
    $('preview-sat').textContent = `Satellite: ${showSat ? 'on' : 'off'}`;
    $('preview-sat-credit').hidden = !showSat;
    $('preview-play').textContent = playing ? '❚❚ Pause' : '▶ Play';
}

// ── load ────────────────────────────────────────────────────────────────────
async function load(seq) {
    if (!renderer) init();
    const id = ++loadId;
    stop();
    msg.textContent = `Loading ${seq} …`;
    msg.hidden = false;
    let data;
    try {
        const [res] = await Promise.all([fetch(`${DATA}/${seq}.bin`),
            runs ? null : fetch(`${DATA}/runs.json`).then(r => r.json()).then(j => { runs = j; }).catch(() => { })]);
        if (!res.ok) throw new Error(res.status);
        data = parse(await res.arrayBuffer());
    } catch (e) {
        if (id === loadId) msg.textContent = `Failed to load ${seq} (${e.message}).`;
        return;
    }
    if (id !== loadId) return;  // a newer click won

    objects.forEach(o => { scene.remove(o); o.geometry.dispose(); });
    const { pos, traj, rgb, mag } = data, n = traj.length / 3;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeBoundingBox();
    bounds = g.boundingBox;
    const size = bounds.getSize(new THREE.Vector3());
    const zs = pos.filter((_, i) => i % 3 === 2).sort();
    const lift = traj.map((v, i) => (i % 3 === 2 ? v + 1 : v));  // draw above ground
    const pathGeom = new LineGeometry();
    pathGeom.setPositions(lift);
    cur = {
        seq, n, mag, lift, pathGeom, mapGeom: g, extent: Math.max(size.x, size.y),
        t: runs && runs[seq] && runs[seq].t.length === n ? runs[seq].t : Array.from({ length: n }, (_, i) => i * 0.5),
        mapColors: { height: new THREE.BufferAttribute(heightColors(pos, zs), 3), rgb: rgb && new THREE.BufferAttribute(rgb, 3, true) },
    };
    applyColors();
    const points = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true }));
    const line = new Line2(pathGeom, lineMat);
    line.renderOrder = 1;
    const dot = (k, color) => {  // fixed screen-size marker, drawn on top
        const m = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(lift.slice(k, k + 3), 3)),
            new THREE.PointsMaterial({ color, size: 14, sizeAttenuation: false, depthTest: false }));
        m.renderOrder = 2;
        return m;
    };
    objects = [points, line, dot(0, 0x22c55e), dot(traj.length - 3, 0xef4444)];
    scene.add(...objects);
    buildSatellite(zs[Math.floor(zs.length * 0.03)] - 0.5);

    info.innerHTML = `<b>${seq}</b><br>${(pos.length / 3).toLocaleString()} map points (0.3 m voxel) · ${cur.t[n - 1].toFixed(0)} s`;
    msg.hidden = true;
    setHover(null);
    applyPath();
    setView(showCurtain ? '3d' : 'top');
}

document.querySelectorAll('.seq-table tbody tr:not(.seq-group)').forEach(tr => {
    const seq = tr.cells[0].textContent.trim();
    if (!AVAILABLE.has(seq)) { tr.title = 'Preview coming soon'; return; }
    tr.classList.add('has-preview');
    tr.onclick = () => {
        document.querySelectorAll('.seq-table tr.active').forEach(r => r.classList.remove('active'));
        tr.classList.add('active');
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        load(seq);
    };
});
