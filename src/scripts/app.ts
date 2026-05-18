import type {PointCloudInfo, ResolvedPointCloud} from '../lib/snapspace-client';
import {
    checkMeshAvailability,
    clearPointCloudsCache,
    deleteCapture,
    fetchCapturesOverview,
    fetchColmapZip,
    fetchMeshGlb,
    fetchPointCloudData,
    getCachedMeshInfo,
    resolvePointCloud
} from '../lib/snapspace-client';
import {
    getPointCount,
    initViewer,
    loadPointCloudFromBuffer,
    setPointSize,
    unloadPointCloud
} from './viewer';

const sessionList = document.getElementById('session-list')!;
const viewerContainer = document.getElementById('viewer')!;
const statusEl = document.getElementById('status')!;
const refreshBtn = document.getElementById('refresh-btn')!;
const sidebarEl = document.getElementById('sidebar')!;
const toggleBtn = document.getElementById('sidebar-toggle')!;
const viewerEmpty = viewerContainer.querySelector('.viewer-empty')!;
const viewerLoading = document.getElementById('viewer-loading')!;
const viewerProgress = document.getElementById('viewer-progress')!;
const pointSizeControl = document.getElementById('point-size-control')!;
const pointSizeSlider = document.getElementById('point-size-slider') as HTMLInputElement;
const downloadBtn = document.getElementById('download-btn')!;
const downloadColmapBtn = document.getElementById('download-colmap-btn')!;
const downloadMeshBtn = document.getElementById('download-mesh-btn')!;
const itemDownloadsSection = document.getElementById('item-downloads-section')!;
const dlSlotPly = document.getElementById('dl-slot-ply')!;
const dlSlotColmap = document.getElementById('dl-slot-colmap')!;
const dlSlotMesh = document.getElementById('dl-slot-mesh')!;

const pointCloudCache = new Map<string, ArrayBuffer>();

let lastLoadedBuffer: ArrayBuffer | null = null;
let lastLoadedFilename: string | null = null;
let lastDownloadCaptureId: string | null = null;
let lastDownloadPc: PointCloudInfo | null = null;
let prefetchedDownloadBuffer: ArrayBuffer | null = null;
let colmapAvailable = false;
let colmapSizeBytes: number | null = null;
let meshAvailable = false;
let meshSizeBytes: number | null = null;

pointSizeSlider.addEventListener('input', () => {
    setPointSize(parseFloat(pointSizeSlider.value));
});

downloadBtn.addEventListener('click', async () => {
    if (!lastDownloadCaptureId || !lastDownloadPc) return;
    const btn = downloadBtn as HTMLButtonElement;
    btn.disabled = true;
    const origText = btn.textContent;
    try {
        let buffer: ArrayBuffer;
        if (prefetchedDownloadBuffer) {
            buffer = prefetchedDownloadBuffer;
        } else {
            btn.textContent = 'Downloading…';
            buffer = await fetchPointCloudData(
                lastDownloadCaptureId,
                lastDownloadPc.filename,
                (f) => { btn.textContent = `Downloading… ${Math.round(f * 100)}%`; },
                lastDownloadPc.size_bytes,
            );
        }
        const blob = new Blob([buffer], {type: 'application/octet-stream'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `Capture_${lastDownloadCaptureId}_pointcloud.ply`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (err) {
        setStatus(`Download error: ${err instanceof Error ? err.message : err}`);
    } finally {
        btn.disabled = false;
        btn.textContent = origText;
    }
});

downloadColmapBtn.addEventListener('click', async () => {
    if (!lastDownloadCaptureId || !colmapAvailable) return;
    const btn = downloadColmapBtn as HTMLButtonElement;
    btn.disabled = true;
    const origText = btn.textContent;
    try {
        btn.textContent = 'Downloading… 0%';
        const buffer = await fetchColmapZip(lastDownloadCaptureId, (f) => {
            btn.textContent = `Downloading… ${Math.round(f * 100)}%`;
        }, colmapSizeBytes);
        const blob = new Blob([buffer], {type: 'application/zip'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `Capture_${lastDownloadCaptureId}_colmap.zip`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (err) {
        setStatus(`COLMAP download error: ${err instanceof Error ? err.message : err}`);
    } finally {
        btn.disabled = false;
        btn.textContent = origText;
    }
});

downloadMeshBtn.addEventListener('click', async () => {
    if (!lastDownloadCaptureId || !meshAvailable) return;
    const btn = downloadMeshBtn as HTMLButtonElement;
    btn.disabled = true;
    const origText = btn.textContent;
    try {
        btn.textContent = 'Downloading… 0%';
        const buffer = await fetchMeshGlb(lastDownloadCaptureId, (f) => {
            btn.textContent = `Downloading… ${Math.round(f * 100)}%`;
        }, meshSizeBytes);
        const blob = new Blob([buffer], {type: 'model/gltf-binary'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `Capture_${lastDownloadCaptureId}_mesh.glb`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (err) {
        setStatus(`Mesh download error: ${err instanceof Error ? err.message : err}`);
    } finally {
        btn.disabled = false;
        btn.textContent = origText;
    }
});

const SPINNER = '<div class="spinner"></div>';

let viewerInitialised = false;
let selectedPcKey: string | null = null;
let isLoggedIn = false;
let activeListItemEl: HTMLButtonElement | null = null;

toggleBtn.addEventListener('click', () => {
    const collapsed = sidebarEl.classList.toggle('collapsed');
    toggleBtn.textContent = collapsed ? '›' : '‹';
});

refreshBtn.addEventListener('click', () => {
    clearPointCloudsCache();
    loadSessions();
});


async function checkSession(): Promise<void> {
    try {
        const res = await fetch('/api/auth/session');
        if (res.ok) {
            const data = await res.json();
            isLoggedIn = !!data.loggedIn;
        }
    } catch {
        isLoggedIn = false;
    }
}

await checkSession();

if (window.innerWidth <= 768) {
    sidebarEl.classList.add('collapsed');
    toggleBtn.textContent = '›';
}
initViewer(viewerContainer as HTMLElement);
viewerInitialised = true;
loadSessions();

async function loadSessions(): Promise<void> {
    itemDownloadsSection.classList.remove('open');
    if (itemDownloadsSection.parentNode) {
        itemDownloadsSection.parentNode.removeChild(itemDownloadsSection);
    }
    dlSlotPly.classList.remove('open');
    dlSlotColmap.classList.remove('open');
    dlSlotMesh.classList.remove('open');
    sessionList.innerHTML = SPINNER;
    setStatus('');
    try {
        const overview = await fetchCapturesOverview();
        if (overview.length === 0) {
            sessionList.innerHTML = '<div class="empty-state">No captures available.</div>';
            return;
        }
        sessionList.innerHTML = '';
        overview.sort((a, b) => b.id.localeCompare(a.id));
        let rendered = 0;
        overview.forEach((entry, i) => {
            const el = renderSkeletonItem(entry.id);
            el.style.animationDelay = `${Math.min(i * 25, 400)}ms`;
            sessionList.appendChild(el);
            if (!entry.pointclouds_info) { el.remove(); return; }
            const resolved = resolvePointCloud(entry.pointclouds_info);
            if (!resolved) { el.remove(); return; }
            upgradeSkeletonItem(el, entry.id, resolved);
            rendered++;
            const pcKey = `${entry.id}/${resolved.view.filename}`;
            if (selectedPcKey === pcKey) {
                el.classList.add('active');
                updateDownloadButtons(entry.id, resolved);
            }
        });
        if (rendered === 0) {
            sessionList.innerHTML = '<div class="empty-state">No point clouds available.</div>';
        }
    } catch {
        sessionList.innerHTML = '<div class="empty-state">No captures available.</div>';
    }
}

function parseCaptureDate(captureId: string): string {
    const m = captureId.match(/(\d{4})[\-_]?(\d{2})[\-_]?(\d{2})[\-_T]?(\d{2})[\-:_]?(\d{2})[\-:_]?(\d{2})/);
    if (m) {
        const [, y, mo, d, h, mi] = m;
        return `Capture from ${d}.${mo}.${y} at ${h}:${mi}`;
    }
    return captureId;
}

const SVG_CLOUD = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m8 17 4 4 4-4"/></svg>`;
const SVG_CACHED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const SVG_TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

function updateItemCacheIcon(el: HTMLButtonElement, isCached: boolean): void {
    const icon = el.querySelector<HTMLElement>('.item-status-icon');
    if (!icon) return;
    icon.innerHTML = isCached ? SVG_CACHED : SVG_CLOUD;
    icon.className = `item-status-icon${isCached ? ' cached' : ''}`;
    icon.title = isCached ? 'Cached locally' : 'Not cached';
}

function renderSkeletonItem(captureId: string): HTMLButtonElement {
    const el = document.createElement('button');
    el.className = 'list-item enter is-skeleton';
    el.disabled = true;
    el.innerHTML = `
    <div class="item-content">
      <div class="item-title">${parseCaptureDate(captureId)}</div>
      <div class="item-meta"><span class="skeleton-bar"></span></div>
    </div>
    <span class="item-status-icon" title="Not cached">${SVG_CLOUD}</span>
  `;
    return el;
}

function upgradeSkeletonItem(el: HTMLButtonElement, captureId: string, resolved: ResolvedPointCloud): void {
    el.classList.remove('is-skeleton');
    el.disabled = false;
    const sizeMB = (resolved.view.size_bytes / (1024 * 1024)).toFixed(1);
    const isCached = pointCloudCache.has(`${captureId}/${resolved.view.filename}`);
    const deleteBtn = isLoggedIn
        ? `<button class="item-delete-inline" title="Delete Capture" data-capture-id="${captureId}">${SVG_TRASH}</button>`
        : '';
    el.innerHTML = `
    <div class="item-content">
      <div class="item-title">${parseCaptureDate(captureId)}</div>
      <div class="item-meta">${sizeMB} MB</div>
    </div>
    ${deleteBtn}
    <span class="item-status-icon${isCached ? ' cached' : ''}" title="${isCached ? 'Cached locally' : 'Not cached'}">${isCached ? SVG_CACHED : SVG_CLOUD}</span>
  `;
    attachItemHandlers(el, captureId, resolved);
}

function attachItemHandlers(el: HTMLButtonElement, captureId: string, resolved: ResolvedPointCloud): void {
    el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.item-delete-inline')) return;
        selectPointCloud(captureId, resolved, el);
    });

    const delBtn = el.querySelector<HTMLButtonElement>('.item-delete-inline');
    if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await performDeleteCapture(captureId, resolved.view.filename, el);
        });
    }
}

async function performDeleteCapture(captureId: string, viewFilename: string, listItemEl: HTMLButtonElement): Promise<void> {
    if (!confirm(`Delete Capture "${captureId}"?`)) return;
    try {
        await deleteCapture(captureId);
        const pcKey = `${captureId}/${viewFilename}`;
        if (selectedPcKey === pcKey) {
            selectedPcKey = null;
            activeListItemEl = null;
            unloadPointCloud();
            viewerEmpty.classList.remove('hidden');
            pointSizeControl.classList.add('hidden');
            setStatus('');
        }
        itemDownloadsSection.classList.remove('open');
        if (itemDownloadsSection.parentNode) {
            itemDownloadsSection.parentNode.removeChild(itemDownloadsSection);
        }
        dlSlotPly.classList.remove('open');
        dlSlotColmap.classList.remove('open');
        dlSlotMesh.classList.remove('open');
        document.getElementById('dl-slot-delete')?.classList.remove('open');
        listItemEl.remove();
        if (activeListItemEl === listItemEl) activeListItemEl = null;
        if (sessionList.children.length === 0) {
            sessionList.innerHTML = '<div class="empty-state">No point clouds available.</div>';
        }
    } catch (err) {
        setStatus(`Delete error: ${err instanceof Error ? err.message : err}`);
    }
}

async function selectPointCloud(captureId: string, resolved: ResolvedPointCloud, el: HTMLButtonElement): Promise<void> {
    const pc = resolved.view;
    const pcKey = `${captureId}/${pc.filename}`;
    if (selectedPcKey === pcKey) return;

    sessionList.querySelectorAll('.list-item').forEach((item) => {
        item.classList.remove('active');
        item.classList.remove('has-downloads');
    });
    el.classList.add('active');
    selectedPcKey = pcKey;
    activeListItemEl = el;

    if (window.innerWidth <= 768) {
        sidebarEl.classList.add('collapsed');
        toggleBtn.textContent = '›';
    }

    itemDownloadsSection.classList.remove('open');
    if (itemDownloadsSection.parentNode) {
        itemDownloadsSection.parentNode.removeChild(itemDownloadsSection);
    }
    dlSlotPly.classList.remove('open');
    dlSlotColmap.classList.remove('open');
    dlSlotMesh.classList.remove('open');

    viewerEmpty.classList.add('hidden');
    viewerProgress.textContent = '0 %';
    viewerLoading.classList.remove('hidden');
    try {
        let buffer: ArrayBuffer;
        const cacheKey = `${captureId}/${pc.filename}`;
        if (pointCloudCache.has(cacheKey)) {
            setStatus('Loading from cache…');
            viewerProgress.textContent = 'Cached';
            buffer = pointCloudCache.get(cacheKey)!;
        } else {
            setStatus('Downloading point cloud…');
            buffer = await fetchPointCloudData(captureId, pc.filename, (f) => {
                viewerProgress.textContent = `Downloading… ${Math.round(f * 100)} %`;
            }, pc.size_bytes);
            pointCloudCache.set(cacheKey, buffer);
        }
        if (selectedPcKey !== pcKey) return;

        viewerProgress.textContent = 'Parsing…';
        await new Promise(r => setTimeout(r, 50));
        await loadPointCloudFromBuffer(buffer, (msg) => {
            viewerProgress.textContent = msg;
            setStatus(msg);
        });
        lastLoadedBuffer = buffer;
        lastLoadedFilename = pc.filename;
        lastDownloadCaptureId = captureId;
        lastDownloadPc = resolved.download;
        prefetchedDownloadBuffer = buffer;
        pointSizeControl.classList.remove('hidden');

        await updateDownloadButtons(captureId, resolved);

        const count = getPointCount();
        const countStr = count >= 1_000_000
            ? `${(count / 1_000_000).toFixed(1)}M points`
            : count >= 1_000
                ? `${(count / 1_000).toFixed(0)}K points`
                : `${count} points`;
        const metaEl = el.querySelector('.item-meta');
        if (metaEl) {
            const sizeMB = (pc.size_bytes / (1024 * 1024)).toFixed(1);
            metaEl.textContent = `${sizeMB} MB · ${countStr}`;
        }

        pointSizeSlider.min = '0.001';
        pointSizeSlider.max = '0.05';
        pointSizeSlider.step = '0.001';
        pointSizeSlider.value = '0.005';
        setPointSize(0.005);

        setStatus(`Loaded Point Cloud for Capture_${captureId}`);
        updateItemCacheIcon(el, true);
    } catch (err: unknown) {
        selectedPcKey = null;
        el.classList.remove('active');
        setStatus(`Error: ${err instanceof Error ? err.message : err}`);
    } finally {
        viewerLoading.classList.add('hidden');
    }
}

function setStatus(msg: string): void {
    statusEl.textContent = msg;
}

async function updateDownloadButtons(captureId: string, resolved: ResolvedPointCloud): Promise<void> {
    lastDownloadCaptureId = captureId;
    lastDownloadPc = resolved.download;

    const activeItem = sessionList.querySelector<HTMLButtonElement>('.list-item.active');
    if (activeItem) {
        if (!activeItem.classList.contains('has-downloads')) {
            activeItem.classList.add('has-downloads');
            activeItem.insertAdjacentElement('afterend', itemDownloadsSection);
            requestAnimationFrame(() => requestAnimationFrame(() => {
                itemDownloadsSection.classList.add('open');
            }));
        } else {
            itemDownloadsSection.classList.add('open');
        }
    }

    const dlSizeMB = (resolved.download.size_bytes / (1024 * 1024)).toFixed(0);
    (downloadBtn as HTMLButtonElement).textContent = `⤓ .ply (${dlSizeMB} MB)`;
    dlSlotPly.classList.add('open');

    colmapAvailable = resolved.colmap_available;
    colmapSizeBytes = resolved.colmap_size_bytes;
    if (colmapAvailable) {
        const colmapMB = colmapSizeBytes ? (colmapSizeBytes / (1024 * 1024)).toFixed(0) : '?';
        (downloadColmapBtn as HTMLButtonElement).textContent = `⤓ COLMAP (${colmapMB} MB)`;
        dlSlotColmap.classList.add('open');
    } else {
        dlSlotColmap.classList.remove('open');
    }

    const applyMesh = (info: { available: boolean; size_bytes: number | null }): void => {
        if (selectedPcKey !== `${captureId}/${resolved.view.filename}`) return;
        meshAvailable = info.available;
        meshSizeBytes = info.size_bytes;
        if (meshAvailable) {
            const meshMB = meshSizeBytes ? (meshSizeBytes / (1024 * 1024)).toFixed(0) : '?';
            (downloadMeshBtn as HTMLButtonElement).textContent = `⤓ .glb (${meshMB} MB)`;
            dlSlotMesh.classList.add('open');
        } else {
            dlSlotMesh.classList.remove('open');
        }
    };

    const cached = getCachedMeshInfo(captureId);
    if (cached) {
        applyMesh(cached);
    } else {
        dlSlotMesh.classList.remove('open');
        const info = await checkMeshAvailability(captureId);
        applyMesh(info);
    }
}
