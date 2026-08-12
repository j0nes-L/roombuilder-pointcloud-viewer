import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {PLYLoader} from 'three/addons/loaders/PLYLoader.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

export interface ColmapCameraData {
    px: number; py: number; pz: number;
    rx: number; ry: number; rz: number; rw: number;
    name: string;
}

interface ColmapCamObject {
    group: THREE.Group;
    mats: THREE.MeshStandardMaterial[];
    data: ColmapCameraData;
    worldPos: THREE.Vector3;
    worldQuat: THREE.Quaternion;
}

const DEFAULT_POINT_SIZE = 0.005;
const BACKGROUND_COLOR = 0x111111;

let scene: THREE.Scene;
let gridScene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let currentPoints: THREE.Points | null = null;
let animationId: number | null = null;
let container: HTMLElement;
let pointSizeMultiplier = 1.0;
let hasPerPointScale = false;
let lastPointCount = 0;

let flyMode = false;
let flyYaw = 0;
let flyPitch = 0;
const flyKeys: Record<string, boolean> = {};
const FLY_SPEED_BASE = 1.0;
let flySpeed = FLY_SPEED_BASE;
let clockDelta = 0;
const clock = new THREE.Clock();
let rightMouseDown = false;
let gridMesh: THREE.Mesh | null = null;

let interactionEnabled = true;
let colmapGroup: THREE.Group | null = null;
let colmapCamObjects: ColmapCamObject[] = [];
let colmapHoverCb: ((data: ColmapCameraData | null, x: number, y: number, pos?: THREE.Vector3, quat?: THREE.Quaternion) => void) | null = null;
let colmapRaycaster: THREE.Raycaster | null = null;

const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches);
const HW_CONCURRENCY = navigator.hardwareConcurrency || 4;
const DEVICE_MEMORY: number = ((navigator as any).deviceMemory) || 4;
const IS_LOW_END = IS_MOBILE || HW_CONCURRENCY <= 4 || DEVICE_MEMORY <= 4;

const MAX_PIXEL_RATIO = IS_LOW_END ? 1.25 : 2.0;
const MAX_POINTS_LOW_END = 800_000;
const MAX_POINTS_DESKTOP = 2_500_000;
const MAX_POINTS = IS_LOW_END ? MAX_POINTS_LOW_END : MAX_POINTS_DESKTOP;

export function initViewer(containerEl: HTMLElement): void {
    container = containerEl;

    scene = new THREE.Scene();
    gridScene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(
        75,
        container.clientWidth / container.clientHeight,
        0.0001,
        100000
    );

    renderer = new THREE.WebGLRenderer({
        antialias: !IS_LOW_END,
        powerPreference: IS_LOW_END ? 'low-power' : 'high-performance',
        alpha: false,
    });
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setClearColor(BACKGROUND_COLOR, 1);
    renderer.autoClear = false;
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.enablePan = true;
    controls.screenSpacePanning = true;

    controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
    };

    camera.position.set(0, 0, 3);
    controls.update();

    const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', ' ']);

    renderer.domElement.addEventListener('mousedown', (e) => {
        if (e.button === 2) rightMouseDown = true;
    });
    renderer.domElement.addEventListener('mouseup', (e) => {
        if (e.button === 2) {
            rightMouseDown = false;
            if (flyMode) exitFlyMode();
        }
    });
    renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    renderer.domElement.addEventListener('mousemove', (e) => {
        if (!flyMode || !rightMouseDown) return;
        flyYaw -= e.movementX * 0.002;
        flyPitch -= e.movementY * 0.002;
        flyPitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, flyPitch));
        updateFlyCameraRotation();
    });

    window.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();
        flyKeys[key] = true;
        if (key === 'shift') flySpeed = FLY_SPEED_BASE * 3;
        if (FLY_KEYS.has(key) && rightMouseDown && !flyMode && interactionEnabled) {
            enterFlyMode();
        }
    });
    window.addEventListener('keyup', (e) => {
        const key = e.key.toLowerCase();
        flyKeys[key] = false;
        if (key === 'shift') flySpeed = FLY_SPEED_BASE;
        if (flyMode && ![...FLY_KEYS].some((k) => flyKeys[k])) {
            exitFlyMode();
        }
    });

    window.addEventListener('resize', onResize);
    clock.start();
    animate();
}

function enterFlyMode(): void {
    flyMode = true;
    controls.saveState();
    controls.enabled = false;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    flyYaw = euler.y;
    flyPitch = euler.x;
}

function exitFlyMode(): void {
    flyMode = false;
    controls.enabled = true;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    controls.target.copy(camera.position).add(dir.multiplyScalar(2));
    controls.update();
}

function updateFlyCameraRotation(): void {
    const q = new THREE.Quaternion();
    q.setFromEuler(new THREE.Euler(flyPitch, flyYaw, 0, 'YXZ'));
    camera.quaternion.copy(q);
}

function updateFlyMovement(dt: number): void {
    if (!flyMode) return;

    const speed = flySpeed * dt;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const worldUp = new THREE.Vector3(0, 1, 0);

    if (flyKeys['w']) camera.position.addScaledVector(forward, speed);
    if (flyKeys['s']) camera.position.addScaledVector(forward, -speed);
    if (flyKeys['d']) camera.position.addScaledVector(right, speed);
    if (flyKeys['a']) camera.position.addScaledVector(right, -speed);
    if (flyKeys['e'] || flyKeys[' ']) camera.position.addScaledVector(worldUp, speed);
    if (flyKeys['q']) camera.position.addScaledVector(worldUp, -speed);
}

export function unloadPointCloud(): void {
    if (currentPoints) {
        scene.remove(currentPoints);
        currentPoints.geometry.dispose();
        if (currentPoints.material instanceof THREE.Material) {
            currentPoints.material.dispose();
        }
        currentPoints = null;
    }
    if (gridMesh) {
        gridScene.remove(gridMesh);
        gridMesh.geometry.dispose();
        (gridMesh.material as THREE.Material).dispose();
        gridMesh = null;
    }
    lastPointCount = 0;
}

export function getPointCount(): number {
    return lastPointCount;
}

export async function loadPointCloudFromBuffer(
    buffer: ArrayBuffer,
    onProgress?: (msg: string) => void,
): Promise<void> {
    unloadColmapCameras();
    unloadPointCloud();
    pointSizeMultiplier = 1.0;

    onProgress?.('Parsing geometry…');

    const loader = new PLYLoader();
    const geometry = loader.parse(buffer);

    const origCount = geometry.getAttribute('position').count;
    if (origCount > MAX_POINTS) {
        onProgress?.(`Subsampling (${(origCount / 1_000_000).toFixed(1)}M → ${(MAX_POINTS / 1_000_000).toFixed(1)}M)…`);
        decimateGeometry(geometry, MAX_POINTS);
    }

    onProgress?.('Processing colors…');

    if (geometry.hasAttribute('color')) {
        const colorAttr = geometry.getAttribute('color');
        const arr = colorAttr.array as Float32Array;
        let maxVal = 0;
        const len = Math.min(arr.length, 3000);
        for (let i = 0; i < len; i++) {
            if (arr[i] > maxVal) maxVal = arr[i];
        }
        if (maxVal > 1.5) {
            const scale = 1 / 255;
            for (let i = 0; i < arr.length; i++) arr[i] *= scale;
            colorAttr.needsUpdate = true;
        }
    }

    hasPerPointScale = false;

    onProgress?.('Aligning…');

    const posC = geometry.getAttribute('position');
    const arrC = posC.array as Float32Array;
    for (let i = 0; i < arrC.length; i += 3) {
        arrC[i] = -arrC[i];
    }
    posC.needsUpdate = true;

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    const cx = (bb.max.x + bb.min.x) / 2;
    const cy = (bb.max.y + bb.min.y) / 2;
    const cz = (bb.max.z + bb.min.z) / 2;
    for (let i = 0; i < arrC.length; i += 3) {
        arrC[i] -= cx;
        arrC[i + 1] -= cy;
        arrC[i + 2] -= cz;
    }
    posC.needsUpdate = true;

    geometry.computeBoundingBox();
    const minY = geometry.boundingBox!.min.y;
    const posAttr2 = geometry.getAttribute('position');
    const arr2 = posAttr2.array as Float32Array;
    for (let i = 1; i < arr2.length; i += 3) {
        arr2[i] -= minY;
    }
    posAttr2.needsUpdate = true;

    onProgress?.('Building renderer…');
    const hasColors = geometry.hasAttribute('color');
    const material = buildMaterial(hasColors);

    const points = new THREE.Points(geometry, material);
    scene.add(points);
    currentPoints = points;

    lastPointCount = geometry.getAttribute('position').count;

    geometry.computeBoundingSphere();
    const radius = geometry.boundingSphere!.radius;

    if (radius > 0) {
        flySpeed = radius * 0.5;
        updateGrid(radius);

        camera.near = radius * 0.001;
        camera.far = radius * 100;
        camera.updateProjectionMatrix();

        geometry.computeBoundingBox();
        const centerY = geometry.boundingBox ? (geometry.boundingBox.max.y + geometry.boundingBox.min.y) / 2 : 0;
        const maxY = geometry.boundingBox ? geometry.boundingBox.max.y : radius;
        controls.target.set(0, centerY, 0);
        controls.minDistance = 0;
        controls.maxDistance = radius * 10;
        controls.zoomSpeed = 3.0;

        camera.position.set(0, Math.max(centerY, maxY * 0.5), radius * 2.0);
        controls.update();
        controls.saveState();
    }

    onProgress?.('Point cloud loaded');
}

export function setInteractionEnabled(enabled: boolean): void {
    interactionEnabled = enabled;
    if (flyMode && !enabled) exitFlyMode();
    if (controls) controls.enabled = enabled;
}

export function dollyCamera(factor: number): void {
    if (!camera || !controls) return;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    camera.position.copy(controls.target).addScaledVector(dir, factor);
    controls.update();
    controls.saveState();
}

export function setMinCameraElevation(degrees: number): void {
    if (!camera || !controls) return;
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const maxPhi = THREE.MathUtils.degToRad(90 - degrees);
    if (spherical.phi <= maxPhi) return;
    spherical.phi = maxPhi;
    offset.setFromSpherical(spherical);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    controls.saveState();
}

export function showEmptyGrid(radius = 4): void {
    updateGrid(radius);
    camera.near = radius * 0.001;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, radius * 0.15, 0);
    camera.position.set(radius * 0.6, radius * 0.5, radius * 1.6);
    controls.update();
    controls.saveState();
}

function updateGrid(radius: number): void {
    if (gridMesh) {
        gridScene.remove(gridMesh);
        gridMesh.geometry.dispose();
        (gridMesh.material as THREE.Material).dispose();
        gridMesh = null;
    }

    const gridScale = radius * 0.5;
    const gridMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        uniforms: {
            uScale: {value: gridScale},
        },
        vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
      }
    `,
        fragmentShader: `
      uniform float uScale;
      varying vec3 vWorldPos;
      void main() {
        vec2 coord = vWorldPos.xz / uScale;
        vec2 width = fwidth(coord);
        vec2 grid = abs(fract(coord - 0.5) - 0.5) / max(width, vec2(1e-6));
        float line = min(grid.x, grid.y);
        float alpha = 1.0 - min(line, 1.0);

        alpha *= 1.0 - smoothstep(0.2, 0.6, max(width.x, width.y));

        float dist = length(vWorldPos.xz);
        alpha *= 1.0 - smoothstep(uScale * 3.0, uScale * 8.0, dist);

        alpha *= 0.25;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(vec3(0.4), alpha);
      }
    `,
    });

    const planeSize = radius * 20;
    const planeGeo = new THREE.PlaneGeometry(planeSize, planeSize);
    planeGeo.rotateX(-Math.PI / 2);
    gridMesh = new THREE.Mesh(planeGeo, gridMat);
    gridMesh.position.y = 0;
    gridScene.add(gridMesh);
}

function onResize(): void {
    if (!container || !camera || !renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
}

let lastW = 0, lastH = 0;

function animate(): void {
    animationId = requestAnimationFrame(animate);
    clockDelta = clock.getDelta();

    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
        lastW = w;
        lastH = h;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
    }

    if (flyMode) {
        updateFlyMovement(clockDelta);
    } else {
        controls.update();
    }

    renderer.clear();
    if (gridMesh) {
        renderer.render(gridScene, camera);
        renderer.clearDepth();
    }
    renderer.render(scene, camera);
}


let camGlbTemplate: THREE.Object3D | null = null;

async function loadCamGlbTemplate(): Promise<THREE.Object3D> {
    if (camGlbTemplate) return camGlbTemplate;
    return new Promise((resolve, reject) => {
        new GLTFLoader().load('/cam.glb', gltf => {
            const model = gltf.scene;
            const bbox = new THREE.Box3().setFromObject(model);
            const size = bbox.getSize(new THREE.Vector3()).length();
            if (size > 0) model.scale.setScalar(1 / size);
            camGlbTemplate = model;
            resolve(model);
        }, undefined, reject);
    });
}

function questPoseToThreeJS(
    px: number, py: number, pz: number,
    rx: number, ry: number, rz: number, rw: number,
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const position = new THREE.Vector3(px, py, -pz);
    const quaternion = new THREE.Quaternion(-rx, -ry, rz, rw);
    return { position, quaternion };
}


let colmapHoveredIndex = -1;

function setColmapHover(index: number): void {
    if (index === colmapHoveredIndex) return;
    colmapHoveredIndex = index;
    colmapCamObjects.forEach((co, i) => {
        const active = i === index;
        const opacity = active ? 1.0 : 0.5;
        co.mats.forEach(m => { m.opacity = opacity; });
    });
}

function onColmapMouseMove(e: MouseEvent): void {
    if (!colmapGroup || !colmapRaycaster) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    colmapRaycaster.setFromCamera(new THREE.Vector2(mx, my), camera);

    const allMeshes: THREE.Mesh[] = [];
    const meshToIdx: Map<THREE.Mesh, number> = new Map();
    colmapCamObjects.forEach((co, i) => {
        co.group.traverse(c => {
            if ((c as THREE.Mesh).isMesh) {
                allMeshes.push(c as THREE.Mesh);
                meshToIdx.set(c as THREE.Mesh, i);
            }
        });
    });

    const hits = colmapRaycaster.intersectObjects(allMeshes, false);
    if (hits.length > 0) {
        const idx = meshToIdx.get(hits[0].object as THREE.Mesh) ?? -1;
        if (idx >= 0) {
            setColmapHover(idx);
            const co = colmapCamObjects[idx];
            colmapHoverCb?.(co.data, e.clientX, e.clientY, co.worldPos, co.worldQuat);
            renderer.domElement.style.cursor = 'pointer';
            return;
        }
    }
    setColmapHover(-1);
    colmapHoverCb?.(null, e.clientX, e.clientY);
    renderer.domElement.style.cursor = '';
}

export async function loadColmapCameras(
    cameras: ColmapCameraData[],
    onHover: (data: ColmapCameraData | null, x: number, y: number, pos?: THREE.Vector3, quat?: THREE.Quaternion) => void,
    onProgress?: (percent: number) => void,
): Promise<void> {
    unloadColmapCameras();
    unloadPointCloud();
    colmapHoverCb = onHover as typeof colmapHoverCb;
    colmapRaycaster = new THREE.Raycaster();
    colmapGroup = new THREE.Group();
    colmapCamObjects = [];
    colmapHoveredIndex = -1;

    const positions = cameras.map(cam =>
        questPoseToThreeJS(cam.px, cam.py, cam.pz, cam.rx, cam.ry, cam.rz, cam.rw)
    );

    const bbox = new THREE.Box3();
    positions.forEach(p => bbox.expandByPoint(p.position));
    const sz = bbox.getSize(new THREE.Vector3());
    const iconScale = Math.max(sz.x, sz.y, sz.z, 0.5) * 0.01;

    const minY = Math.min(...positions.map(p => p.position.y));
    if (minY < iconScale * 0.5) {
        const yShift = iconScale * 0.5 - minY;
        positions.forEach(p => { p.position.y += yShift; });
    }

    let glbTemplate: THREE.Object3D | null = null;
    try { glbTemplate = await loadCamGlbTemplate(); } catch {}

    for (let i = 0; i < cameras.length; i++) {
        if (onProgress && (i % 50 === 0 || i === cameras.length - 1)) {
            onProgress(Math.round(((i + 1) / cameras.length) * 100));
            await new Promise<void>(r => requestAnimationFrame(() => r()));
        }
        const { position, quaternion } = positions[i];
        const group = new THREE.Group();
        group.position.copy(position);
        group.quaternion.copy(quaternion);

        const mats: THREE.MeshStandardMaterial[] = [];

        if (glbTemplate) {
            const clone = glbTemplate.clone(true);
            clone.scale.setScalar(iconScale);
            clone.rotateY(Math.PI / 2);
            clone.traverse(c => {
                if ((c as THREE.Mesh).isMesh) {
                    const m = c as THREE.Mesh;
                    const src = Array.isArray(m.material) ? m.material[0] : m.material;
                    const mat = (src as THREE.MeshStandardMaterial).clone() as THREE.MeshStandardMaterial;
                    mat.color = new THREE.Color(0xc8b8ff);
                    mat.transparent = true;
                    mat.opacity = 0.5;
                    mat.depthWrite = false;
                    m.material = mat;
                    mats.push(mat);
                }
            });
            group.add(clone);
        } else {
            const mat = new THREE.MeshStandardMaterial({
                color: 0xc8b8ff, transparent: true, opacity: 0.5, depthWrite: false,
            });
            group.add(new THREE.Mesh(new THREE.BoxGeometry(iconScale, iconScale * 0.65, iconScale * 0.45), mat));
            mats.push(mat);
        }


        colmapGroup.add(group);
        colmapCamObjects.push({ group, mats, data: cameras[i], worldPos: position.clone(), worldQuat: quaternion.clone() });
    }

    scene.add(colmapGroup);

    const ambient = new THREE.AmbientLight(0xffffff, 0.9);
    ambient.name = '__colmap_ambient__';
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(1, 3, 2);
    dirLight.name = '__colmap_dir__';
    scene.add(dirLight);

    if (colmapGroup.children.length > 0) {
        const box = new THREE.Box3().setFromObject(colmapGroup);
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(sz.x, sz.y, sz.z, 0.5);

        camera.near = maxDim * 0.0001;
        camera.far = maxDim * 200;
        camera.updateProjectionMatrix();
        flySpeed = maxDim * 0.3;

        controls.target.copy(center);
        controls.minDistance = 0;
        controls.maxDistance = maxDim * 20;
        camera.position.set(center.x, center.y + maxDim * 0.5, center.z + maxDim * 2.5);
        controls.update();
        controls.saveState();

        updateGrid(maxDim);
    }

    renderer.domElement.addEventListener('mousemove', onColmapMouseMove);
}


export function unloadColmapCameras(): void {
    renderer?.domElement.removeEventListener('mousemove', onColmapMouseMove);
    if (colmapGroup) {
        scene.remove(colmapGroup);
        colmapGroup.traverse(c => {
            if ((c as THREE.Mesh).isMesh) {
                (c as THREE.Mesh).geometry?.dispose();
                const mat = (c as THREE.Mesh).material;
                if (Array.isArray(mat)) mat.forEach(m => m.dispose());
                else (mat as THREE.Material)?.dispose();
            }
        });
        colmapGroup = null;
    }
    colmapCamObjects = [];
    colmapHoveredIndex = -1;
    colmapHoverCb = null;
    colmapRaycaster = null;

    scene?.children.filter(c => c.name === '__colmap_ambient__' || c.name === '__colmap_dir__')
        .forEach(c => scene.remove(c));

    renderer?.domElement && (renderer.domElement.style.cursor = '');
}


export function disposeViewer(): void {
    if (animationId !== null) cancelAnimationFrame(animationId);
    window.removeEventListener('resize', onResize);
    unloadPointCloud();
    renderer?.dispose();
    controls?.dispose();
}

export function setPointSize(size: number): void {
    if (!currentPoints) return;
    pointSizeMultiplier = size;
    if (hasPerPointScale && currentPoints.material instanceof THREE.ShaderMaterial) {
        currentPoints.material.uniforms.uSizeMultiplier.value = size;
    } else if (currentPoints.material instanceof THREE.PointsMaterial) {
        currentPoints.material.size = size;
    }
}

export function hasScalarScale(): boolean {
    return hasPerPointScale;
}

export function isLowEndDevice(): boolean {
    return IS_LOW_END;
}

function decimateGeometry(geometry: THREE.BufferGeometry, targetCount: number): void {
    const pos = geometry.getAttribute('position');
    const n = pos.count;
    if (n <= targetCount) return;
    const stride = Math.ceil(n / targetCount);
    const newCount = Math.floor(n / stride);

    for (const name of Object.keys(geometry.attributes)) {
        const attr = geometry.getAttribute(name) as THREE.BufferAttribute;
        const itemSize = attr.itemSize;
        const SrcArray = attr.array.constructor as {
            new(len: number): ArrayLike<number> & { set(a: ArrayLike<number>, off: number): void }
        };
        const out = new SrcArray(newCount * itemSize) as Float32Array;
        const src = attr.array as Float32Array;
        for (let i = 0, j = 0; j < newCount; i += stride, j++) {
            for (let k = 0; k < itemSize; k++) {
                out[j * itemSize + k] = src[i * itemSize + k];
            }
        }
        geometry.setAttribute(name, new THREE.BufferAttribute(out, itemSize, attr.normalized));
    }
}

function buildMaterial(hasColors: boolean): THREE.Material {
    if (hasPerPointScale) {
        return new THREE.ShaderMaterial({
            uniforms: {uSizeMultiplier: {value: pointSizeMultiplier}},
            vertexShader: `
        attribute float pointScale;
        ${hasColors ? 'varying vec3 vColor;' : ''}
        uniform float uSizeMultiplier;
        void main() {
          ${hasColors ? 'vColor = color;' : ''}
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float dist = -mvPosition.z;
          float attenuation = 300.0 / max(dist, 0.001);
          float desired = pointScale * uSizeMultiplier * attenuation;
          float minSize = 2.0 * uSizeMultiplier;
          gl_PointSize = max(desired, minSize);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
            fragmentShader: `
        ${hasColors ? 'varying vec3 vColor;' : ''}
        void main() {
          ${hasColors ? 'gl_FragColor = vec4(vColor, 1.0);' : 'gl_FragColor = vec4(1.0);'}
        }
      `,
            vertexColors: hasColors,
        });
    }
    return new THREE.PointsMaterial({
        size: DEFAULT_POINT_SIZE,
        vertexColors: hasColors,
        sizeAttenuation: true,
    });
}
