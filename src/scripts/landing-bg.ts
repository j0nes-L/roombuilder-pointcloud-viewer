const canvas = document.getElementById('landing-points') as HTMLCanvasElement | null;
const ctx = canvas ? canvas.getContext('2d') : null;

if (canvas && ctx) {
    initPointGrid(canvas, ctx);
}

function initPointGrid(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    const hero = canvas.closest('.landing-hero') as HTMLElement | null;
    const small = window.innerWidth < 720;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const GX = small ? 13 : 20;
    const GY = small ? 2 : 3;
    const GZ = GX;
    const SPACING = 1;

    const ox = (GX - 1) / 2;
    const oy = (GY - 1) / 2;
    const oz = (GZ - 1) / 2;

    interface Point { x: number; y: number; z: number; }
    const points: Point[] = [];
    for (let ix = 0; ix < GX; ix++) {
        for (let iy = 0; iy < GY; iy++) {
            for (let iz = 0; iz < GZ; iz++) {
                points.push({
                    x: (ix - ox) * SPACING,
                    y: (iy - oy) * SPACING,
                    z: (iz - oz) * SPACING,
                });
            }
        }
    }

    const TILT = 0.55;
    const sinT = Math.sin(TILT);
    const cosT = Math.cos(TILT);
    const ROT_SPEED = 0.01;
    const AUTO_VEL = reduceMotion ? 0 : ROT_SPEED;
    const DRAG_SENS = 0.006;
    const SPIN_DAMP = 2.4;
    const MAX_SPIN = 6;

    const rzMax = Math.hypot(ox, oz);
    const zcMax = oy * sinT + rzMax * cosT;
    const FOV = zcMax * 3 + 6;
    const perspFar = FOV / (FOV + zcMax);
    const perspRange = (FOV / (FOV - zcMax)) - perspFar || 1;

    const rxExtentMin = Math.min(ox, oz);
    const ryExtentMin = oy * cosT + Math.min(ox, oz) * sinT;

    let dpr = 1;
    let w = 0;
    let h = 0;
    let scale = 1;
    let heroH = window.innerHeight;
    let yaw = 0.3;
    let spinVel = AUTO_VEL;
    let dragging = false;
    let last = 0;
    let rafId = 0;
    let running = false;

    function resize(): void {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = canvas.clientWidth || window.innerWidth;
        h = canvas.clientHeight || window.innerHeight;
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
        heroH = (hero && hero.offsetHeight) || window.innerHeight;
        const sX = (w * 0.5) / (rxExtentMin * perspFar);
        const sY = (h * 0.5) / (ryExtentMin * perspFar);
        scale = Math.max(sX, sY) * 1.06;
    }

    function render(): void {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const cx = w * 0.5;
        const cy = h * 0.5;
        const sinY = Math.sin(yaw);
        const cosY = Math.cos(yaw);

        for (const p of points) {
            const rx = p.x * cosY - p.z * sinY;
            const rz = p.x * sinY + p.z * cosY;
            const ry = p.y * cosT - rz * sinT;
            const zc = p.y * sinT + rz * cosT;

            const depth = zc + FOV;
            if (depth <= 0.1) continue;

            const persp = FOV / depth;
            const px = cx + rx * scale * persp;
            const py = cy + ry * scale * persp;

            const t = Math.min(1, Math.max(0, (persp - perspFar) / perspRange));
            const alpha = 0.5 + t * t * 0.5;
            const size = 1.4 + t * 1.5;
            const half = size * 0.5;

            ctx.fillStyle = `rgba(228, 225, 255, ${alpha.toFixed(3)})`;
            ctx.fillRect(px - half, py - half, size, size);
        }
    }

    function applyScroll(): void {
        const progress = Math.min(1, Math.max(0, window.scrollY / heroH));
        canvas.style.opacity = Math.pow(1 - progress, 1.5).toFixed(3);
        canvas.style.transform = `translate3d(0, ${(progress * 6).toFixed(2)}%, 0)`;
        if (!reduceMotion) {
            if (progress < 1) start();
            else stop();
        }
    }

    function frame(now: number): void {
        if (!last) last = now;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;

        if (!dragging) {
            spinVel = AUTO_VEL + (spinVel - AUTO_VEL) * Math.exp(-SPIN_DAMP * dt);
            yaw += spinVel * dt;

            if (reduceMotion && Math.abs(spinVel - AUTO_VEL) < 1e-4) {
                render();
                stop();
                return;
            }
        }

        render();
        rafId = requestAnimationFrame(frame);
    }

    function start(): void {
        if (running) return;
        running = true;
        last = 0;
        rafId = requestAnimationFrame(frame);
    }

    function stop(): void {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
    }

    resize();
    render();
    applyScroll();

    window.addEventListener('scroll', () => { applyScroll(); }, { passive: true });
    window.addEventListener('resize', () => { resize(); render(); applyScroll(); }, { passive: true });

    let pointerId: number | null = null;
    let lastX = 0;
    let lastMoveT = 0;

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
        if (!e.isPrimary) return;
        dragging = true;
        pointerId = e.pointerId;
        lastX = e.clientX;
        lastMoveT = performance.now();
        spinVel = 0;
        canvas.classList.add('grabbing');
        try { canvas.setPointerCapture(e.pointerId); } catch { }
        start();
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
        if (!dragging || e.pointerId !== pointerId) return;
        const now = performance.now();
        const dx = e.clientX - lastX;
        const dt = Math.max(0.001, (now - lastMoveT) / 1000);
        const dYaw = dx * DRAG_SENS;
        yaw += dYaw;
        const inst = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, dYaw / dt));
        spinVel = spinVel * 0.6 + inst * 0.4;
        lastX = e.clientX;
        lastMoveT = now;
        render();
    });

    function endDrag(e: PointerEvent): void {
        if (!dragging || e.pointerId !== pointerId) return;
        dragging = false;
        pointerId = null;
        canvas.classList.remove('grabbing');
        try { canvas.releasePointerCapture(e.pointerId); } catch { }
        last = 0;
        start();
    }

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    if (!reduceMotion) {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) stop();
            else applyScroll();
        });
    }
}

