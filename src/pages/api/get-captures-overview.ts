import type {APIRoute} from 'astro';
import {getApiUrl} from '../../lib/endpoint-config';
import {createSupabaseServerClientFromRequest} from '../../lib/supabase-server';
import {listUserCaptures, requireUser, unauthorizedResponse} from '../../lib/capture-permissions';

interface CaptureListItem {
    id: string;
    folder: string;
    raw_images: number;
    preprocessed_images: number;
    created_at: string;
}

interface PointCloudInfo {
    filename: string;
    size_bytes: number;
    url: string;
}

interface PointCloudsResponse {
    capture_id: string;
    pointclouds: PointCloudInfo[];
    chunks: PointCloudInfo[];
    draco_chunks: PointCloudInfo[];
    isColmap?: boolean;
    colmap_url?: string | null;
    colmap_size_bytes?: number | null;
}

interface MeshInfo {
    available: boolean;
    size_bytes: number | null;
}

interface CaptureOverviewEntry extends CaptureListItem {
    pointclouds_info: PointCloudsResponse | null;
    mesh_info: MeshInfo;
    role: string;
    upstream_status?: number | null;
    upstream_error?: string | null;
}

const FANOUT_CONCURRENCY = 16;

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let idx = 0;
    const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
        while (true) {
            const i = idx++;
            if (i >= items.length) return;
            results[i] = await worker(items[i]);
        }
    });
    await Promise.all(runners);
    return results;
}

export const GET: APIRoute = async ({request}) => {
    const apiKey = import.meta.env.SNAPSPACE_API_KEY;
    const baseUrl = getApiUrl();

    if (!apiKey) {
        return new Response(JSON.stringify({error: 'API key is not configured.'}), {
            status: 500,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const responseHeaders = new Headers({'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);
    const user = await requireUser(supabase);
    if (!user) return unauthorizedResponse();

    const allowedEntries = await listUserCaptures(supabase);
    if (allowedEntries.length === 0) {
        return new Response(JSON.stringify({captures: []}), {status: 200, headers: responseHeaders});
    }

    try {
        const enriched = await mapWithConcurrency(allowedEntries, FANOUT_CONCURRENCY, async (entry) => {
            const id = encodeURIComponent(entry.capture_id);
            const role = entry.role;
            const created_at = entry.created_at;

            const pointcloudsP = (async (): Promise<{data: PointCloudsResponse | null; status: number | null; error: string | null}> => {
                try {
                    const url = `${baseUrl}/captures/${id}/files`;
                    const r = await fetch(url, {headers: {'X-API-Key': apiKey}});
                    if (!r.ok) {
                        const text = await r.text().catch(() => '');
                        console.warn(`[overview] upstream ${r.status} for capture ${entry.capture_id}: ${text.slice(0, 200)}`);
                        return {data: null, status: r.status, error: text.slice(0, 200) || null};
                    }
                    const data = await r.json() as PointCloudsResponse;
                    return {data, status: r.status, error: null};
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    console.warn(`[overview] fetch failed for capture ${entry.capture_id}: ${msg}`);
                    return {data: null, status: null, error: msg};
                }
            })();

            const meshP = (async (): Promise<MeshInfo> => {
                const meshUrl = `${baseUrl}/captures/${id}/files/mesh.glb`;
                try {
                    const head = await fetch(meshUrl, {method: 'HEAD', headers: {'X-API-Key': apiKey}});
                    if (head.status === 405 || head.status === 501) {
                        const range = await fetch(meshUrl, {
                            method: 'GET',
                            headers: {'X-API-Key': apiKey, Range: 'bytes=0-0'},
                        });
                        try { range.body?.cancel(); } catch {}
                        if (!range.ok && range.status !== 206) return {available: false, size_bytes: null};
                        const cr = range.headers.get('Content-Range');
                        let size: number | null = null;
                        if (cr) {
                            const m = cr.match(/\/(\d+)\s*$/);
                            if (m) size = parseInt(m[1], 10);
                        }
                        return {available: true, size_bytes: size};
                    }
                    if (!head.ok) return {available: false, size_bytes: null};
                    const cl = head.headers.get('Content-Length');
                    return {available: true, size_bytes: cl ? parseInt(cl, 10) : null};
                } catch {
                    return {available: false, size_bytes: null};
                }
            })();

            const [pcResult, mesh_info] = await Promise.all([pointcloudsP, meshP]);

            const captureItem: CaptureOverviewEntry = {
                id: entry.capture_id,
                folder: entry.capture_id,
                raw_images: 0,
                preprocessed_images: 0,
                created_at,
                pointclouds_info: pcResult.data,
                mesh_info,
                role,
                upstream_status: pcResult.status,
                upstream_error: pcResult.error,
            };
            return captureItem;
        });


        return new Response(JSON.stringify({captures: enriched}), {
            status: 200,
            headers: responseHeaders,
        });

    } catch (error) {
        return new Response(JSON.stringify({
            error: 'An internal error occurred.',
            details: error instanceof Error ? error.message : String(error),
        }), {
            status: 500,
            headers: {'Content-Type': 'application/json'},
        });
    }
};

