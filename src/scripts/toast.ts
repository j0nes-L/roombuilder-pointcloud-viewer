export type ToastType = 'success' | 'error' | 'info';

function getIcon(type: ToastType): string {
    if (type === 'success')
        return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
    if (type === 'error')
        return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/></svg>`;
}

export function showToast(message: string, type: ToastType = 'info', duration = 5000) {
    let container = document.getElementById('ss-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'ss-toast-container';
        const hasTopBar = !!document.querySelector('.admin-fixed');
        container.style.top = hasTopBar ? '52px' : '16px';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `ss-toast ss-toast-${type}`;
    toast.innerHTML = `
        <span class="ss-toast-icon">${getIcon(type)}</span>
        <span class="ss-toast-msg">${message}</span>
        <button class="ss-toast-close" aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;
    container.appendChild(toast);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => toast.classList.add('ss-toast-visible'));
    });

    const dismiss = () => {
        toast.classList.remove('ss-toast-visible');
        toast.addEventListener('transitionend', () => toast.remove(), {once: true});
    };

    toast.querySelector('.ss-toast-close')?.addEventListener('click', dismiss);
    if (duration > 0) setTimeout(dismiss, duration);
}

export function initToastFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const type = params.get('toast') as ToastType | null;
    const msg = params.get('msg');
    if (type && msg && ['success', 'error', 'info'].includes(type)) {
        setTimeout(() => showToast(decodeURIComponent(msg), type), 100);
        params.delete('toast');
        params.delete('msg');
        const newSearch = params.toString();
        history.replaceState({}, '', window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash);
    }
}

(window as any).showToast = showToast;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToastFromUrl);
} else {
    initToastFromUrl();
}

