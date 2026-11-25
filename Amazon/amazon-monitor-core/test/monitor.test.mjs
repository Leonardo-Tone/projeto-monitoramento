import test from "node:test";
import assert from "node:assert/strict";
import { Monitor } from "../src/monitor.mjs";

function produto() {
    return {
        asin: "B000GAYQJ0", name: "Casio", enabled: true,
        categories: ["AMAZON_DIRETA", "TERCEIRO_ENVIO_AMAZON", "TERCEIRO_ENVIO_PROPRIO"],
        target: { maxPriceCents: null, priceBasis: "NORMAL", includeShipping: false }
    };
}

function dados(total) {
    return {
        totalInformado: total, totalLista: 1, totalVisivel: 1,
        cobertura: "PRIMEIRA_PAGINA_PARCIAL", destaquePresente: false,
        destaqueExclusivo: false, ofertasNaoConsultadasEstimadas: total - 1,
        ofertas: [{ offerHash: String(Math.random()), sellerId: "VENDEDOR_1",
            vendedor: "Vendedor 1", enviadoPor: "Amazon",
            categoria: "TERCEIRO_ENVIO_AMAZON", precoNormalCentavos: 10000,
            precoExibidoCentavos: 9500, freteCentavos: 0, minQty: 1, maxQty: 4 }],
        httpStatus: 200, duracaoMs: 250, bytesRecebidos: 2000
    };
}

test("monitor emite mudança real, ignora offerHash instável e persiste estado", async () => {
    let leituras = 0;
    const eventos = [];
    const observacoes = [];
    const states = [];
    const store = {
        async iniciar() { return { schemaVersion: 1, products: {}, updatedAt: null }; },
        async observar(o) { observacoes.push(o); },
        async evento(e) { eventos.push(e); },
        async salvar(s) { states.push(JSON.parse(JSON.stringify(s))); },
        async publicarPendentes(s) {
            const pending = [...s.outbox];
            eventos.push(...pending);
            s.outbox = [];
            if (pending.length) await this.salvar(s);
            return pending;
        }
    };
    const config = { intervalSeconds: 10, maxConcurrency: 1, timeoutMs: 12000,
        maxConsecutiveFailures: 3, products: [produto()] };
    const monitor = new Monitor({config, store, consultar: async () => dados(++leituras < 2 ? 36 : 37)});
    await monitor.preparar();
    await monitor.ciclo(1);
    await monitor.ciclo(2);
    await monitor.ciclo(3);
    assert.equal(observacoes.length, 3);
    assert.equal(states.length, 4);
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].tipo, "TOTAL_OFERTAS_AOD_ALTERADO");
    assert.equal(states[2].products.B000GAYQJ0.snapshot.totalInformado, 37);
});

test("bloqueio HTTP sinalizado interrompe monitor sem retentar", async () => {
    const config = { intervalSeconds: 10, maxConcurrency: 1,
        timeoutMs: 12000, maxConsecutiveFailures: 3, products: [produto()] };
    const store = {
        async iniciar() { return {schemaVersion:1, products:{}}; },
        async observar() {}, async evento() {}, async salvar() {},
        async publicarPendentes() { return []; }
    };
    let chamadas = 0;
    const monitor = new Monitor({ config, store, consultar: async () => {
        chamadas++;
        throw Object.assign(new Error("HTTP 429"), {
            code:"HTTP_STATUS", status:429, blocking:true
        });
    }});
    await monitor.preparar();
    monitor.rodando = true;
    await monitor.ciclo(1);
    assert.equal(chamadas, 1);
    assert.equal(monitor.rodando, false);
    assert.equal(monitor.motivoParada, "BLOQUEIO_OU_DESAFIO_DE_ACESSO");
});

test("404 em produtos isolados mantém radar e ciclos ativos, atualizando cada ciclo", async () => {
    const produtos = Array.from({ length: 10 }, (_, i) => ({
        ...produto(), asin: i === 8 ? "B0HGP1BVJD" : i === 9 ? "B0HGNQ3HJJ" : `B000GAYQ${i}`
    }));
    const config = { intervalSeconds: 10, maxConcurrency: 3, timeoutMs: 12000,
        maxConsecutiveFailures: 3, products: produtos };
    const estado = { schemaVersion: 1, products: {}, outbox: [] };
    const observacoes = [], atualizacoesPainel = new Map();
    const store = {
        async iniciar() { return estado; },
        async observar(o) { observacoes.push(o); }, async evento() {},
        async salvar(s) { Object.assign(estado, structuredClone(s)); },
        async publicarPendentes() { return []; }
    };
    const monitor = new Monitor({ config, store, consultar: async asin => {
        if (asin === "B0HGP1BVJD" || asin === "B0HGNQ3HJJ")
            throw Object.assign(new Error(`HTTP 404 no ASIN ${asin}`), { code: "HTTP_STATUS", status: 404, blocking: false });
        return dados(36);
    }});
    monitor.on("snapshot", snapshot => atualizacoesPainel.set(snapshot.asin, (atualizacoesPainel.get(snapshot.asin) ?? 0) + 1));
    monitor.on("problem", issue => atualizacoesPainel.set(issue.asin, (atualizacoesPainel.get(issue.asin) ?? 0) + 1));
    const ciclos = [];
    monitor.on("cycle", cycle => ciclos.push(cycle));
    await monitor.preparar();
    monitor.rodando = true;
    for (let i = 1; i <= 10; i++) await monitor.ciclo(i);
    assert.equal(ciclos.length, 10);
    assert.equal(monitor.rodando, true);
    assert.equal(ciclos.every(c => c.produtos === 10 && c.sucesso === 8 && c.falhas === 2), true);
    assert.equal(atualizacoesPainel.get("B0HGP1BVJD"), 10);
    assert.equal(atualizacoesPainel.get("B0HGNQ3HJJ"), 10);
    assert.equal(atualizacoesPainel.get("B000GAYQ0"), 10);
    assert.equal(estado.products.B0HGP1BVJD.lastError.status, 404);
    assert.equal(estado.products.B0HGNQ3HJJ.lastError.blocking, false);
    assert.equal(config.products.length, 10);
});
