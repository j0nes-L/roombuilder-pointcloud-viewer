import type {PointCloudInfo, PointCloudsResponse, ResolvedPointCloud} from '../lib/snapspace-client';
import {
    checkMeshAvailability,
    clearPointCloudsCache,
    deleteCapture,
    fetchCapturesOverview,
    fetchCapturesOverviewSWR,
    fetchColmapZip,
    fetchMeshGlb,
    fetchPointCloudData,
    getCachedMeshInfo,
    resolvePointCloud
} from '../lib/snapspace-client';
import {getSupabaseBrowserClient} from '../lib/supabase-browser';
import {showToast} from './toast';
import {
    getPointCount,
    initViewer,
    loadColmapCameras,
    loadPointCloudFromBuffer,
    setPointSize,
    unloadColmapCameras,
    unloadPointCloud,
} from './viewer';
import type {ColmapCameraData} from './viewer';

const sessionList = document.getElementById('session-list')!;
const viewerContainer = document.getElementById('viewer')!;
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
const dlSlotShare = document.getElementById('dl-slot-share')!;
const shareBtn = document.getElementById('share-btn')!;
const dlProgressPly = document.getElementById('dl-progress-ply')!;
const dlProgressColmap = document.getElementById('dl-progress-colmap')!;
const dlProgressMesh = document.getElementById('dl-progress-mesh')!;

const pointCloudCache = new Map<string, ArrayBuffer>();
const colmapImageCache = new Map<string, string>();
const colmapPosesCache = new Map<string, ColmapCameraData[]>();

function clearColmapImageCache(): void {
    colmapImageCache.forEach(url => URL.revokeObjectURL(url));
    colmapImageCache.clear();
}

async function getColmapImageUrl(captureId: string, name: string): Promise<string> {
    const key = `${captureId}/${name}`;
    if (colmapImageCache.has(key)) return colmapImageCache.get(key)!;
    const apiUrl = `/api/get-colmap-image?capture_id=${encodeURIComponent(captureId)}&name=${encodeURIComponent(name)}`;
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    colmapImageCache.set(key, blobUrl);
    return blobUrl;
}

let lastLoadedBuffer: ArrayBuffer | null = null;
let lastLoadedFilename: string | null = null;
let lastDownloadCaptureId: string | null = null;
let lastDownloadCreatedAt: string | null = null;
let lastDownloadPc: PointCloudInfo | null = null;
let prefetchedDownloadBuffer: ArrayBuffer | null = null;
let colmapAvailable = false;
let colmapSizeBytes: number | null = null;
let meshAvailable = false;
let meshSizeBytes: number | null = null;

pointSizeSlider.addEventListener('input', () => {
    setPointSize(parseFloat(pointSizeSlider.value));
});

const yieldToMain = () => new Promise<void>(r => setTimeout(r, 0));

async function triggerDownload(buffer: ArrayBuffer, mime: string, filename: string): Promise<void> {
    await yieldToMain();
    const blob = new Blob([buffer], {type: mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

downloadBtn.addEventListener('click', async () => {
    if (!lastDownloadCaptureId || !lastDownloadPc) return;
    const btn = downloadBtn as HTMLButtonElement;
    const origText = btn.textContent;
    setDownloadBusy(true);
    try {
        let buffer: ArrayBuffer;
        if (prefetchedDownloadBuffer) {
            buffer = prefetchedDownloadBuffer;
        } else {
            setProgress(dlProgressPly, 0);
            buffer = await fetchPointCloudData(
                lastDownloadCaptureId,
                lastDownloadPc.filename,
                (f) => { setProgress(dlProgressPly, f); },
                lastDownloadPc.size_bytes,
            );
        }
        await triggerDownload(buffer, 'application/octet-stream', `capture_${captureTimestamp(lastDownloadCreatedAt ?? '')}.ply`);
    } catch (err) {
        showToast(`Download failed: ${err instanceof Error ? err.message : err}`, 'error');
    } finally {
        setDownloadBusy(false);
        btn.textContent = origText;
    }
});

downloadColmapBtn.addEventListener('click', async () => {
    if (!lastDownloadCaptureId || !colmapAvailable) return;
    const btn = downloadColmapBtn as HTMLButtonElement;
    const origText = btn.textContent;
    setDownloadBusy(true);
    try {
        setProgress(dlProgressColmap, 0);
        const buffer = await fetchColmapZip(lastDownloadCaptureId, (f) => {
            setProgress(dlProgressColmap, f);
        }, colmapSizeBytes);
        await triggerDownload(buffer, 'application/zip', `capture_${captureTimestamp(lastDownloadCreatedAt ?? '')}_colmap.zip`);
    } catch (err) {
        showToast(`COLMAP download failed: ${err instanceof Error ? err.message : err}`, 'error');
    } finally {
        setDownloadBusy(false);
        btn.textContent = origText;
    }
});

downloadMeshBtn.addEventListener('click', async () => {
    if (!lastDownloadCaptureId || !meshAvailable) return;
    const btn = downloadMeshBtn as HTMLButtonElement;
    const origText = btn.textContent;
    setDownloadBusy(true);
    try {
        setProgress(dlProgressMesh, 0);
        const buffer = await fetchMeshGlb(lastDownloadCaptureId, (f) => {
            setProgress(dlProgressMesh, f);
        }, meshSizeBytes);
        await triggerDownload(buffer, 'model/gltf-binary', `capture_${captureTimestamp(lastDownloadCreatedAt ?? '')}.glb`);
    } catch (err) {
        showToast(`Mesh download failed: ${err instanceof Error ? err.message : err}`, 'error');
    } finally {
        setDownloadBusy(false);
        btn.textContent = origText;
    }
});

const SPINNER = '<div class="spinner"></div>';

shareBtn.addEventListener('click', async () => {
    if (!lastDownloadCaptureId) return;
    if (!isLoggedIn) {
        showToast('Please log in to share captures.', 'error');
        return;
    }
    const btn = shareBtn as HTMLButtonElement;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Creating link…';
    try {
        const supabase = getSupabaseBrowserClient();
        const {data: {session}} = await supabase.auth.getSession();
        if (!session) {
            showToast('Session expired. Please log in again.', 'error');
            return;
        }
        const {data, error} = await supabase
            .from('capture_share_tokens')
            .insert({capture_id: lastDownloadCaptureId, created_by: session.user.id})
            .select('token')
            .single();
        if (error || !data?.token) {
            throw new Error(error?.message ?? 'Could not create share token.');
        }
        const shareUrl = `${window.location.origin}/?token=${data.token}`;
        try {
            await navigator.clipboard.writeText(shareUrl);
            showToast('Share link copied to clipboard.', 'success');
        } catch {
            showToast(shareUrl, 'info', 10000);
        }
    } catch (err) {
        showToast(`Share failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
    }
});


let viewerInitialised = false;
let selectedPcKey: string | null = null;
let loadToken = 0;
const __ssLoggedIn = (window as unknown as {__SS_LOGGED_IN__?: boolean}).__SS_LOGGED_IN__;
const ssrValueAvailable = typeof __ssLoggedIn === 'boolean';
let isLoggedIn = ssrValueAvailable ? __ssLoggedIn! : false;
let activeListItemEl: HTMLButtonElement | null = null;

toggleBtn.addEventListener('click', () => {
    const collapsed = sidebarEl.classList.toggle('collapsed');
    toggleBtn.textContent = collapsed ? '›' : '‹';
});

refreshBtn.addEventListener('click', () => {
    clearPointCloudsCache();
    loadSessions(true);
});


async function checkSession(): Promise<void> {
    try {
        const res = await fetch('/api/auth/session');
        if (res.ok) {
            const data = await res.json();
            isLoggedIn = !!data.loggedIn;
        }
    } catch {
    }
}

if (ssrValueAvailable) {
    checkSession().then(() => {});
} else {
    await checkSession();
}

async function processShareToken(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return;

    params.delete('token');
    history.replaceState(
        {},
        '',
        window.location.pathname + (params.toString() ? '?' + params.toString() : ''),
    );

    if (!/^[0-9a-fA-F-]{36}$/.test(token)) {
        showToast('Invalid share link.', 'error');
        return;
    }

    if (!isLoggedIn) {
        const next = encodeURIComponent(`${window.location.pathname}?token=${token}`);
        showToast('Please log in to claim this shared capture.', 'info', 6000);
        setTimeout(() => {
            window.location.href = `/account?next=${next}`;
        }, 2500);
        return;
    }

    try {
        const supabase = getSupabaseBrowserClient();
        const {data: claimedId, error} = await supabase.rpc('claim_capture_share', {p_token: token});
        if (error) {
            const message = /expired/i.test(error.message)
                ? 'This share link has expired.'
                : /not found/i.test(error.message)
                    ? 'This share link is invalid.'
                    : 'Could not claim share link.';
            showToast(message, 'error');
            return;
        }
        if (claimedId === null) {
            showToast('You already have access to this capture.', 'info');
            return;
        }
        showToast('Capture added to your library.', 'success');
        clearPointCloudsCache();
        loadSessions();
    } catch (err) {
        showToast(`Claim failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
}

await processShareToken();

if (window.innerWidth <= 768) {
    sidebarEl.classList.add('collapsed');
    toggleBtn.textContent = '›';
}
initViewer(viewerContainer as HTMLElement);
viewerInitialised = true;
if (!isLoggedIn) {
    viewerEmpty.textContent = 'Please log in to use the viewer';
}
loadSessions();

function renderOverview(overview: CaptureOverviewEntry[]): void {
    if (overview.length === 0) {
        sessionList.innerHTML = '<div class="empty-state">No captures available.</div>';
        return;
    }
    sessionList.innerHTML = '';
    overview.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    let rendered = 0;
    overview.forEach((entry, i) => {
        const el = renderSkeletonItem(entry.id, entry.created_at);
        el.style.animationDelay = `${Math.min(i * 25, 400)}ms`;
        sessionList.appendChild(el);
        if (!entry.pointclouds_info) {
            upgradeSkeletonItemPending(el, entry.id, entry.role ?? 'collaborator', entry.created_at, `No data (${(entry as any).upstream_status ?? 'err'})`);
            rendered++;
            return;
        }
        if (entry.pointclouds_info.isColmap) {
            upgradeSkeletonItemColmap(el, entry.id, entry.pointclouds_info, entry.role ?? 'collaborator', entry.created_at, entry.owner_display_name ?? null);
            rendered++;
            const pcKey = `${entry.id}/__colmap__`;
            if (selectedPcKey === pcKey) {
                el.classList.add('active');
                updateDownloadButtonsColmap(entry.id, entry.pointclouds_info, entry.created_at);
            }
            return;
        }
        const resolved = resolvePointCloud(entry.pointclouds_info);
        if (!resolved) {
            upgradeSkeletonItemPending(el, entry.id, entry.role ?? 'collaborator', entry.created_at, 'Processing…');
            rendered++;
            return;
        }
        upgradeSkeletonItem(el, entry.id, resolved, entry.role ?? 'collaborator', entry.created_at, entry.owner_display_name ?? null);
        rendered++;
        const pcKey = `${entry.id}/${resolved.view.filename}`;
        if (selectedPcKey === pcKey) {
            el.classList.add('active');
            updateDownloadButtons(entry.id, resolved, entry.created_at);
        }
    });
    if (rendered === 0) {
        sessionList.innerHTML = '<div class="empty-state">No point clouds available.</div>';
    }
}

async function loadSessions(forceRefresh = false): Promise<void> {
    itemDownloadsSection.classList.remove('open');
    if (itemDownloadsSection.parentNode) {
        itemDownloadsSection.parentNode.removeChild(itemDownloadsSection);
    }
    dlSlotPly.classList.remove('open');
    dlSlotColmap.classList.remove('open');
    dlSlotMesh.classList.remove('open');
    dlSlotShare.classList.remove('open');
    if (!isLoggedIn) {
        sessionList.innerHTML = '<div class="empty-state"><a href="/account" class="footer-link">Login to view captures</a></div>';
        return;
    }
    sessionList.innerHTML = SPINNER;
    setStatus('');
    try {
        if (forceRefresh) {
            const overview = await fetchCapturesOverview(true);
            renderOverview(overview);
        } else {
            await fetchCapturesOverviewSWR((overview, fromCache) => {
                renderOverview(overview);
            });
        }
    } catch {
        sessionList.innerHTML = '<div class="empty-state">No captures available.</div>';
    }
}

function captureTimestamp(isoDate: string): string {
    try {
        const d = new Date(isoDate);
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        return `${y}${mo}${day}_${h}${mi}${s}`;
    } catch {
        return isoDate;
    }
}

function formatCaptureDate(isoDate: string): string {
    try {
        const d = new Date(isoDate);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        return `Capture from ${day}.${month}.${year} at ${hours}:${minutes}`;
    } catch {
        return isoDate;
    }
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

function renderSkeletonItem(captureId: string, createdAt: string): HTMLButtonElement {
    const el = document.createElement('button');
    el.className = 'list-item enter is-skeleton';
    el.disabled = true;
    el.innerHTML = `
    <div class="item-content">
      <div class="item-title">${formatCaptureDate(createdAt)}</div>
      <div class="item-meta"><span class="skeleton-bar"></span></div>
    </div>
    <span class="item-status-icon" title="Not cached">${SVG_CLOUD}</span>
  `;
    return el;
}

function upgradeSkeletonItemPending(el: HTMLButtonElement, captureId: string, role: string, createdAt: string, status: string): void {
    el.classList.remove('is-skeleton');
    el.disabled = true;
    const deleteTitle = role === 'owner' ? 'Delete Capture' : 'Remove from library';
    const deleteBtn = isLoggedIn
        ? `<button class="item-delete-inline" title="${deleteTitle}" data-capture-id="${captureId}" data-role="${role}">${SVG_TRASH}</button>`
        : '';
    el.innerHTML = `
    <div class="item-content">
      <div class="item-title">${formatCaptureDate(createdAt)}</div>
      <div class="item-meta">${status}</div>
    </div>
    ${deleteBtn}
  `;
    const delBtn = el.querySelector<HTMLButtonElement>('.item-delete-inline');
    if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await performDeleteCapture(captureId, '__pending__', el, role);
        });
    }
}

function upgradeSkeletonItemColmap(el: HTMLButtonElement, captureId: string, info: PointCloudsResponse, role: string, createdAt: string, ownerDisplayName: string | null = null): void {
    el.classList.remove('is-skeleton');
    if (ownerDisplayName) el.dataset.ownerDisplayName = ownerDisplayName;
    const colmapReady = !!info.colmap_url;
    const sharedPart = role !== 'owner' && ownerDisplayName ? ` · Created by <strong>${ownerDisplayName}</strong>` : '';
    const metaText = colmapReady
        ? `COLMAP${sharedPart}`
        : 'Creating COLMAP .zip…';
    const deleteTitle = role === 'owner' ? 'Delete Capture' : 'Remove from library';
    const deleteBtn = isLoggedIn
        ? `<button class="item-delete-inline" title="${deleteTitle}" data-capture-id="${captureId}" data-role="${role}">${SVG_TRASH}</button>`
        : '';
    el.disabled = !colmapReady;
    el.innerHTML = `
    <div class="item-content">
      <div class="item-title">${formatCaptureDate(createdAt)}</div>
      <div class="item-meta">${metaText}</div>
    </div>
    ${deleteBtn}
  `;
    attachColmapItemHandlers(el, captureId, info, role, createdAt);
}

function attachColmapItemHandlers(el: HTMLButtonElement, captureId: string, info: PointCloudsResponse, role: string, createdAt: string): void {
    el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.item-delete-inline')) return;
        if (!info.colmap_url) return;
        selectColmapCapture(captureId, info, el, createdAt);
    });
    const delBtn = el.querySelector<HTMLButtonElement>('.item-delete-inline');
    if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await performDeleteCapture(captureId, '__colmap__', el, role);
        });
    }
}

async function selectColmapCapture(captureId: string, info: PointCloudsResponse, el: HTMLButtonElement, createdAt: string): Promise<void> {
    const pcKey = `${captureId}/__colmap__`;
    if (selectedPcKey === pcKey) return;

    clearColmapImageCache();
    pointSizeControl.classList.add('hidden');

    sessionList.querySelectorAll('.list-item').forEach(item => {
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
    if (itemDownloadsSection.parentNode) itemDownloadsSection.parentNode.removeChild(itemDownloadsSection);
    dlSlotPly.classList.remove('open');
    dlSlotColmap.classList.remove('open');
    dlSlotMesh.classList.remove('open');
    dlSlotShare.classList.remove('open');

    prefetchedDownloadBuffer = null;
    lastLoadedBuffer = null;
    lastDownloadPc = null;

    await updateDownloadButtonsColmap(captureId, info, createdAt);

    viewerEmpty.classList.add('hidden');
    viewerProgress.textContent = 'Loading cameras…';
    viewerLoading.classList.remove('hidden');

    try {
        let cameras: ColmapCameraData[];
        if (colmapPosesCache.has(captureId)) {
            cameras = colmapPosesCache.get(captureId)!;
        } else {
            const res = await fetch(`/api/get-colmap-poses?capture_id=${encodeURIComponent(captureId)}`);
            if (!res.ok) throw new Error(`Failed to fetch COLMAP poses: ${res.status}`);
            const data = await res.json() as { cameras: ColmapCameraData[] };
            cameras = data.cameras;
            colmapPosesCache.set(captureId, cameras);
        }
        if (selectedPcKey !== pcKey) return;
        const data = { cameras };

        const tooltip = document.getElementById('colmap-tooltip')!;
        let tooltipCaptureId = captureId;

        const PREFETCH_COUNT = 20;
        const PREFETCH_CONCURRENCY = 4;
        const prefetchCameras = data.cameras.slice(0, PREFETCH_COUNT);
        (async () => {
            let idx = 0;
            const workers = Array.from({ length: PREFETCH_CONCURRENCY }, async () => {
                while (true) {
                    const i = idx++;
                    if (i >= prefetchCameras.length || selectedPcKey !== pcKey) return;
                    const cam = prefetchCameras[i];
                    const key = `${captureId}/${cam.name}`;
                    if (!colmapImageCache.has(key)) {
                        try { await getColmapImageUrl(captureId, cam.name); } catch { /* ignore */ }
                    }
                }
            });
            await Promise.all(workers);
        })();

        await loadColmapCameras(data.cameras, (cam, x, y, pos, quat) => {

            if (!cam) {
                tooltip.classList.remove('visible');
                return;
            }
            const idx = data.cameras.indexOf(cam);

            let poseHtml = '';
            if (pos && quat) {
                const f = (v: number) => v.toFixed(3);
                const { x: qx, y: qy, z: qz, w: qw } = quat;
                const m13 = 2 * (qx * qz + qw * qy);
                const m23 = 2 * (qy * qz - qw * qx);
                const m33 = 1 - 2 * (qx * qx + qy * qy);
                const m12 = 2 * (qx * qy - qw * qz);
                const m11 = 1 - 2 * (qy * qy + qz * qz);
                const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
                const rx = Math.abs(m13) < 0.9999999 ? Math.atan2(-m23, m33) : Math.atan2(2*(qx*qw+qy*qz), 1-2*(qy*qy+qz*qz));
                const rz = Math.abs(m13) < 0.9999999 ? Math.atan2(-m12, m11) : 0;
                const toDeg = (r: number) => (r * 180 / Math.PI).toFixed(1);
                poseHtml = `
                <div class="tooltip-pose">
                    <span class="pose-label">pos</span>
                    <span class="pose-val"><span class="pose-x">x&nbsp;${f(pos.x)}</span> <span class="pose-y">y&nbsp;${f(pos.y)}</span> <span class="pose-z">z&nbsp;${f(pos.z)}</span></span>
                    <span class="pose-label">rot</span>
                    <span class="pose-val"><span class="pose-x">x&nbsp;${toDeg(rx)}°</span> <span class="pose-y">y&nbsp;${toDeg(ry)}°</span> <span class="pose-z">z&nbsp;${toDeg(rz)}°</span></span>
                </div>`;
            }

            tooltip.innerHTML = `
                <div class="tooltip-preview">
                    <div class="tooltip-spinner"></div>
                    <img class="tooltip-img hidden" alt="${cam.name}" />
                </div>
                <div class="tooltip-meta">${cam.name} &nbsp;·&nbsp; ${idx + 1} / ${data.cameras.length}</div>
                ${poseHtml}
            `;

            const img = tooltip.querySelector<HTMLImageElement>('.tooltip-img')!;
            const spinner = tooltip.querySelector<HTMLElement>('.tooltip-spinner')!;

            // Use cached blob URL if available, otherwise fetch and cache
            const cacheKey = `${tooltipCaptureId}/${cam.name}`;
            if (colmapImageCache.has(cacheKey)) {
                img.src = colmapImageCache.get(cacheKey)!;
                spinner.style.display = 'none';
                img.classList.remove('hidden');
            } else {
                img.onload = () => { spinner.style.display = 'none'; img.classList.remove('hidden'); };
                img.onerror = () => { spinner.style.display = 'none'; };
                getColmapImageUrl(tooltipCaptureId, cam.name)
                    .then(url => { if (img.isConnected) img.src = url; })
                    .catch(() => { if (img.isConnected) spinner.style.display = 'none'; });
            }

            tooltip.style.left = `${x + 16}px`;
            tooltip.style.top  = `${y - 12}px`;
            tooltip.classList.add('visible');
        }, (percent) => {
            viewerProgress.textContent = 'Loading cameras…';
        });
        const pictureCount = data.cameras.length;
        const colmapCountEl = document.getElementById('point-count-display');
        if (colmapCountEl) colmapCountEl.textContent = `${pictureCount.toLocaleString('de-DE')} Images`;
        pointSizeControl.classList.add('count-only');
        pointSizeControl.classList.remove('hidden');
        showToast('COLMAP cameras loaded.', 'success');
    } catch (err) {
        selectedPcKey = null;
        el.classList.remove('active');
        showToast(`Failed to load COLMAP cameras: ${err instanceof Error ? err.message : err}`, 'error');
    } finally {
        viewerLoading.classList.add('hidden');
    }
}

async function updateDownloadButtonsColmap(captureId: string, info: PointCloudsResponse, createdAt: string): Promise<void> {
    lastDownloadCaptureId = captureId;
    lastDownloadCreatedAt = createdAt;
    colmapAvailable = !!info.colmap_url;
    colmapSizeBytes = info.colmap_size_bytes ?? null;
    meshAvailable = false;
    meshSizeBytes = null;

    if (!colmapAvailable) return;

    const activeItem = sessionList.querySelector<HTMLButtonElement>('.list-item.active');
    if (activeItem && !activeItem.classList.contains('has-downloads')) {
        activeItem.classList.add('has-downloads');
        activeItem.insertAdjacentElement('afterend', itemDownloadsSection);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            itemDownloadsSection.classList.add('open');
        }));
    } else {
        itemDownloadsSection.classList.add('open');
    }

    dlSlotPly.classList.remove('open');
    dlSlotMesh.classList.remove('open');

    const colmapMB = colmapSizeBytes ? (colmapSizeBytes / (1024 * 1024)).toFixed(0) : '?';
    (downloadColmapBtn as HTMLButtonElement).textContent = `⤓ COLMAP (${colmapMB} MB)`;
    dlSlotColmap.classList.add('open');

    if (isLoggedIn) dlSlotShare.classList.add('open');
    else dlSlotShare.classList.remove('open');
}

function upgradeSkeletonItem(el: HTMLButtonElement, captureId: string, resolved: ResolvedPointCloud, role: string, createdAt: string, ownerDisplayName: string | null = null): void {
    el.classList.remove('is-skeleton');
    el.disabled = false;
    if (ownerDisplayName) el.dataset.ownerDisplayName = ownerDisplayName;
    const sharedPart = role !== 'owner' && ownerDisplayName ? ` · Created by <strong>${ownerDisplayName}</strong>` : '';
    const metaText = `Pointcloud${sharedPart}`;
    const isCached = pointCloudCache.has(`${captureId}/${resolved.view.filename}`);
    const deleteTitle = role === 'owner' ? 'Delete Capture' : 'Remove from library';
    const deleteBtn = isLoggedIn
        ? `<button class="item-delete-inline" title="${deleteTitle}" data-capture-id="${captureId}" data-role="${role}">${SVG_TRASH}</button>`
        : '';
    el.innerHTML = `
    <div class="item-content">
      <div class="item-title">${formatCaptureDate(createdAt)}</div>
      <div class="item-meta">${metaText}</div>
    </div>
    ${deleteBtn}
    <span class="item-status-icon${isCached ? ' cached' : ''}" title="${isCached ? 'Cached locally' : 'Not cached'}">${isCached ? SVG_CACHED : SVG_CLOUD}</span>
  `;
    attachItemHandlers(el, captureId, resolved, role, createdAt);
}

function attachItemHandlers(el: HTMLButtonElement, captureId: string, resolved: ResolvedPointCloud, role: string, createdAt: string): void {
    el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.item-delete-inline')) return;
        selectPointCloud(captureId, resolved, el, createdAt);
    });

    const delBtn = el.querySelector<HTMLButtonElement>('.item-delete-inline');
    if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await performDeleteCapture(captureId, resolved.view.filename, el, role);
        });
    }
}

async function performDeleteCapture(captureId: string, viewFilename: string, listItemEl: HTMLButtonElement, role: string): Promise<void> {
    const confirmMsg = role === 'owner'
        ? `Delete Capture "${captureId}" permanently?`
        : `Remove "${captureId}" from your library?`;
    if (!confirm(confirmMsg)) return;
    try {
        await deleteCapture(captureId);
        const pcKey = `${captureId}/${viewFilename}`;
        if (selectedPcKey === pcKey) {
            selectedPcKey = null;
            activeListItemEl = null;
            if (viewFilename !== '__colmap__') {
                unloadPointCloud();
                viewerEmpty.classList.remove('hidden');
                pointSizeControl.classList.add('hidden');
                const pcd = document.getElementById('point-count-display');
                if (pcd) pcd.textContent = '';
            } else {
                unloadColmapCameras();
                clearColmapImageCache();
                document.getElementById('colmap-tooltip')?.classList.remove('visible');
                viewerEmpty.classList.remove('hidden');
                pointSizeControl.classList.add('hidden');
                pointSizeControl.classList.remove('count-only');
                const pcd = document.getElementById('point-count-display');
                if (pcd) pcd.textContent = '';
            }
            setStatus('');
        }
        itemDownloadsSection.classList.remove('open');
        if (itemDownloadsSection.parentNode) {
            itemDownloadsSection.parentNode.removeChild(itemDownloadsSection);
        }
        dlSlotPly.classList.remove('open');
        dlSlotColmap.classList.remove('open');
        dlSlotMesh.classList.remove('open');
        dlSlotShare.classList.remove('open');
        document.getElementById('dl-slot-delete')?.classList.remove('open');
        listItemEl.remove();
        if (activeListItemEl === listItemEl) activeListItemEl = null;
        if (sessionList.children.length === 0) {
            sessionList.innerHTML = '<div class="empty-state">No point clouds available.</div>';
        }
        showToast(role === 'owner' ? 'Capture deleted.' : 'Capture removed from library.', 'success');
    } catch (err) {
        showToast(`Delete failed: ${err instanceof Error ? err.message : err}`, 'error');
    }
}

async function selectPointCloud(captureId: string, resolved: ResolvedPointCloud, el: HTMLButtonElement, createdAt: string): Promise<void> {
    const pc = resolved.view;
    const pcKey = `${captureId}/${pc.filename}`;
    if (selectedPcKey === pcKey) return;

    const myToken = ++loadToken;
    const isCurrent = () => myToken === loadToken;

    clearColmapImageCache();

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
    dlSlotShare.classList.remove('open');

    viewerEmpty.classList.add('hidden');
    viewerProgress.textContent = 'Preparing…';
    viewerLoading.classList.remove('hidden');

    await updateDownloadButtons(captureId, resolved, createdAt);
    setDownloadBusy(true);

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
                if (!isCurrent()) return;
                if (f > 0) viewerProgress.textContent = `Downloading… ${Math.round(f * 100)} %`;
            }, pc.size_bytes);
            pointCloudCache.set(cacheKey, buffer);
        }
        if (!isCurrent()) return;

        viewerProgress.textContent = 'Parsing…';
        await new Promise(r => setTimeout(r, 50));
        if (!isCurrent()) return;
        await loadPointCloudFromBuffer(buffer, (msg) => {
            if (!isCurrent()) return;
            viewerProgress.textContent = msg;
            setStatus(msg);
        });
        if (!isCurrent()) return;
        lastLoadedBuffer = buffer;
        lastLoadedFilename = pc.filename;
        lastDownloadCaptureId = captureId;
        lastDownloadPc = resolved.download;
        prefetchedDownloadBuffer = buffer;
        pointSizeControl.classList.remove('count-only');
        pointSizeControl.classList.remove('hidden');


        const count = getPointCount();
        const countStr = count.toLocaleString('de-DE') + ' Points';

        const pointCountEl = document.getElementById('point-count-display');
        if (pointCountEl) pointCountEl.textContent = countStr;

        pointSizeSlider.min = '0.001';
        pointSizeSlider.max = '0.05';
        pointSizeSlider.step = '0.001';
        pointSizeSlider.value = '0.005';
        setPointSize(0.005);

        setStatus(`Loaded Point Cloud for Capture_${captureId}`);
        showToast('Successfully loaded capture.', 'success');
        updateItemCacheIcon(el, true);
    } catch (err: unknown) {
        if (!isCurrent()) return;
        selectedPcKey = null;
        el.classList.remove('active');
        setStatus(`Error: ${err instanceof Error ? err.message : err}`);
    } finally {
        if (isCurrent()) {
            viewerLoading.classList.add('hidden');
            setDownloadBusy(false);
        }
    }
}

function setStatus(_msg: string): void {}

function setDownloadBusy(busy: boolean): void {
    (downloadBtn as HTMLButtonElement).disabled = busy;
    (downloadColmapBtn as HTMLButtonElement).disabled = busy;
    (downloadMeshBtn as HTMLButtonElement).disabled = busy;
    if (!busy) {
        setProgress(dlProgressPly, null);
        setProgress(dlProgressColmap, null);
        setProgress(dlProgressMesh, null);
    }
}

function setProgress(bar: HTMLElement, fraction: number | null): void {
    if (fraction === null) {
        bar.classList.remove('active');
        (bar.querySelector('.dl-progress-fill') as HTMLElement).style.width = '0%';
    } else {
        bar.classList.add('active');
        (bar.querySelector('.dl-progress-fill') as HTMLElement).style.width = `${Math.round(fraction * 100)}%`;
    }
}

async function updateDownloadButtons(captureId: string, resolved: ResolvedPointCloud, createdAt: string): Promise<void> {
    lastDownloadCaptureId = captureId;
    lastDownloadCreatedAt = createdAt;
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

    if (isLoggedIn) {
        dlSlotShare.classList.add('open');
    } else {
        dlSlotShare.classList.remove('open');
    }

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
