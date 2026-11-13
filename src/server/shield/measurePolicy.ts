import type { CollateralAssessment } from "./collateralRisk.js";
import type { Provider } from "./types.js";

// PASO D: per-ISP block-type recommendation. An IP block over shared or
// unverifiable infrastructure is never recommended — collateral damage is
// penalized harder than a missed ip block.
export const UNSAFE_MEASURE_MOTIVO = "sin medida segura disponible";

export interface MeasureRecommendation {
    proveedorId: string;
    tipo: "dominio" | "ip" | null;
    /** Block target: the real stream host for dominio, the server IP for ip. */
    objetivo: string | null;
    motivo: string;
}

export function recomendarMedidas(
    assessment: Pick<CollateralAssessment, "host_stream" | "ip_servidor" | "riesgoCompartido">,
    providers: Provider[],
): MeasureRecommendation[] {
    return providers.map((provider) => {
        const caps = provider.capacidades;

        if (assessment.riesgoCompartido) {
            if (caps.includes("dominio")) {
                return {
                    proveedorId: provider.id,
                    tipo: "dominio",
                    objetivo: assessment.host_stream,
                    motivo: "shared or unverifiable IP; domain block avoids collateral damage",
                };
            }
            return {
                proveedorId: provider.id,
                tipo: null,
                objetivo: null,
                motivo: UNSAFE_MEASURE_MOTIVO,
            };
        }

        if (caps.includes("ip")) {
            return {
                proveedorId: provider.id,
                tipo: "ip",
                objetivo: assessment.ip_servidor,
                motivo: "dedicated IP; provider supports ip blocks",
            };
        }
        if (caps.includes("dominio")) {
            return {
                proveedorId: provider.id,
                tipo: "dominio",
                objetivo: assessment.host_stream,
                motivo: "provider supports dominio only",
            };
        }
        return {
            proveedorId: provider.id,
            tipo: null,
            objetivo: null,
            motivo: "provider accepts no supported block type",
        };
    });
}
