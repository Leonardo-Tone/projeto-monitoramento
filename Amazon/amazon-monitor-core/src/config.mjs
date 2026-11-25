import { readFile } from "node:fs/promises";

export const CATEGORIAS = Object.freeze([
    "AMAZON_DIRETA",
    "TERCEIRO_ENVIO_AMAZON",
    "TERCEIRO_ENVIO_PROPRIO"
]);

export function validarConfig(config) {
    if (config?.schemaVersion !== 1) {
        throw new Error("schemaVersion não suportado: esperado 1");
    }

    if (![10, 15, 20, 30, 60].includes(config.intervalSeconds)) {
        throw new Error("intervalSeconds precisa ser 10, 15, 20, 30 ou 60");
    }

    if (!Number.isInteger(config.maxConcurrency) ||
        config.maxConcurrency < 1 || config.maxConcurrency > 10) {
        throw new Error("maxConcurrency deve estar entre 1 e 10");
    }

    if (!Number.isInteger(config.timeoutMs) ||
        config.timeoutMs < 1000 || config.timeoutMs > 30000) {
        throw new Error("timeoutMs deve estar entre 1000 e 30000");
    }

    if (config.confirmationCycles != null &&
        (!Number.isInteger(config.confirmationCycles) ||
         config.confirmationCycles < 1 || config.confirmationCycles > 5)) {
        throw new Error("confirmationCycles deve estar entre 1 e 5");
    }

    if (!Number.isInteger(config.maxConsecutiveFailures) ||
        config.maxConsecutiveFailures < 1 || config.maxConsecutiveFailures > 10) {
        throw new Error("maxConsecutiveFailures deve estar entre 1 e 10");
    }

    if (!Array.isArray(config.products) || config.products.length === 0) {
        throw new Error("Configuração precisa conter produtos");
    }

    const vistos = new Set();
    for (const produto of config.products) {
        if (!/^[A-Z0-9]{10}$/.test(produto.asin ?? "")) {
            throw new Error(`ASIN inválido: ${produto.asin}`);
        }
        if (vistos.has(produto.asin)) {
            throw new Error(`ASIN duplicado: ${produto.asin}`);
        }
        vistos.add(produto.asin);

        if (typeof produto.name !== "string" || !produto.name.trim()) {
            throw new Error(`Nome ausente: ${produto.asin}`);
        }
        if (typeof produto.enabled !== "boolean") {
            throw new Error(`enabled inválido: ${produto.asin}`);
        }
        if (!Array.isArray(produto.categories) ||
            !produto.categories.every(c => CATEGORIAS.includes(c))) {
            throw new Error(`categories inválido: ${produto.asin}`);
        }
        const alvo = produto.target ?? {};
        if (alvo.maxPriceCents != null &&
            (!Number.isInteger(alvo.maxPriceCents) || alvo.maxPriceCents < 0)) {
            throw new Error(`maxPriceCents inválido: ${produto.asin}`);
        }
        if (![undefined, "NORMAL", "DISPLAYED"].includes(alvo.priceBasis)) {
            throw new Error(`priceBasis inválido: ${produto.asin}`);
        }
        if (alvo.includeShipping != null && typeof alvo.includeShipping !== "boolean") {
            throw new Error(`includeShipping inválido: ${produto.asin}`);
        }
        if (alvo.minQuantity != null &&
            (!Number.isInteger(alvo.minQuantity) || alvo.minQuantity < 1)) {
            throw new Error(`minQuantity inválido: ${produto.asin}`);
        }
    }
    return config;
}

export async function carregarConfig(caminho) {
    const conteudo = await readFile(caminho, "utf8");
    return validarConfig(JSON.parse(conteudo));
}
