export function originAllowed(origin, host, publicOrigin) {
    if (!origin)
        return true;
    if (publicOrigin && origin === publicOrigin)
        return true;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=origin.js.map