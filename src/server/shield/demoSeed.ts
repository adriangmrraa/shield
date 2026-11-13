import { expedienteSchema, type Expediente, type MedidaPorIsp } from "./expedienteTypes.js";

// DEMO seeding helper: builds a schema-valid expediente in pendiente_juez so
// scripts/tests can exercise the judicial path without a live poller. The
// state machine path (recibido->verificado->pendiente_juez) still belongs to
// CaseService — this only materializes the resulting row.

export function buildPendienteJuezExpediente(overrides: Partial<Expediente> = {}): Expediente {
    const base: Expediente = {
        expediente_id: "EXP-demo-0001",
        partido_id: "demo",
        senal_key: "pelotaya.test",
        fase_key: "pelotaya.test|s1.test|203.0.113.10",
        fase_origen: null,
        deteccion_ids: ["D-SEED-1"],
        detectado_min: 2,
        ultima_deteccion_min: 2,
        pagina: "https://pelotaya.test/en-vivo",
        stream_url: "https://s1.test/hls/en-vivo/index.m3u8",
        host_stream: "s1.test",
        ip_servidor: "203.0.113.10",
        asn: 64600,
        marca_de_agua_extraida: "LP26-PRA-OFI-S048211",
        validacion_marca: { marca_valida: true, prefijo_coincidente: "LP26-PRA-OFI", licenciatario: null },
        estado_licencia: "candidata_no_autorizada",
        captura_sha256: null,
        captura_capturada_min: null,
        captura_formato: null,
        captura_duracion_seg: null,
        captura_ref: null,
        dns_pasivo: { resuelto: true, organizacion: "Bruma Hosting Dedicado (ficticio)", dominios: ["s1.test"] },
        dominios_compartidos: ["s1.test"],
        riesgo: {
            ip_compartida: false,
            dns_resuelto: true,
            asn: 64600,
            organizacion: "Bruma Hosting Dedicado (ficticio)",
        },
        medidas_por_isp: [
            {
                proveedorId: "aurora",
                tipo: "dominio",
                objetivo: "s1.test",
                motivo: "IP dedicada al stream; dominio preferido por menor daño colateral",
            } satisfies MedidaPorIsp,
        ],
        vence_min_propuesto: 105,
        asignado_juez_id: null,
        approved_by: null,
        approved_min: null,
        rejected_by: null,
        rejected_min: null,
        reject_motivo: null,
        estado: "pendiente_juez",
        fuente: "demo-seed",
        reason_codes: ["DEMO_SEED"],
        creado_en: new Date().toISOString(),
        creado_min: 2,
        ultima_transicion: null,
    };
    return expedienteSchema.parse({ ...base, ...overrides });
}
