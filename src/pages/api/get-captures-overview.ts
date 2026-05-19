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
    colmap_available?: boolean;
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

            const pointcloudsP = (async (): Promise<PointCloudsResponse | null> => {
                try {
                    const r = await fetch(`${baseUrl}/captures/${id}/pointclouds`, {
                        headers: {'X-API-Key': apiKey},
                    });
                    if (!r.ok) return null;
                    return await r.json() as PointCloudsResponse;
                } catch {
                    return null;
                }
            })();

            const meshP = (async (): Promise<MeshInfo> => {
                const meshUrl = `${baseUrl}/captures/${id}/pointclouds/mesh.glb`;
                try {
                    const head = await fetch(meshUrl, {
                        method: 'HEAD',
                        headers: {'X-API-Key': apiKey},
                    });
                    if (head.status === 405 || head.status === 501) {
                        const range = await fetch(meshUrl, {
                            method: 'GET',
                            headers: {'X-API-Key': apiKey, Range: 'bytes=0-0'},
                        });
                        try {
                            range.body?.cancel();
                        } catch {}
                        if (!range.ok && range.status !== 206) {
                            return {available: false, size_bytes: null};
                        }
                        const cr = range.headers.get('Content-Range');
                        let size: number | null = null;
                        if (cr) {
                            const m = cr.match(/\/(\d+)\s*$/);
                            if (m) size = parseInt(m[1], 10);
                        }
                        return {available: true, size_bytes: size};
                    }
                    if (!head.ok) {
                        return {available: false, size_bytes: null};
                    }
                    const cl = head.headers.get('Content-Length');
                    return {available: true, size_bytes: cl ? parseInt(cl, 10) : null};
                } catch {
                    return {available: false, size_bytes: null};
                }
            })();

            const [pointclouds_info, mesh_info] = await Promise.all([pointcloudsP, meshP]);
            const captureItem: CaptureOverviewEntry = {
                id: entry.capture_id,
                folder: entry.capture_id,
                raw_images: 0,
                preprocessed_images: 0,
                created_at,
                pointclouds_info,
                mesh_info,
                role,
            };
            return captureItem;
        });

        const visible = enriched.filter(e => e.pointclouds_info !== null);

        return new Response(JSON.stringify({captures: visible}), {
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

