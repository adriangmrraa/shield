import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSigningBundle, SigningConfigError, SigningService, UnknownJudgeError } from "../signingService.js";
import { TEST_CLAVES, writeTestJuzgados } from "./judicialHarness.js";

describe("SigningService", () => {
    it("produces the exact contract vector: HMAC(key, 'ord-X|dominio|s1.test|105|jueza-laura-ficticia')", async () => {
        const { filePath } = await writeTestJuzgados();
        const signing = new SigningService(await loadSigningBundle(filePath));

        const firma = signing.signOrder({
            orden_id: "ord-X",
            tipo: "dominio",
            objetivo: "s1.test",
            vence_min: 105,
            juez_id: "jueza-laura-ficticia",
        });

        const esperada = createHmac("sha256", TEST_CLAVES["jueza-laura-ficticia"])
            .update("ord-X|dominio|s1.test|105|jueza-laura-ficticia", "utf8")
            .digest("hex");
        expect(firma).toBe(esperada);
        expect(firma).toMatch(/^[0-9a-f]{64}$/);
    });

    it("signLevantar uses the LEVANTAR|<orden_id>|<juez_id> string", async () => {
        const { filePath } = await writeTestJuzgados();
        const signing = new SigningService(await loadSigningBundle(filePath));

        const firma = signing.signLevantar("ord-9", "juez-martin-ejemplo");

        const esperada = createHmac("sha256", TEST_CLAVES["juez-martin-ejemplo"])
            .update("LEVANTAR|ord-9|juez-martin-ejemplo", "utf8")
            .digest("hex");
        expect(firma).toBe(esperada);
    });

    it("rejects non-integer vence_min and unknown judges", async () => {
        const { filePath } = await writeTestJuzgados();
        const signing = new SigningService(await loadSigningBundle(filePath));

        expect(() =>
            signing.signOrder({ orden_id: "o", tipo: "ip", objetivo: "1.2.3.4", vence_min: 105.5, juez_id: "jueza-laura-ficticia" }),
        ).toThrow(SigningConfigError);
        expect(() =>
            signing.signOrder({ orden_id: "o", tipo: "ip", objetivo: "1.2.3.4", vence_min: 105, juez_id: "juez-x" }),
        ).toThrow(UnknownJudgeError);
    });

    it("fails with a clear error when the keys file is missing", async () => {
        await expect(loadSigningBundle(path.join(tmpdir(), "no-existe-juzgados.json"))).rejects.toBeInstanceOf(
            SigningConfigError,
        );
    });

    it("maps juez_id to its juzgado_id", async () => {
        const { filePath } = await writeTestJuzgados();
        const signing = new SigningService(await loadSigningBundle(filePath));
        expect(signing.juzgadoIdDe("jueza-laura-ficticia")).toBe("jg-centro-3");
        expect(signing.juzgadoIdDe("juez-martin-ejemplo")).toBe("jg-norte-1");
    });
});
