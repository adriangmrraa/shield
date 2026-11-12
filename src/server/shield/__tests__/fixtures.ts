import type { VerificationSources } from "../verificationEngine.js";
import type { Detection, MatchInfo, PassiveDnsByIp, Provider } from "../types.js";

// Test fixtures shaped like the practice scenario contract (prefixes, licensees,
// providers are read from injected sources — nothing is hardcoded in the engine).

export const matchInfo: MatchInfo = {
    id: "practica-01",
    nombre: "Partido de práctica — Club Ficticio del Norte vs. Deportivo Ejemplo",
    titular_derechos: "Liga Profesional Ficticia",
    inicio_iso: "2026-11-11T18:00:00-03:00",
    fin_min: 105,
    marcas_de_agua_validas: [
        { prefijo: "LP26-PRA-OFI", origen: "Señal oficial del titular (plataforma propia)" },
        { prefijo: "LP26-PRA-LIC-NORTE", origen: "Licenciatario autorizado: Canal Norte TV (ficticio)" },
    ],
    licenciatarios: [
        {
            nombre: "Canal Norte TV (ficticio)",
            prefijo_marca: "LP26-PRA-LIC-NORTE",
            dominios_autorizados: ["canalnorte.test", "envivo.canalnorte.test"],
        },
    ],
};

export const providers: Provider[] = [
    {
        id: "aurora",
        nombre: "Conectividad Aurora (ficticio)",
        tamano: "grande",
        clientes: 3_800_000,
        capacidades: ["ip", "dominio"],
        ordenes: "/proveedores/aurora/ordenes",
    },
    {
        id: "valle",
        nombre: "FibraValle (ficticio)",
        tamano: "chico",
        clientes: 140_000,
        capacidades: ["dominio"],
        ordenes: "/proveedores/valle/ordenes",
    },
    {
        id: "soloip",
        nombre: "Proveedor SoloIP (ficticio)",
        tamano: "chico",
        clientes: 50_000,
        capacidades: ["ip"],
        ordenes: "/proveedores/soloip/ordenes",
    },
];

export function detection(overrides: Partial<Detection> = {}): Detection {
    return {
        id: "D-0001",
        minuto: 2,
        pagina: "https://pelotaya.test/en-vivo",
        stream_url: "https://s1.pelotaya.test/hls/en-vivo/index.m3u8",
        host_stream: "s1.pelotaya.test",
        ip_servidor: "203.0.113.10",
        asn: 64600,
        marca_de_agua_extraida: "LP26-PRA-OFI-S048211",
        captura: { capturada_min: 2, formato: "mpegts", duracion_seg: 6, contenido_b64: "QUJDREVGRw==" },
        ...overrides,
    };
}

export class FakeSources implements VerificationSources {
    readonly dnsRequests: string[] = [];

    constructor(
        private readonly dnsByIp: Record<string, PassiveDnsByIp | null> = {},
        private readonly match: MatchInfo = matchInfo,
        private readonly providerList: Provider[] = providers,
    ) {}

    partido(): Promise<MatchInfo> {
        return Promise.resolve(this.match);
    }

    proveedores(): Promise<Provider[]> {
        return Promise.resolve(this.providerList);
    }

    dnsPasivoPorIp(ip: string): Promise<PassiveDnsByIp | null> {
        this.dnsRequests.push(ip);
        return Promise.resolve(Object.prototype.hasOwnProperty.call(this.dnsByIp, ip) ? this.dnsByIp[ip] : null);
    }
}

/** DNS view of a dedicated pirate IP: only the stream's own infra domains. */
export const dedicatedDns: PassiveDnsByIp = {
    ip: "203.0.113.10",
    asn: 64600,
    organizacion: "Bruma Hosting Dedicado (ficticio)",
    dominios: ["s1.pelotaya.test", "s1-respaldo.pelotaya.test"],
};

/** DNS view of the shared CDN IP behind live.golazo-libre.test (11 foreign domains). */
export const sharedDns: PassiveDnsByIp = {
    ip: "198.51.100.20",
    asn: 64610,
    organizacion: "NubeRápida CDN (ficticia)",
    dominios: [
        "live.golazo-libre.test",
        "tienda-mate-y-yerba.test",
        "noticias-del-valle.test",
        "turismo-cafayate.example",
        "radio-comunitaria-fm.test",
        "municipio-ejemplo.example",
        "biblioteca-popular-norte.test",
        "delivery-salta-ejemplo.test",
        "clinica-veterinaria-sol.test",
        "inmobiliaria-ejemplo.test",
        "academia-de-ingles.test",
        "feria-artesanal.example",
    ],
};
