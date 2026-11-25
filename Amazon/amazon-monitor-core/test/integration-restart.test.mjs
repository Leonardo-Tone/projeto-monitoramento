import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/store.mjs";
import { Monitor } from "../src/monitor.mjs";

const ASIN = "B000GAYQJ0";
const produto = {
    asin: ASIN, name: "Casio", enabled: true,
    categories: ["AMAZON_DIRETA", "TERCEIRO_ENVIO_AMAZON", "TERCEIRO_ENVIO_PROPRIO"],
    target: { maxPriceCents: null, priceBasis: "NORMAL", includeShipping: false }
};
const config = { intervalSeconds: 10, maxConcurrency: 1, timeoutMs: 12000,
    maxConsecutiveFailures: 3, products: [produto] };
function dados(valor = 10000, unknown = false) {
    return {
        totalInformado: 1, totalLista: 1, totalVisivel: 1,
        cobertura: "PRIMEIRA_PAGINA_COMPLETA",
        destaquePresente: false, destaqueExclusivo: false,
        ofertasNaoConsultadasEstimadas: 0,
        ofertas: [{
            sellerId: unknown ? null : "SELLER_1", vendedor: unknown ? "Desconhecido" : "Vendedor 1",
            enviadoPor: "Amazon", categoria: unknown ? "DESCONHECIDA" : "TERCEIRO_ENVIO_AMAZON",
            precoNormalCentavos: valor, precoExibidoCentavos: valor,
            freteCentavos: 0, minQty: 1, maxQty: 4, offerHash: String(Math.random())
        }], httpStatus: 200, duracaoMs: 50, bytesRecebidos: 1024
    };
}
async function lerEventos(pasta) {
    try { return (await readFile(join(pasta,"events.jsonl"),"utf8")).trim()
        .split("\n").filter(Boolean).map(l=>JSON.parse(l)); }
    catch(e) { if(e.code === "ENOENT") return []; throw e; }
}
async function comPasta(fn) {
    const pasta = await mkdtemp(join(tmpdir(),"aod-integ-"));
    try { await fn(pasta); } finally { await rm(pasta,{recursive:true,force:true}); }
}

test("monitor retoma snapshot anterior, sem evento duplicado após restart", () => comPasta(async pasta => {
    const a = new FileStore(pasta);
    const monitor1 = new Monitor({ config, store:a, consultar:async()=>dados(10000, true) });
    const exibidos = [];
    monitor1.on("event", e=>exibidos.push(e));
    await monitor1.preparar();
    await monitor1.ciclo(1);
    assert.equal(exibidos.length, 1);
    assert.equal(exibidos[0].tipo, "VENDEDOR_DESCONHECIDO_VISIVEL");
    await a.fechar();

    const b = new FileStore(pasta);
    const monitor2 = new Monitor({ config, store:b, consultar:async()=>dados(10000, true) });
    await monitor2.preparar();
    await monitor2.ciclo(1); // número repetido, mas não houve transição
    await b.fechar();
    assert.equal((await lerEventos(pasta)).length, 1);
    assert.equal(monitor2.estado.outbox.length, 0);
}));

test("alteração de preço após restart exige confirmação e preserva estado", () => comPasta(async pasta => {
    const a = new FileStore(pasta);
    const m1 = new Monitor({ config, store:a, consultar:async()=>dados(10000) });
    await m1.preparar();
    await m1.ciclo(1);
    await a.fechar();

    const b = new FileStore(pasta);
    const m2 = new Monitor({ config, store:b, consultar:async()=>dados(9000) });
    const publicados = [];
    m2.on("event", e=>publicados.push(e));
    await m2.preparar();
    await m2.ciclo(1);
    assert.deepEqual(publicados, []); // primeira leitura é pendente, não evento confirmado
    await m2.ciclo(2);
    await b.fechar();
    assert.deepEqual(publicados.map(e=>e.tipo), ["MENOR_PRECO_VISIVEL_ALTERADO"]);
    assert.equal((await lerEventos(pasta))[0].id, publicados[0].id);
    const st = JSON.parse(await readFile(join(pasta,"state.json"),"utf8"));
    assert.equal(st.products[ASIN].snapshot.melhoresVisiveis.TERCEIRO_ENVIO_AMAZON.precoNormalCentavos,9000);
    assert.deepEqual(st.outbox, []);
}));

test("JSONL de eventos inválido interrompe a retomada sem apagar dados", () => comPasta(async pasta => {
    await writeFile(join(pasta,"events.jsonl"),'{"id":"incompleto"\n');
    const a = new FileStore(pasta);
    await assert.rejects(a.iniciar(), /events\.jsonl inválido/);
    await a.fechar();
    assert.match(await readFile(join(pasta,"events.jsonl"),"utf8"), /incompleto/);
}));
