import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { criarEvento } from "../src/domain.mjs";
import { FileStore } from "../src/store.mjs";

function amostra(tipo = "TOTAL_OFERTAS_AOD_ALTERADO") {
    return criarEvento(
        { asin: "B000GAYQJ0", nome: "Casio", cobertura: "PRIMEIRA_PAGINA_PARCIAL" },
        { tipo, prioridade: "INFO", detalhes: { anterior: 36, atual: 37 } },
        1,
        "2026-11-03T22:00:00Z"
    );
}

async function comPasta(teste) {
    const pasta = await mkdtemp(join(tmpdir(), "aod-v02-"));
    try { await teste(pasta); } finally { await rm(pasta, { recursive: true, force: true }); }
}

async function eventosLidos(pasta) {
    const texto = await readFile(join(pasta, "events.jsonl"), "utf8");
    return texto.trim().split("\n").map(l => JSON.parse(l));
}

test("IDs únicos entre execuções; dedupKey semântica estável", () => {
    const primeiro = amostra();
    const segundo = amostra();
    assert.notEqual(primeiro.id, segundo.id);
    assert.equal(primeiro.dedupKey, segundo.dedupKey);
    assert.equal(primeiro.executavel, false);
});

test("outbox antes da publicação é recuperada", () => comPasta(async pasta => {
    const a = new FileStore(pasta);
    const estado = await a.iniciar();
    const evento = amostra();
    estado.outbox.push(evento);
    await a.salvar(estado);
    await a.fechar(); // queda hipotética antes de append em events.jsonl

    const b = new FileStore(pasta);
    const recuperado = await b.iniciar();
    assert.equal(recuperado.outbox.length, 1);
    const publicados = await b.publicarPendentes(recuperado);
    assert.equal(publicados.length, 1);
    assert.equal(recuperado.outbox.length, 0);
    await b.fechar();
    assert.deepEqual((await eventosLidos(pasta)).map(e => e.id), [evento.id]);
}));

test("queda após append mas antes de ACK não duplica evento", () => comPasta(async pasta => {
    const a = new FileStore(pasta);
    const estado = await a.iniciar();
    const evento = amostra();
    estado.outbox.push(evento);
    await a.salvar(estado);
    await a.evento(evento); // append feito; ACK não foi salvo
    await a.fechar();

    const b = new FileStore(pasta);
    const recuperado = await b.iniciar();
    assert.equal(recuperado.outbox.length, 1);
    assert.deepEqual(await b.publicarPendentes(recuperado), []);
    await b.fechar();
    assert.equal((await eventosLidos(pasta)).length, 1);

    const c = new FileStore(pasta);
    const final = await c.iniciar();
    assert.equal(final.outbox.length, 0);
    await c.fechar();
}));

test("estado v0.1 sem outbox migra sem perder snapshots/eventos", () => comPasta(async pasta => {
    const a = new FileStore(pasta);
    const estado = await a.iniciar();
    estado.products.B000GAYQJ0 = { snapshot: { totalInformado: 37 }, status: "ATUALIZADO" };
    delete estado.outbox;
    await a.salvar(estado);
    const legado = { schemaVersion: 1, id: "legacy-id", tipo: "VENDEDOR_DESCONHECIDO_VISIVEL" };
    await a.evento(legado);
    await a.fechar();

    const b = new FileStore(pasta);
    const migrado = await b.iniciar();
    assert.deepEqual(migrado.outbox, []);
    assert.equal(migrado.products.B000GAYQJ0.snapshot.totalInformado, 37);
    assert.equal(await b.evento(legado), false);
    await b.fechar();
    assert.equal((await eventosLidos(pasta)).length, 1);
}));

test("o lock protege as transições de outbox", () => comPasta(async pasta => {
    const a = new FileStore(pasta);
    const b = new FileStore(pasta);
    await a.iniciar();
    await assert.rejects(b.iniciar(), /bloqueado/);
    await a.fechar();
}));
