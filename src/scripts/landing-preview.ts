import {formatReconstructionModel} from '../lib/snapspace-client';

interface DemoScan {
    id: string;
    label: string;
    file: string;
    points: number;
    source_points: number;
    model: string | null;
    checkpoint: string | null;
}

type ViewerModule = typeof import('./viewer');

const section = document.getElementById('scan-preview');
const stage = document.getElementById('scan-preview-stage');
const loadBtn = document.getElementById('scan-preview-load') as HTMLButtonElement | null;
const nextBtn = document.getElementById('scan-preview-next') as HTMLButtonElement | null;
const loadingEl = document.getElementById('scan-preview-loading');
const progressEl = document.getElementById('scan-preview-progress');
const countEl = document.getElementById('scan-preview-count');
const modelEl = document.getElementById('scan-preview-model');
const sizeSlider = document.getElementById('scan-preview-slider') as HTMLInputElement | null;
const errorEl = document.getElementById('scan-preview-error');

const PREVIEW_POINT_SIZE = 0.016;

if (section && stage && loadBtn && nextBtn && loadingEl && progressEl && countEl && modelEl && sizeSlider && errorEl) {
    let viewerPromise: Promise<ViewerModule> | null = null;
    let scans: DemoScan[] = [];
    let currentIndex = -1;
    let busy = false;

    // three.js is pulled in only once the preview scrolls close to the
    // viewport, so a visitor who never reaches this section pays nothing.
    function ensureViewer(): Promise<ViewerModule> {
        if (!viewerPromise) {
            viewerPromise = import('./viewer').then((viewer) => {
                viewer.initViewer(stage!);
                viewer.showEmptyGrid();
                viewer.setInteractionEnabled(false); // no orbiting an empty grid
                return viewer;
            });
        }
        return viewerPromise;
    }

    const observer = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) {
            observer.disconnect();
            ensureViewer().catch(() => {});
        }
    }, {rootMargin: '300px'});
    observer.observe(section);

    sizeSlider.addEventListener('input', () => {
        viewerPromise?.then(viewer => viewer.setPointSize(parseFloat(sizeSlider.value)));
    });

    async function showScan(index: number): Promise<void> {
        if (busy) return;
        busy = true;
        nextBtn!.disabled = true;
        loadBtn!.classList.add('hidden');
        errorEl!.classList.add('hidden');
        loadingEl!.classList.remove('hidden');
        progressEl!.textContent = 'Loading…';

        const firstLoad = currentIndex < 0;
        try {
            const viewer = await ensureViewer();
            const scan = scans[index];

            const buffer = await fetchScan(scan.file, (fraction) => {
                progressEl!.textContent = `Downloading… ${Math.round(fraction * 100)} %`;
            });

            await viewer.loadPointCloudFromBuffer(buffer, (msg) => {
                progressEl!.textContent = msg;
            });

            currentIndex = index;
            countEl!.textContent = `${viewer.getPointCount().toLocaleString('de-DE')} Points`;
            const modelLabel = formatReconstructionModel({model: scan.model, checkpoint: scan.checkpoint});
            modelEl!.textContent = modelLabel ?? '';
            if (modelLabel && scan.checkpoint) modelEl!.title = scan.checkpoint;

            sizeSlider!.value = String(PREVIEW_POINT_SIZE);
            sizeSlider!.disabled = false;
            viewer.setPointSize(PREVIEW_POINT_SIZE);
            viewer.dollyCamera(0.9); // the preview box is small — frame it tighter
            viewer.setMinCameraElevation(20); // level cameras hide the floor grid edge-on
            viewer.setInteractionEnabled(true);

            loadingEl!.classList.add('hidden');
            nextBtn!.classList.remove('hidden');
            stage!.classList.add('loaded');
        } catch (err) {
            loadingEl!.classList.add('hidden');
            if (firstLoad) loadBtn!.classList.remove('hidden');
            errorEl!.textContent = `Could not load the scan (${err instanceof Error ? err.message : err}).`;
            errorEl!.classList.remove('hidden');
        } finally {
            busy = false;
            nextBtn!.disabled = false;
        }
    }

    loadBtn.addEventListener('click', async () => {
        if (busy) return;
        try {
            if (scans.length === 0) scans = await fetchManifest();
        } catch (err) {
            errorEl.textContent = `Could not load the scan (${err instanceof Error ? err.message : err}).`;
            errorEl.classList.remove('hidden');
            return;
        }
        // Random entry point, then the Next button walks the list in order.
        await showScan(Math.floor(Math.random() * scans.length));
    });

    nextBtn.addEventListener('click', () => {
        if (busy || scans.length === 0) return;
        void showScan((currentIndex + 1) % scans.length);
    });
}

async function fetchManifest(): Promise<DemoScan[]> {
    const res = await fetch('/demo/manifest.json');
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const scans = await res.json() as DemoScan[];
    if (!Array.isArray(scans) || scans.length === 0) throw new Error('no demo scans');
    return scans;
}

async function fetchScan(url: string, onProgress: (fraction: number) => void): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);

    const total = parseInt(res.headers.get('Content-Length') || '0', 10);
    if (!total || !res.body) return res.arrayBuffer();

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(Math.min(received / total, 1));
    }

    const buf = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        buf.set(chunk, offset);
        offset += chunk.length;
    }
    return buf.buffer;
}

export {};
