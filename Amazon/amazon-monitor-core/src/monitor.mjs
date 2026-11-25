import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import {
    construirSnapshot,
    gerarMudancas,
    criarEvento,
    resumoObservacao
} from "./domain.mjs";
import {
    adicionarAmostra,
    percentil,
    criarMetricas,
    assinaturaRelevante,
    LIMITE_JANELA_METRICAS
} from "./metricas.mjs";

const dormir = ms => new Promise(resolve => setTimeout(resolve, ms));
const FOLGA_MINIMA_APOS_CICLO_MS = 500;
const LIMITE_DURACAO_SEGUNDOS = 7 * 24 * 60 * 60;

async function mapLimite(itens, limite, trabalho) {
    const resultados = new Array(itens.length);
    let proximo = 0;
    async function trabalhador() {
        while (proximo < itens.length) {
            const indice = proximo++;
            try {
                resultados[indice] = { ok: true, valor: await trabalho(itens[indice]) };
            } catch (erro) {
                resultados[indice] = { ok: false, erro };
            }
        }
    }
    await Promise.all(Array.from(
        { length: Math.min(limite, itens.length) }, () => trabalhador()
    ));
    return resultados;
}

/** Próximo slot absoluto; nunca recupera períodos vencidos por rajada. */
export function calcularProximoSlot(inicioMs, agoraMs, intervaloMs, proximoIndice,
    folgaMs = FOLGA_MINIMA_APOS_CICLO_MS) {
    const maisCedo = agoraMs + folgaMs;
    return Math.max(proximoIndice,
        Math.ceil((maisCedo - inicioMs) / intervaloMs));
}

export class Monitor extends EventEmitter {
    constructor({ config, store, consultar, coletarCiclo = coletar => coletar(), clock = () => performance.now(), sleep = dormir }) {
        if (typeof consultar !== "function") {
            throw new Error("Monitor precisa receber a função consultar (porta AOD)");
        }
        super();
        this.config = config;
        this.store = store;
        this.consultar = consultar;
        this.coletarCiclo = coletarCiclo;
        this.clock = clock;
        this.sleep = sleep;
        this.estado = null;
        this.rodando = false;
        this.motivoParada = null;
        this.runId = randomUUID();
        this.metricas = criarMetricas();
    }

    async preparar() {
        if (this.estado) return;
        this.estado = await this.store.iniciar();
        if (this.estado.schemaVersion !== 1) {
            throw new Error("Estado persistido incompatível com schemaVersion=1");
        }
        this.estado.products ??= {};
        this.estado.outbox ??= [];
        // Recuperação idempotente: não republica eventos já presentes no JSONL.
        await this.store.publicarPendentes(this.estado);
    }

    parar(motivo = "PARADA_MANUAL") {
        this.rodando = false;
        this.motivoParada ??= motivo;
        this.emit("status", { status: "PARANDO", motivo });
    }

    async ciclo(numero) {
        const produtos = this.config.products.filter(p => p.enabled);
        const inicio = this.clock();
        const resultados = await this.coletarCiclo(() => mapLimite(produtos, this.config.maxConcurrency, async produto => {
            this.metricas.requisicoesTentadas++;
            const dados = await this.consultar(produto.asin, {
                timeoutMs: this.config.timeoutMs
            });
            const snapshot = construirSnapshot(dados, produto);
            return { dados, snapshot };
        }));

        let completados = 0;
        let falhas = 0;
        const observacoes = [];
        const problemas = [];
        const snapshots = [];
        const novosEventos = [];
        const candidatos = [];
        const confirmacoesNecessarias = this.config.confirmationCycles ?? 2;

        // Snapshot, confirmação e outbox são persistidos no mesmo state.json.
        for (let i = 0; i < resultados.length; i++) {
            const produto = produtos[i];
            const resultado = resultados[i];
            const entrada = this.estado.products[produto.asin] ?? {
                snapshot: null, consecutiveFailures: 0
            };

            if (!resultado.ok) {
                falhas++;
                const erro = resultado.erro;
                const codigo = erro.code ?? erro.cause?.code ?? erro.name ?? "UNKNOWN";
                this.metricas.falhasPorCodigo[codigo] =
                    (this.metricas.falhasPorCodigo[codigo] ?? 0) + 1;
                entrada.consecutiveFailures = (entrada.consecutiveFailures ?? 0) + 1;
                entrada.lastError = {
                    horario: new Date().toISOString(),
                    code: codigo,
                    message: erro.message,
                    blocking: erro.blocking === true,
                    status: erro.status ?? null
                };
                entrada.status = "DESATUALIZADO";
                // A confirmação deve exigir leituras válidas CONSECUTIVAS.
                entrada.pendingConfirmation = null;
                this.estado.products[produto.asin] = entrada;
                const falha = {
                    tipo: "FALHA_COLETA", ciclo: numero, asin: produto.asin,
                    ...entrada.lastError
                };
                observacoes.push(falha);
                problemas.push(falha);
                if (erro.blocking) {
                    this.parar("BLOQUEIO_OU_DESAFIO_DE_ACESSO");
                }
                continue;
            }

            completados++;
            const { dados, snapshot } = resultado.valor;
            const anteriorConfirmado = entrada.confirmedSnapshot ?? entrada.snapshot ?? null;
            const assinaturaAtual = assinaturaRelevante(snapshot);
            const assinaturaConfirmada = assinaturaRelevante(anteriorConfirmado);
            let mudancas = [];

            if (!anteriorConfirmado) {
                // Primeira coleta: preserva alertas de alvo e revisão da v0.2.
                mudancas = gerarMudancas(null, snapshot);
                entrada.confirmedSnapshot = snapshot;
                entrada.pendingConfirmation = null;
            } else if (assinaturaAtual === assinaturaConfirmada) {
                entrada.confirmedSnapshot = snapshot;
                entrada.pendingConfirmation = null;
            } else {
                const pendente = entrada.pendingConfirmation;
                const quantidade = pendente?.signature === assinaturaAtual
                    ? pendente.count + 1 : 1;
                entrada.pendingConfirmation = {
                    signature: assinaturaAtual,
                    count: quantidade,
                    firstSeenAt: pendente?.signature === assinaturaAtual
                        ? pendente.firstSeenAt : snapshot.horario
                };
                if (quantidade >= confirmacoesNecessarias) {
                    mudancas = gerarMudancas(anteriorConfirmado, snapshot);
                    entrada.confirmedSnapshot = snapshot;
                    entrada.pendingConfirmation = null;
                } else {
                    const possiveisMudancas = gerarMudancas(anteriorConfirmado, snapshot);
                    if (possiveisMudancas.length) {
                        candidatos.push({
                            asin: produto.asin,
                            nome: produto.name,
                            horario: snapshot.horario,
                            observacoes: quantidade,
                            necessarias: confirmacoesNecessarias,
                            tipos: possiveisMudancas.map(m => m.tipo),
                            executavel: false
                        });
                    }
                }
            }
            observacoes.push(resumoObservacao(snapshot, numero, dados));
            for (const mudanca of mudancas) {
                novosEventos.push(criarEvento(snapshot, mudanca, numero,
                    new Date().toISOString(), this.runId));
            }
            entrada.snapshot = snapshot; // Sempre a observação MAIS RECENTE.
            entrada.consecutiveFailures = 0;
            entrada.lastError = null;
            entrada.status = "ATUALIZADO";
            this.estado.products[produto.asin] = entrada;
            snapshots.push({ snapshot, dados });
        }

        this.estado.updatedAt = new Date().toISOString();
        this.estado.outbox.push(...novosEventos);
        await this.store.salvar(this.estado);
        const publicados = await this.store.publicarPendentes(this.estado);
        for (const registro of observacoes) await this.store.observar(registro);

        for (const falha of problemas) this.emit("problem", falha);
        for (const evento of publicados) this.emit("event", evento);
        for (const candidato of candidatos) this.emit("candidate", candidato);
        for (const { snapshot, dados } of snapshots) {
            adicionarAmostra(this.metricas.latencias, dados.duracaoMs ?? 0);
            this.metricas.bytes += dados.bytesRecebidos ?? 0;
            this.emit("snapshot", snapshot);
        }
        this.metricas.sucesso += completados;
        this.metricas.falhas += falhas;
        this.metricas.eventos += publicados.length;

        const duracaoMs = Math.round(this.clock() - inicio);
        adicionarAmostra(this.metricas.duracoes, duracaoMs);
        this.metricas.maiorCicloMs = Math.max(this.metricas.maiorCicloMs ?? 0, duracaoMs);
        this.metricas.ciclos++;
        const resumo = {
            tipo: "CICLO", ciclo: numero, produtos: produtos.length,
            sucesso: completados, falhas, eventos: publicados.length, duracaoMs,
            lento: duracaoMs > this.config.intervalSeconds * 1000,
            pendenciasConfirmacao: candidatos.length
        };
        this.emit("cycle", resumo);
        return resumo;
    }

    async executar({ seconds = 600 } = {}) {
        if (seconds !== Infinity &&
            (!Number.isInteger(seconds) || seconds < 10 || seconds > LIMITE_DURACAO_SEGUNDOS)) {
            throw new Error("seconds deve ficar entre 10 e 604800 (7 dias) ou ser Infinity");
        }
        if (this.rodando) throw new Error("Monitor já está em execução");
        await this.preparar();
        const produtosAtivos = this.config.products.filter(p => p.enabled);
        if (!produtosAtivos.length) throw new Error("Nenhum produto habilitado");
        const intervaloMs = this.config.intervalSeconds * 1000;
        const inicio = this.clock();
        const fim = seconds === Infinity ? Infinity : inicio + seconds * 1000;
        this.rodando = true;
        this.motivoParada = null;
        this.emit("status", { status: "RODANDO", produtos: produtosAtivos.length });
        let ciclo = 0;
        let slot = 0;

        while (this.rodando) {
            const previsto = inicio + slot * intervaloMs;
            if (previsto >= fim) break;
            const faltam = previsto - this.clock();
            if (faltam > 0) await this.sleep(faltam);
            if (!this.rodando) break;

            // Se o processo acordou atrasado, pula slots vencidos, sem rajadas.
            const agora = this.clock();
            if (agora - previsto > 1000) {
                const novoSlot = calcularProximoSlot(inicio, agora, intervaloMs, slot + 1);
                const pulados = novoSlot - slot;
                this.metricas.ciclosPulados += pulados;
                this.metricas.maiorAtrasoSlotPuladoMs = Math.max(
                    this.metricas.maiorAtrasoSlotPuladoMs, Math.round(agora - previsto));
                this.emit("schedule", { tipo: "SLOTS_PULADOS", pulados,
                    cicloAnterior: ciclo, atrasoMs: Math.round(agora - previsto) });
                slot = novoSlot;
                continue;
            }

            const atrasoMs = Math.max(0, Math.round(agora - previsto));
            this.metricas.maiorAtrasoMs = Math.max(this.metricas.maiorAtrasoMs, atrasoMs);
            ciclo++;
            const resultado = await this.ciclo(ciclo);
            if (resultado.lento) {
                this.metricas.ciclosLentos++;
                this.emit("schedule", { tipo: "CICLO_LENTO", ciclo,
                    duracaoMs: resultado.duracaoMs, intervaloMs });
                // Não para o serviço por uma demora isolada.
            }
            const proximo = slot + 1;
            const novoSlot = calcularProximoSlot(inicio, this.clock(), intervaloMs, proximo);
            if (novoSlot > proximo) {
                const pulados = novoSlot - proximo;
                this.metricas.ciclosPulados += pulados;
                const atrasoMs = Math.max(0,
                    Math.round(this.clock() - (inicio + proximo * intervaloMs)));
                this.metricas.maiorAtrasoSlotPuladoMs = Math.max(
                    this.metricas.maiorAtrasoSlotPuladoMs, atrasoMs);
                this.emit("schedule", { tipo: "SLOTS_PULADOS", pulados,
                    cicloAnterior: ciclo, atrasoMs });
            }
            slot = novoSlot;
        }

        if (this.rodando && seconds !== Infinity) {
            const restante = fim - this.clock();
            if (restante > 0) await this.sleep(restante);
        }
        const concluido = this.rodando && seconds !== Infinity;
        this.rodando = false;
        this.emit("status", {
            status: concluido ? "CONCLUIDO" : "INTERROMPIDO",
            motivo: this.motivoParada
        });
        const resumo = this.resumo();
        if (typeof this.store.tamanhosArquivos === "function") {
            resumo.arquivosBytes = await this.store.tamanhosArquivos();
        }
        return { concluido, motivo: this.motivoParada, ...resumo };
    }

    resumo() {
        const m = this.metricas;
        return {
            ...m,
            // Arrays de no máximo 1024 amostras: não são o histórico total.
            janelaMetricas: `ULTIMAS_${LIMITE_JANELA_METRICAS}`,
            latenciaP50ms: percentil(m.latencias, 0.5),
            latenciaP95ms: percentil(m.latencias, 0.95),
            amostrasLatenciaNaJanela: m.latencias.length,
            amostrasCicloNaJanela: m.duracoes.length,
            maiorCicloMs: m.maiorCicloMs,
            dadosRecebidosMB: +(m.bytes / (1024 * 1024)).toFixed(2),
            memoriaRssMB: +(process.memoryUsage().rss / (1024 * 1024)).toFixed(2)
        };
    }
}
