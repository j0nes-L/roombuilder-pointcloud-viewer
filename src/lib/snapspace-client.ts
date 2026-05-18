function getApiBase(): string {
    return '/api';
}


export interface CaptureListItem {
    id: string;
    folder: string;
    raw_images: number;
    preprocessed_images: number;
}

export interface CaptureDetail {
    id: string;
    folder: string;
    raw_images: string[];
    preprocessed_images: string[];
    pointclouds: string[];
}

export interface PointCloudInfo {
    filename: string;
    size_bytes: number;
    url: string;
}

export interface PointCloudsResponse {
    capture_id: string;
    pointclouds: PointCloudInfo[];
    chunks: PointCloudInfo[];
    draco_chunks: PointCloudInfo[];
    colmap_available?: boolean;
    colmap_url?: string | null;
    colmap_size_bytes?: number | null;
}

export interface ResolvedPointCloud {
    view: PointCloudInfo;
    download: PointCloudInfo;
    colmap_available: boolean;
    colmap_url: string | null;
    colmap_size_bytes: number | null;
    mesh_available: boolean;
    mesh_size_bytes: number | null;
}

export function resolvePointCloud(resp: PointCloudsResponse): ResolvedPointCloud | null {
    const ply = resp.pointclouds.find(p => p.filename.endsWith('.ply'));
    if (!ply) return null;
    return {
        view: ply,
        download: ply,
        colmap_available: !!resp.colmap_available,
        colmap_url: resp.colmap_url || null,
        colmap_size_bytes: resp.colmap_size_bytes || null,
        mesh_available: false,
        mesh_size_bytes: null,
    };
}

const meshInfoCache = new Map<string, { available: boolean; size_bytes: number | null }>();
const meshInfoInflight = new Map<string, Promise<{ available: boolean; size_bytes: number | null }>>();

export async function checkMeshAvailability(captureId: string): Promise<{ available: boolean; size_bytes: number | null }> {
    const cached = meshInfoCache.get(captureId);
    if (cached) return cached;

    const inflight = meshInfoInflight.get(captureId);
    if (inflight) return inflight;

    const p = (async () => {
        try {
            const res = await fetch(`${getApiBase()}/get-mesh-info?capture_id=${captureId}`);
            if (!res.ok) return {available: false, size_bytes: null};
            const data = await res.json() as { available?: boolean; size_bytes?: number | null };
            const result = {
                available: !!data.available,
                size_bytes: typeof data.size_bytes === 'number' ? data.size_bytes : null,
            };
            meshInfoCache.set(captureId, result);
            return result;
        } catch {
            return {available: false, size_bytes: null};
        } finally {
            meshInfoInflight.delete(captureId);
        }
    })();

    meshInfoInflight.set(captureId, p);
    return p;
}

export function getCachedMeshInfo(captureId: string): { available: boolean; size_bytes: number | null } | null {
    return meshInfoCache.get(captureId) ?? null;
}

export function clearMeshInfoCache(captureId?: string): void {
    if (captureId) {
        meshInfoCache.delete(captureId);
        meshInfoInflight.delete(captureId);
    } else {
        meshInfoCache.clear();
        meshInfoInflight.clear();
    }
}

async function streamResponse(res: Response, onProgress?: (fraction: number) => void, knownTotalBytes?: number | null): Promise<ArrayBuffer> {
    const clHeader = res.headers.get('Content-Length') || res.headers.get('X-Content-Length');
    const total = clHeader ? parseInt(clHeader, 10) : (knownTotalBytes || 0);

    if (!onProgress || !total || !res.body) {
        return res.arrayBuffer();
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(received / total);
    }

    const buf = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        buf.set(chunk, offset);
        offset += chunk.length;
    }
    return buf.buffer;
}

export async function fetchMeshGlb(captureId: string, onProgress?: (fraction: number) => void, knownTotalBytes?: number | null): Promise<ArrayBuffer> {
    const res = await fetch(`${getApiBase()}/get-mesh?capture_id=${captureId}`);
    if (!res.ok) throw new Error(`Failed to download mesh: ${res.status}`);
    return streamResponse(res, onProgress, knownTotalBytes);
}

export async function deleteCapture(captureId: string): Promise<void> {
    const res = await fetch(
        `${getApiBase()}/auth/delete-capture?capture_id=${encodeURIComponent(captureId)}`,
        {method: 'DELETE', credentials: 'include'},
    );
    if (!res.ok) throw new Error(`Failed to delete capture: ${res.status}`);
    pointCloudsRespCache.delete(captureId);
    clearMeshInfoCache(captureId);
}

export interface CaptureOverviewEntry extends CaptureListItem {
    pointclouds_info: PointCloudsResponse | null;
    mesh_info: { available: boolean; size_bytes: number | null };
    role: string;
}

export async function fetchCapturesOverview(forceRefresh = false): Promise<CaptureOverviewEntry[]> {
    const qs = forceRefresh ? '?refresh=1' : '';
    const res = await fetch(`${getApiBase()}/get-captures-overview${qs}`);
    if (!res.ok) throw new Error(`Failed to fetch captures overview: ${res.status}`);
    const data = await res.json() as { captures: CaptureOverviewEntry[] };

    for (const entry of data.captures) {
        if (entry.pointclouds_info) pointCloudsRespCache.set(entry.id, entry.pointclouds_info);
        if (entry.mesh_info) meshInfoCache.set(entry.id, entry.mesh_info);
    }
    return data.captures;
}

const pointCloudsRespCache = new Map<string, PointCloudsResponse>();

export function clearPointCloudsCache(captureId?: string): void {
    if (captureId) pointCloudsRespCache.delete(captureId);
    else pointCloudsRespCache.clear();
    clearMeshInfoCache(captureId);
}


export async function fetchPointCloudData(captureId: string, filename: string, onProgress?: (fraction: number) => void, knownTotalBytes?: number | null): Promise<ArrayBuffer> {
    const res = await fetch(`${getApiBase()}/get-pointcloud?capture_id=${captureId}&filename=${filename}`);
    if (!res.ok) throw new Error(`Failed to download point cloud: ${res.status}`);
    return streamResponse(res, onProgress, knownTotalBytes);
}

export async function fetchColmapZip(captureId: string, onProgress?: (fraction: number) => void, knownTotalBytes?: number | null): Promise<ArrayBuffer> {
    const res = await fetch(`${getApiBase()}/get-colmap?capture_id=${captureId}`);
    if (!res.ok) throw new Error(`Failed to download COLMAP zip: ${res.status}`);
    return streamResponse(res, onProgress, knownTotalBytes);
}
