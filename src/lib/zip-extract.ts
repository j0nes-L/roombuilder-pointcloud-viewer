import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflateRawAsync = promisify(inflateRaw);

function readU16(b: Uint8Array, o: number): number {
    return b[o] | (b[o + 1] << 8);
}
function readU32(b: Uint8Array, o: number): number {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

interface ZipCDEntry {
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
    name: string;
}

export async function extractFileFromZip(
    zipUrl: string,
    headers: Record<string, string>,
    targetName: string,
): Promise<Uint8Array | null> {
    let totalSize = 0;

    const headRes = await fetch(zipUrl, { method: 'HEAD', headers });
    if (headRes.ok) {
        totalSize = parseInt(headRes.headers.get('Content-Length') ?? '0', 10);
    }

    if (!totalSize) {
        const rangeRes = await fetch(zipUrl, { headers: { ...headers, Range: 'bytes=0-0' } });
        if (!rangeRes.ok && rangeRes.status !== 206) return null;
        try { rangeRes.body?.cancel(); } catch {}
        const cr = rangeRes.headers.get('Content-Range');
        if (cr) {
            const m = cr.match(/\/(\d+)\s*$/);
            if (m) totalSize = parseInt(m[1], 10);
        }
        if (!totalSize) totalSize = parseInt(rangeRes.headers.get('Content-Length') ?? '0', 10);
    }

    if (!totalSize) return null;

    const eocdRes = await fetch(zipUrl, {
        headers: { ...headers, Range: `bytes=${totalSize - 22}-${totalSize - 1}` },
    });
    if (!eocdRes.ok && eocdRes.status !== 206) return null;
    const eocd = new Uint8Array(await eocdRes.arrayBuffer());
    if (readU32(eocd, 0) !== 0x06054b50) return null;

    const cdSize = readU32(eocd, 12);
    const cdOffset = readU32(eocd, 16);

    const cdRes = await fetch(zipUrl, {
        headers: { ...headers, Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` },
    });
    if (!cdRes.ok && cdRes.status !== 206) return null;
    const cd = new Uint8Array(await cdRes.arrayBuffer());

    let found: ZipCDEntry | null = null;
    let pos = 0;
    while (pos + 46 <= cd.length) {
        if (readU32(cd, pos) !== 0x02014b50) break;
        const method = readU16(cd, pos + 10);
        const compressedSize = readU32(cd, pos + 20);
        const uncompressedSize = readU32(cd, pos + 24);
        const nameLen = readU16(cd, pos + 28);
        const extraLen = readU16(cd, pos + 30);
        const commentLen = readU16(cd, pos + 32);
        const localOffset = readU32(cd, pos + 42);
        const name = new TextDecoder().decode(cd.slice(pos + 46, pos + 46 + nameLen));
        if (name === targetName) {
            found = { method, compressedSize, uncompressedSize, localOffset, name };
            break;
        }
        pos += 46 + nameLen + extraLen + commentLen;
    }
    if (!found) return null;

    const lhRes = await fetch(zipUrl, {
        headers: { ...headers, Range: `bytes=${found.localOffset}-${found.localOffset + 29}` },
    });
    if (!lhRes.ok && lhRes.status !== 206) return null;
    const lh = new Uint8Array(await lhRes.arrayBuffer());
    const nameLen2 = readU16(lh, 26);
    const extraLen2 = readU16(lh, 28);
    const dataStart = found.localOffset + 30 + nameLen2 + extraLen2;

    const dataRes = await fetch(zipUrl, {
        headers: { ...headers, Range: `bytes=${dataStart}-${dataStart + found.compressedSize - 1}` },
    });
    if (!dataRes.ok && dataRes.status !== 206) return null;
    const compressed = Buffer.from(await dataRes.arrayBuffer());

    if (found.method === 0) return new Uint8Array(compressed);
    if (found.method === 8) return new Uint8Array(await inflateRawAsync(compressed));
    return null;
}

