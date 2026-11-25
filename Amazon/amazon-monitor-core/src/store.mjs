import { mkdir, readFile, open, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

export class FileStore {
    constructor(pasta) {
        this.pasta = pasta;
        this.estadoPath = join(pasta, "state.json");
        this.eventosPath = join(pasta, "events.jsonl");
        this.observacoesPath = join(pasta, "observations.jsonl");
        this.lockPath = join(pasta, "monitor.lock");
        this.temLock = false;
        this.idsPublicados = new Set();
    }

    async iniciar() {
        if (this.temLock) throw new Error("FileStore já iniciado");
        await mkdir(this.pasta, { recursive: true });
        let trava;
        try {
            trava = await open(this.lockPath, "wx");
        } catch (erro) {
            if (erro.code === "EEXIST") {
                throw new Error(
                    `Monitor já bloqueado: ${this.lockPath}. Verifique processos ativos ` +
                    "antes de excluir manualmente o arquivo monitor.lock."
                );
            }
            throw erro;
        }
        this.temLock = true;
        try {
            await trava.writeFile(JSON.stringify({
                pid: process.pid, startedAt: new Date().toISOString()
            }));
        } finally {
            await trava.close();
        }

        let estado;
        try {
            estado = JSON.parse(await readFile(this.estadoPath, "utf8"));
        } catch (erro) {
            if (erro.code !== "ENOENT") throw erro;
            estado = { schemaVersion: 1, products: {}, updatedAt: null };
        }
        if (estado.schemaVersion !== 1 || !estado.products ||
            typeof estado.products !== "object") {
            throw new Error("state.json incompatível (schemaVersion=1)");
        }
        if (estado.outbox == null) estado.outbox = [];
        if (!Array.isArray(estado.outbox) || estado.outbox.some(e => !e?.id)) {
            throw new Error("state.json contém outbox inválida");
        }

        // Índice de IDs persistidos. Sem assumir que o último estado e o log
        // foram atualizados no mesmo instante: a recuperação verifica o log.
        this.idsPublicados.clear();
        let texto;
        try {
            texto = await readFile(this.eventosPath, "utf8");
        } catch (erro) {
            if (erro.code !== "ENOENT") throw erro;
            texto = "";
        }
        const linhas = texto.split("\n");
        for (let i = 0; i < linhas.length; i++) {
            const linha = linhas[i].trim();
            if (!linha) continue;
            let evento;
            try {
                evento = JSON.parse(linha);
            } catch {
                // Falha fechada: um JSONL truncado exige revisão em vez de
                // reemitir eventos que talvez já tenham sido gravados.
                throw new Error(`events.jsonl inválido na linha ${i + 1}; ` +
                    "preserve o arquivo para recuperação manual");
            }
            if (!evento || typeof evento.id !== "string" || !evento.id) {
                throw new Error(`events.jsonl sem id na linha ${i + 1}`);
            }
            this.idsPublicados.add(evento.id);
        }
        return estado;
    }

    verificarLock() {
        if (!this.temLock) throw new Error("FileStore não iniciado/sem lock");
    }

    async anexarDuravel(caminho, registro) {
        this.verificarLock();
        const handle = await open(caminho, "a");
        try {
            await handle.writeFile(JSON.stringify(registro) + "\n");
            await handle.sync();
        } finally {
            await handle.close();
        }
    }

    async observar(resumo) {
        await this.anexarDuravel(this.observacoesPath, resumo);
    }

    async evento(evento) {
        this.verificarLock();
        if (!evento || typeof evento.id !== "string" || !evento.id) {
            throw new Error("Evento sem id válido");
        }
        if (this.idsPublicados.has(evento.id)) return false;
        await this.anexarDuravel(this.eventosPath, evento);
        this.idsPublicados.add(evento.id);
        return true;
    }

    async salvar(estado) {
        this.verificarLock();
        // Mesmo diretório + rename: o estado e a outbox são um commit atômico.
        const temporario = this.estadoPath + `.tmp-${process.pid}`;
        const handle = await open(temporario, "w");
        try {
            await handle.writeFile(JSON.stringify(estado, null, 2) + "\n");
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await rename(temporario, this.estadoPath);
        } catch (erro) {
            await unlink(temporario).catch(() => {});
            throw erro;
        }
    }

    async publicarPendentes(estado) {
        this.verificarLock();
        const pendentes = estado.outbox ?? [];
        if (!Array.isArray(pendentes)) throw new Error("Outbox inválida");
        if (pendentes.length === 0) return [];

        const escritos = [];
        for (const evento of pendentes) {
            if (await this.evento(evento)) escritos.push(evento);
        }
        // O estado com os IDs é salvo ANTES da publicação; só os eventos
        // já encontrados no log são retirados da outbox depois do append.
        estado.outbox = [];
        await this.salvar(estado);
        return escritos;
    }

    async tamanhosArquivos() {
        const caminhos = {
            state: this.estadoPath,
            events: this.eventosPath,
            observations: this.observacoesPath
        };
        const tamanhos = {};
        for (const [nome, caminho] of Object.entries(caminhos)) {
            try {
                tamanhos[nome] = (await stat(caminho)).size;
            } catch (erro) {
                if (erro.code !== "ENOENT") throw erro;
                tamanhos[nome] = 0;
            }
        }
        return tamanhos;
    }

    async fechar() {
        if (!this.temLock) return;
        this.temLock = false;
        await unlink(this.lockPath).catch(erro => {
            if (erro.code !== "ENOENT") throw erro;
        });
    }
}
