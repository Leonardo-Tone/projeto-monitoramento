import { resolve } from "node:path";
import { carregarConfig } from "./config.mjs";
import { FileStore } from "./store.mjs";
import { Monitor } from "./monitor.mjs";
import { consultarAod } from "./client.mjs";

function opcoes(args) {
    const resultado = {
        config: "config/products.json",
        data: "data",
        seconds: 600,
        interval: null,
        concurrency: null
    };
    for (let i = 0; i < args.length; i++) {
        const argumento = args[i];
        if (argumento === "--continuous") {
            resultado.seconds = Infinity;
        } else if (["--config", "--data", "--seconds", "--interval", "--concurrency"]
            .includes(argumento)) {
            if (!args[i + 1]) throw new Error(`Falta valor para ${argumento}`);
            const chave = argumento.slice(2);
            resultado[chave] = ["seconds", "interval", "concurrency"].includes(chave)
                ? Number(args[++i]) : args[++i];
        } else {
            throw new Error(`Opção desconhecida: ${argumento}`);
        }
    }
    return resultado;
}

let store;
try {
    const args = opcoes(process.argv.slice(2));
    const config = await carregarConfig(resolve(args.config));
    if (args.interval != null) config.intervalSeconds = args.interval;
    if (args.concurrency != null) config.maxConcurrency = args.concurrency;
    // Aplicar novamente validação quando há overrides da linha de comando.
    const { validarConfig } = await import("./config.mjs");
    validarConfig(config);
    store = new FileStore(resolve(args.data));
    const monitor = new Monitor({ config, store, consultar: consultarAod });

    let paradaSolicitada = false;
    process.on("SIGINT", () => {
        if (!paradaSolicitada) {
            paradaSolicitada = true;
            console.log("\nSIGINT: encerramento solicitado; aguardando ciclo em andamento.");
            monitor.parar("SIGINT");
        }
    });
    monitor.on("event", evento => {
        console.log(
            `[EVENTO] ${evento.tipo} | ${evento.asin} | ${evento.prioridade}`
        );
    });
    monitor.on("problem", problema => {
        console.error(
            `[FALHA] ${problema.asin}: ${problema.code} - ${problema.message}`
        );
    });
    monitor.on("schedule", aviso => {
        if (aviso.tipo === "CICLO_LENTO") {
            console.warn(`[AGENDADOR] Ciclo ${aviso.ciclo} demorou ${aviso.duracaoMs} ms; monitor continua.`);
        } else if (aviso.tipo === "SLOTS_PULADOS") {
            console.warn(`[AGENDADOR] ${aviso.pulados} horário(s) ignorado(s) para evitar rajada.`);
        }
    });
    monitor.on("candidate", candidato => {
        console.log(`[PENDENTE] ${candidato.asin} | ${candidato.tipos.join(", ")} | ` +
            `${candidato.observacoes}/${candidato.necessarias} observações`);
    });
    monitor.on("cycle", ciclo => {
        console.log(
            `Ciclo ${ciclo.ciclo}: ${ciclo.sucesso}/${ciclo.produtos} produtos, ` +
            `${ciclo.duracaoMs} ms, ${ciclo.eventos} eventos, ${ciclo.falhas} falhas`
        );
    });

    console.log("\nMONITOR AMAZON AOD — NÚCLEO (sem compra)");
    console.log(`Produtos ativos: ${config.products.filter(p => p.enabled).length}`);
    console.log(`Intervalo: ${config.intervalSeconds}s | Concorrência: ${config.maxConcurrency}`);
    console.log(`Duração: ${args.seconds === Infinity ? "CONTÍNUO" : args.seconds + "s"}`);
    console.log(`Dados: ${resolve(args.data)}`);
    const resultado = await monitor.executar({ seconds: args.seconds });
    console.log("\nRELATÓRIO:", JSON.stringify(resultado, null, 2));
    if (!resultado.concluido && resultado.motivo !== "SIGINT") process.exitCode = 1;
} catch (erro) {
    console.error("ERRO FATAL:", erro.stack ?? erro.message);
    process.exitCode = 1;
} finally {
    if (store) await store.fechar();
}
