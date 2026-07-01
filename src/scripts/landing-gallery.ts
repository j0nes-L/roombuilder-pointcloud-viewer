const gallery = document.getElementById('about-gallery');
const track = document.getElementById('gallery-track');
const prevBtn = document.getElementById('gallery-prev');
const nextBtn = document.getElementById('gallery-next');
const dotsBox = document.getElementById('gallery-dots');

if (gallery && track && prevBtn && nextBtn && dotsBox) {
    const slides = Array.from(track.children) as HTMLElement[];
    const count = slides.length;
    let index = 0;

    const dots: HTMLButtonElement[] = [];
    for (let i = 0; i < count; i++) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'gallery-dot';
        dot.setAttribute('role', 'tab');
        dot.setAttribute('aria-label', `Go to image ${i + 1}`);
        dot.addEventListener('click', () => goTo(i));
        dotsBox.appendChild(dot);
        dots.push(dot);
    }

    function update(): void {
        track!.style.transform = `translate3d(${-index * 100}%, 0, 0)`;
        slides.forEach((s, i) => s.setAttribute('aria-hidden', i === index ? 'false' : 'true'));
        dots.forEach((d, i) => {
            const active = i === index;
            d.classList.toggle('active', active);
            d.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }

    function goTo(i: number): void {
        index = (i % count + count) % count;
        update();
    }

    const next = () => goTo(index + 1);
    const prev = () => goTo(index - 1);

    nextBtn.addEventListener('click', next);
    prevBtn.addEventListener('click', prev);

    gallery.tabIndex = 0;
    gallery.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    });

    let startX = 0;
    let dragging = false;
    gallery.addEventListener('pointerdown', (e: PointerEvent) => {
        dragging = true;
        startX = e.clientX;
    });
    gallery.addEventListener('pointerup', (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 40) {
            if (dx < 0) next();
            else prev();
        }
    });
    gallery.addEventListener('pointercancel', () => { dragging = false; });

    update();
}

export {};

