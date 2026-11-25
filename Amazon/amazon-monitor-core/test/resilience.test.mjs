import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor, calcularProximoSlot } from "../src/monitor.mjs";
import { FileStore } from "../src/store.mjs";
import { adicionarAmostra, percentil, assinaturaRelevante } from "../src/metricas.mjs";
import { validarConfig } from "../src/config.mjs";

const asin = "B000GAYQJ0";
const produto = {
    asin, name: "Produto teste", enabled: true,
    categories: ["AMAZON_DIRETA", "TERCEIRO_ENVIO_AMAZON", "TERCEIRO_ENVIO_PROPRIO"],
    target: { maxPriceCents: null, priceBasis: "NORMAL", includeShipping: false }
};
const config = (extra = {}) => ({
    schemaVersion: 1, intervalSeconds: 10, maxConcurrency: 1,
    timeoutMs: 12000, maxConsecutiveFailures: 3,
    confirmationCycles: 2, products: [produto], ...extra
});
function dados(preco = 10000, offerHash = "hash-volatil") {
    return {
        totalInformado: 1, totalLista: 1, totalVisivel: 1,
        cobertura: "PRIMEIRA_PAGINA_COMPLETA", destaquePresente: false,
        destaqueExclusivo: false, ofertasNaoConsultadasEstimadas: 0,
        ofertas: [{ sellerId: "SELLER_1", vendedor: "Vendedor 1",
            enviadoPor: "Amazon", categoria: "TERCEIRO_ENVIO_AMAZON",
            precoNormalCentavos: preco, precoExibidoCentavos: preco,
            freteCentavos: 0, minQty: 1, maxQty: 1, offerHash }],
        httpStatus: 200, duracaoMs: 50, bytesRecebidos: 1000
    };
}
function storeMemoria() {
    let state = { schemaVersion: 1, products: {}, outbox: [] };
    const eventos = [], observacoes = [];
    return {
        eventos, observacoes,
        async iniciar() { return state; },
        async salvar(s) { state = s; },
        async observar(o) { observacoes.push(o); },
        async publicarPendentes(s) {
            const novos = [...s.outbox];
            s.outbox = [];
            eventos.push(...novos);
            return novos;
        }
    };
}

const pastaTemporaria = async funcao => {
    const pasta = await mkdtemp(join(tmpdir(), "amazon-core-v03-"));
    try { await funcao(pasta); }
    finally { await rm(pasta, { recursive: true, force: true }); }
};

test("timeout isolado > intervalo não para; pula horário vencido e retoma", async () => {
    let relogio = 0;
    let consultas = 0;
    const store = storeMemoria();
    const avisos = [];
    const monitor = new Monitor({
        config: config(), store,
        clock: () => relogio,
        sleep: async ms => { relogio += ms; },
        consultar: async () => {
            consultas++;
            if (consultas === 1) {
                relogio += 10506;
                throw Object.assign(new Error("fetch failed"), {
                    code: "UND_ERR_CONNECT_TIMEOUT", blocking: false
                });
            }
            relogio += 50;
            return dados();
        }
    });
    monitor.on("schedule", x => avisos.push(x));
    const resultado = await monitor.executar({ seconds: 30 });
    assert.equal(resultado.concluido, true);
    assert.equal(resultado.motivo, null);
    assert.equal(resultado.requisicoesTentadas, 2);
    assert.equal(resultado.sucesso, 1);
    assert.equal(resultado.falhas, 1);
    assert.equal(resultado.ciclosLentos, 1);
    assert.equal(resultado.ciclosPulados, 1);
    assert.equal(resultado.maiorAtrasoSlotPuladoMs, 506);
    assert.equal(resultado.maiorCicloMs, 10506);
    assert.equal(resultado.falhasPorCodigo.UND_ERR_CONNECT_TIMEOUT, 1);
    assert.equal(monitor.estado.products[asin].status, "ATUALIZADO");
    assert.deepEqual(avisos.map(x => x.tipo), ["CICLO_LENTO", "SLOTS_PULADOS"]);
});

test("slots perdidos não provocam rajada de execução", () => {
    assert.equal(calcularProximoSlot(0, 10506, 10000, 1), 2);
    assert.equal(calcularProximoSlot(0, 25100, 10000, 1), 3);
    assert.equal(calcularProximoSlot(0, 9600, 10000, 1), 2);
    assert.equal(calcularProximoSlot(0, 9500, 10000, 1), 1);
});

test("flutuação de um único ciclo não gera mudança confirmada", async () => {
    const valores = [10000, 9000, 10000, 8500, 8500, 8500];
    let n = 0;
    const store = storeMemoria();
    const candidatos = [];
    const monitor = new Monitor({
        config: config(), store,
        consultar: async () => dados(valores[n++], String(n))
    });
    monitor.on("candidate", c => candidatos.push(c));
    await monitor.preparar();
    for (let i = 1; i <= valores.length; i++) await monitor.ciclo(i);
    assert.equal(store.eventos.length, 1);
    assert.equal(store.eventos[0].tipo, "MENOR_PRECO_VISIVEL_ALTERADO");
    assert.equal(store.eventos[0].detalhes.anteriorCentavos, 10000);
    assert.equal(store.eventos[0].detalhes.atualCentavos, 8500);
    assert.equal(candidatos.length, 2);
    assert.equal(monitor.estado.products[asin].pendingConfirmation, null);
    assert.equal(monitor.estado.products[asin].confirmedSnapshot
        .melhoresVisiveis.TERCEIRO_ENVIO_AMAZON.precoNormalCentavos, 8500);
});

test("confirmação pendente sobrevive a reinicialização", () => pastaTemporaria(async pasta => {
    const a = new FileStore(pasta);
    const primeiro = new Monitor({ config: config(), store: a,
        consultar: async () => dados(10000) });
    await primeiro.preparar();
    await primeiro.ciclo(1);
    await a.fechar();

    const b = new FileStore(pasta);
    const segundo = new Monitor({ config: config(), store: b,
        consultar: async () => dados(9000) });
    await segundo.preparar();
    await segundo.ciclo(1);
    assert.equal(segundo.estado.products[asin].pendingConfirmation.count, 1);
    await b.fechar();

    const c = new FileStore(pasta);
    const terceiro = new Monitor({ config: config(), store: c,
        consultar: async () => dados(9000) });
    await terceiro.preparar();
    await terceiro.ciclo(1);
    await c.fechar();
    const eventos = (await readFile(join(pasta, "events.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(eventos.map(e => e.tipo), ["MENOR_PRECO_VISIVEL_ALTERADO"]);
    assert.equal(terceiro.estado.products[asin].pendingConfirmation, null);
}));

test("falha entre observações invalida confirmação pendente", async () => {
    let n = 0;
    const store = storeMemoria();
    const monitor = new Monitor({ config: config(), store,
        consultar: async () => {
            n++;
            if (n === 3) throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
            return dados(n === 1 ? 10000 : 9000);
        }
    });
    await monitor.preparar();
    for (let i = 1; i <= 5; i++) await monitor.ciclo(i);
    assert.equal(store.eventos.length, 1);
    assert.equal(store.eventos[0].ciclo, 5);
});

test("métricas ficam limitadas e resumo preserva máximos cumulativos", async () => {
    const store = storeMemoria();
    const monitor = new Monitor({ config: config(), store,
        consultar: async () => dados() });
    await monitor.preparar();
    for (let i = 1; i <= 1500; i++) await monitor.ciclo(i);
    const resumo = monitor.resumo();
    assert.equal(resumo.ciclos, 1500);
    assert.equal(resumo.sucesso, 1500);
    assert.equal(resumo.latencias.length, 1024);
    assert.equal(resumo.duracoes.length, 1024);
    assert.equal(resumo.amostrasLatenciaNaJanela, 1024);
    assert.equal(resumo.latenciaP95ms, 50);
    assert.ok(resumo.maiorCicloMs >= 0);
    const amostras = [];
    for (let i = 0; i < 2048; i++) adicionarAmostra(amostras, i);
    assert.equal(amostras[0], 1024);
    assert.equal(percentil(amostras, 1), 2047);
});

test("configuração de confirmação é validada e pode ser desativada", () => {
    assert.equal(validarConfig(config({ confirmationCycles: 2 })).confirmationCycles, 2);
    assert.throws(() => validarConfig(config({ confirmationCycles: 0 })), /confirmationCycles/);
    assert.equal(validarConfig(config({ confirmationCycles: 1 })).confirmationCycles, 1);
    assert.equal(assinaturaRelevante({ totalInformado: 1, contagem: {} }),
        assinaturaRelevante({ totalInformado: 1, contagem: {}, offerHash: "outro" }));
});

test("duração de 6000 segundos é aceita sem esperar 100 minutos", async () => {
    let relogio = 0;
    const store = storeMemoria();
    const monitor = new Monitor({
        config: config(), store,
        consultar: async () => dados(),
        clock: () => relogio,
        sleep: async ms => { relogio += ms; }
    });
    const resultado = await monitor.executar({ seconds: 6000 });
    assert.equal(resultado.concluido, true);
    assert.equal(resultado.ciclos, 600);
    assert.equal(resultado.requisicoesTentadas, 600);
    assert.equal(resultado.ciclosPulados, 0);
});
