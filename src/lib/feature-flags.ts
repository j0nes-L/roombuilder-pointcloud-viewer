function readFlag(name: string): string | undefined {
    const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined;
    return fromProcess ?? (import.meta.env as Record<string, string | undefined>)[name];
}

function isTruthy(value: string | undefined): boolean {
    if (!value) return false;
    return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function isRegistrationEnabled(): boolean {
    return isTruthy(readFlag('ENABLE_REGISTER'));
}
