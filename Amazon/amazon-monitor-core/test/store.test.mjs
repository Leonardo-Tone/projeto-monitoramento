import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/store.mjs";

test("store salva estado, eventos, observações e impede duas instâncias", async () => {
    const pasta = await mkdtemp(join(tmpdir(), "aod-core-test-"));
    const a = new FileStore(pasta);
    const b = new FileStore(pasta);
    try {
        const estado = await a.iniciar();
        assert.deepEqual(estado.products, {});
        await assert.rejects(b.iniciar(), /bloqueado/);
        estado.products.ASIN = {snapshot:{totalInformado:2}};
        await a.salvar(estado);
        await a.observar({tipo:"OBSERVACAO", asin:"ASIN"});
        await a.evento({tipo:"TESTE", id:"1"});
        await a.fechar();
        const c = new FileStore(pasta);
        try {
            const restaurado = await c.iniciar();
            assert.equal(restaurado.products.ASIN.snapshot.totalInformado,2);
        } finally {await c.fechar();}
        assert.match(await readFile(join(pasta,"events.jsonl"),"utf8"), /TESTE/);
    } finally {
        await a.fechar();
        await rm(pasta,{recursive:true,force:true});
    }
});
