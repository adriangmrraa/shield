// Client-side mirrors of the /api/shield payloads (spec §12). Structural
// copies — the server stays the source of truth; these types describe the
// wire shape only, never import server code into the bundle.

export type EstadoExpediente =
  | 'recibido'
  | 'verificado'
  | 'descartado'
  | 'pendiente_juez'
  | 'aprobado'
  | 'rechazado'
  | 'distribuyendo'
  | 'parcial'
  | 'aplicado'
  | 'vencido'
  | 'levantado';

export type EstadoOrden =
  | 'pendiente_envio'
  | 'enviada'
  | 'recibida'
  | 'aplicada'
  | 'fallida'
  | 'vencida'
  | 'levantada'
  | 'rechazada_proveedor'
  | 'bloqueada_turno';

export type TipoBloqueo = 'ip' | 'dominio';

export interface ShieldJudge {
  username: string;
  juez_id: string;
  juzgado_id: string;
  nombre: string;
  role: 'juez';
}

export interface LoginResponse {
  token: string;
  expires_in: number;
  juez: ShieldJudge;
}

export interface Turno {
  juez_id: string;
  desde_min: number;
  hasta_min: number;
}

export interface Reloj {
  minuto_actual: number;
  fin_min: number;
  finalizado: boolean;
  acelerar: number;
}

export interface TrayContext {
  minuto_actual: number | null;
  jueces_de_turno: string[] | null;
  juez_turno_actual: string | null;
  simulador_disponible: boolean;
}

export interface ShieldStatus extends TrayContext {
  reloj: Reloj | null;
  contadores: {
    casos_por_estado: Record<string, number>;
    ordenes_por_estado: Record<string, number>;
    detecciones_vistas: number | null;
  };
  orchestrator: { running: boolean };
}

export interface MedidaPorIsp {
  proveedorId: string;
  tipo: TipoBloqueo | null;
  objetivo: string | null;
  motivo: string;
}

export interface Transicion {
  desde: EstadoExpediente;
  hacia: EstadoExpediente;
  min_sim: number | null;
  ts_iso: string;
  motivo?: string;
}

export interface Expediente {
  expediente_id: string;
  partido_id: string;
  senal_key: string;
  fase_key: string;
  fase_origen: string | null;
  deteccion_ids: string[];
  detectado_min: number;
  ultima_deteccion_min: number;
  pagina: string;
  stream_url: string;
  host_stream: string;
  ip_servidor: string;
  asn: number | null;
  marca_de_agua_extraida: string;
  validacion_marca: {
    marca_valida: boolean;
    prefijo_coincidente: string | null;
    licenciatario: string | null;
  };
  estado_licencia: string;
  captura_sha256: string | null;
  captura_capturada_min: number | null;
  captura_formato: string | null;
  captura_duracion_seg: number | null;
  captura_ref: string | null;
  dns_pasivo: {
    resuelto: boolean;
    organizacion: string | null;
    dominios: string[];
  } | null;
  dominios_compartidos: string[];
  riesgo: {
    ip_compartida: boolean | null;
    dns_resuelto: boolean;
    asn: number | null;
    organizacion: string | null;
  } | null;
  medidas_por_isp: MedidaPorIsp[];
  vence_min_propuesto: number;
  asignado_juez_id: string | null;
  approved_by: string | null;
  approved_min: number | null;
  rejected_by: string | null;
  rejected_min: number | null;
  reject_motivo: string | null;
  estado: EstadoExpediente;
  fuente: string;
  reason_codes: string[];
  creado_en: string;
  creado_min: number;
  ultima_transicion: Transicion | null;
}

export interface ExpedienteConPermiso extends Expediente {
  can_sign: boolean;
}

export interface CasesResponse extends TrayContext {
  cases: ExpedienteConPermiso[];
}

export interface CaseDetailResponse extends TrayContext {
  expediente: Expediente;
  ordenes: ShieldOrder[];
  can_sign: boolean;
}

export interface ShieldOrder {
  orden_id: string;
  expediente_id: string;
  proveedor_id: string;
  tipo: TipoBloqueo;
  objetivo: string;
  vence_min: number;
  juzgado_id: string;
  juez_id: string;
  /** Wire rule: la UI nunca muestra la firma completa — truncar a 12 chars. */
  firma: string;
  estado: EstadoOrden;
  creada_min: number;
  creada_en: string;
  intento?: number;
  enviada_min?: number;
  recibida_min?: number;
  aplicada_min?: number;
  finalizada_min?: number;
  motivo?: string;
  proximo_intento_ms?: number;
  final?: boolean;
}

export interface DetectionView {
  id: string;
  minuto: number;
  pagina: string;
  stream_url: string;
  host_stream: string;
  ip_servidor: string;
  asn: number;
  marca_de_agua_extraida: string;
  captura: { capturada_min: number; formato: string; duracion_seg: number };
  promocion?: Array<{ red: string; url: string; minuto: number }>;
  expediente_id: string | null;
}

export interface DetectionsResponse {
  minuto_actual: number;
  detecciones: DetectionView[];
}

export interface ProviderView {
  id: string;
  nombre: string;
  tamano: string;
  clientes: number;
  capacidades: TipoBloqueo[];
  ordenes: string;
  ordenes_shield: number;
}

export interface AuditEntry {
  seq: number;
  ts_iso: string;
  min_sim: number | null;
  evento: string;
  expediente_id: string | null;
  correlation_id: string;
  datos: Record<string, unknown>;
}

export interface IspMetrics {
  proveedorId: string;
  clientes: number;
  capacidades: TipoBloqueo[];
  enviadas: number;
  reintentos: number;
  slots: number;
  aplicadas: number;
  fallidas: number;
  vencidas: number;
  levantadas: number;
  rechazadas: number;
  en_curso: number;
  demora_deteccion_a_aplicada_min: number[];
  demora_promedio_min: number | null;
  ultimo_estado: EstadoOrden | null;
}

export interface MetricsReport {
  casos_por_estado: Record<string, number>;
  ordenes_por_estado: Record<string, number>;
  detecciones_vistas: number | null;
  audit_eventos: Record<string, number>;
  orchestrator: {
    minuto: number;
    running: boolean;
    casosPorEstado: Record<string, number>;
    contadores: Record<string, number>;
    descartesPorVerdict: Record<string, number>;
  } | null;
  isp: {
    por_isp: IspMetrics[];
    cobertura: {
      clientes_totales: number;
      cobertura_ponderada_pct: number;
      cobertura_alcanzada_ponderada_pct: number;
      por_expediente: Array<{
        expediente_id: string;
        fase_key: string;
        estado: EstadoExpediente;
        clientes_cubiertos: number;
        clientes_alcanzados: number;
        clientes_totales: number;
        cobertura_pct: number;
        cobertura_alcanzada_pct: number;
        slots: Array<{
          proveedorId: string;
          objetivo: string;
          tipo: TipoBloqueo;
          estado: EstadoOrden;
          intento: number;
        }>;
      }>;
    };
  } | null;
}

/** Payload of shield:detection / shield:case / shield:order socket events. */
export interface RealtimePayload extends AuditEntry {
  kind: string;
}
