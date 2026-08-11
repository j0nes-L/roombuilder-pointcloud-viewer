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
const loadingEl = document.getElementById('scan-preview-loading');
const progressEl = document.getElementById('scan-preview-progress');
const countEl = document.getElementById('scan-preview-count');
const modelEl = document.getElementById('scan-preview-model');
const sizeSlider = document.getElementById('scan-preview-slider') as HTMLInputElement | null;
const errorEl = document.getElementById('scan-preview-error');

const PREVIEW_POINT_SIZE = 0.01;

if (section && stage && loadBtn && loadingEl && progressEl && countEl && modelEl && sizeSlider && errorEl) {
    let viewerPromise: Promise<ViewerModule> | null = null;
    let busy = false;

    // three.js is pulled in only once the preview scrolls close to the
    // viewport, so a visitor who never reaches this section pays nothing.
    function ensureViewer(): Promise<ViewerModule> {
        if (!viewerPromise) {
            viewerPromise = import('./viewer').then((viewer) => {
                viewer.initViewer(stage!);
                viewer.showEmptyGrid();
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

    loadBtn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        loadBtn.classList.add('hidden');
        errorEl.classList.add('hidden');
        loadingEl.classList.remove('hidden');
        progressEl.textContent = 'Loading…';

        try {
            const [viewer, scans] = await Promise.all([ensureViewer(), fetchManifest()]);
            const scan = scans[Math.floor(Math.random() * scans.length)];

            const buffer = await fetchScan(scan.file, (fraction) => {
                progressEl.textContent = `Downloading… ${Math.round(fraction * 100)} %`;
            });

            await viewer.loadPointCloudFromBuffer(buffer, (msg) => {
                progressEl.textContent = msg;
            });

            countEl.textContent = `${viewer.getPointCount().toLocaleString('de-DE')} Points`;
            const modelLabel = formatReconstructionModel({model: scan.model, checkpoint: scan.checkpoint});
            modelEl.textContent = modelLabel ?? '';
            if (modelLabel && scan.checkpoint) modelEl.title = scan.checkpoint;

            sizeSlider.value = String(PREVIEW_POINT_SIZE);
            sizeSlider.disabled = false;
            viewer.setPointSize(PREVIEW_POINT_SIZE);
            viewer.dollyCamera(0.75); // the preview box is small — frame it tighter

            loadingEl.classList.add('hidden');
            stage.classList.add('loaded');
        } catch (err) {
            loadingEl.classList.add('hidden');
            loadBtn.classList.remove('hidden');
            errorEl.textContent = `Could not load the scan (${err instanceof Error ? err.message : err}).`;
            errorEl.classList.remove('hidden');
            busy = false;
        }
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
