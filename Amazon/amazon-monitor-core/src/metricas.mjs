/** Estatísticas com memória limitada para sessões longas de monitoramento. */
export const LIMITE_JANELA_METRICAS = 1024;

export function adicionarAmostra(janela, valor, limite = LIMITE_JANELA_METRICAS) {
    if (!Number.isFinite(valor) || valor < 0) return;
    janela.push(valor);
    if (janela.length > limite) janela.splice(0, janela.length - limite);
}

export function percentil(janela, fracao) {
    if (!janela.length) return null;
    const ordenados = [...janela].sort((a, b) => a - b);
    return Math.round(ordenados[Math.max(0, Math.ceil(ordenados.length * fracao) - 1)]);
}

export function criarMetricas() {
    return {
        ciclos: 0,
        sucesso: 0,
        falhas: 0,
        eventos: 0,
        requisicoesTentadas: 0,
        duracoes: [],
        latencias: [],
        bytes: 0,
        maiorAtrasoMs: 0,
        maiorAtrasoSlotPuladoMs: 0,
        maiorCicloMs: null,
        ciclosLentos: 0,
        ciclosPulados: 0,
        falhasPorCodigo: {}
    };
}

export function assinaturaRelevante(snapshot) {
    if (!snapshot) return null;
    const melhores = snapshot.melhoresVisiveis ?? {};
    // Somente campos que determinam eventos no domínio; NÃO incluir offerHash,
    // quantidade máxima nem dados transitórios do HTML.
    return JSON.stringify({
        total: snapshot.totalInformado ?? null,
        amazon: Boolean(snapshot.amazonDiretaVisivel),
        precoAmazon: snapshot.amazonDireta?.precoNormalCentavos ?? null,
        terceiroFba: melhores.TERCEIRO_ENVIO_AMAZON?.precoNormalCentavos ?? null,
        terceiroProprio: melhores.TERCEIRO_ENVIO_PROPRIO?.precoNormalCentavos ?? null,
        alvo: Boolean(snapshot.alvo?.atingido),
        desconhecidos: snapshot.contagem?.DESCONHECIDA ?? 0
    });
}
