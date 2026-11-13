import type { Detection } from "./types.js";

// PASO E: phase identity = (signal, host_stream, ip_servidor). The signal is the
// pirate publication channel (the page hosting the player, which survives
// infrastructure migrations); host+ip are the infrastructure phase. Same signal
// on a new host or IP is a NEW phase; repeated detections on the same host+ip
// consolidate into the same phase.
function pageHost(pagina: string): string | null {
    try {
        return new URL(pagina).hostname;
    } catch {
        return null;
    }
}

export function signalKey(detection: Detection): string {
    return (pageHost(detection.pagina) ?? detection.host_stream).toLowerCase();
}

export function phaseKey(detection: Detection): string {
    return [signalKey(detection), detection.host_stream.toLowerCase(), detection.ip_servidor].join("|");
}

export function samePhase(a: Detection, b: Detection): boolean {
    return phaseKey(a) === phaseKey(b);
}
