import { performance } from "node:perf_hooks";
import { parseAodPrimeiraPagina } from "./parser.mjs";

export class AodError extends Error {
    constructor(message, { code = "UNKNOWN", status = null, blocking = false } = {}) {
        super(message);
        this.name = "AodError";
        this.code = code;
        this.status = status;
        this.blocking = blocking;
    }
}

export function urlAod(asin) {
    const url = new URL("https://www.amazon.com.br/gp/product/ajax/aodAjaxMain/");
    url.searchParams.set("asin", asin);
    return url.toString();
}

export async function consultarAod(asin, { timeoutMs = 12000, fetchImpl = fetch } = {}) {
    const inicio = performance.now();
    let resposta;
    let html;
    try {
        resposta = await fetchImpl(urlAod(asin), {
            headers: {
                Accept: "text/html, */*",
                "Accept-Language": "pt-BR,pt;q=0.9"
            },
            signal: AbortSignal.timeout(timeoutMs)
        });
        // Checar status antes de tentar analisar o conteúdo retornado.
        if (resposta.status !== 200) {
            const bloqueio = [403, 429, 503].includes(resposta.status);
            throw new AodError(`HTTP ${resposta.status} no ASIN ${asin}`, {
                code: "HTTP_STATUS",
                status: resposta.status,
                blocking: bloqueio
            });
        }
        html = await resposta.text();
    } catch (erro) {
        if (erro instanceof AodError) throw erro;
        throw new AodError(`Transporte falhou para ${asin}: ${erro.message}`, {
            code: erro.cause?.code ?? erro.code ?? erro.name ?? "FETCH_FAILED"
        });
    }

    if (/<title[^>]*>\s*robot check/i.test(html) ||
        /\/errors\/validateCaptcha/i.test(html) ||
        /id=["']captchacharacters["']/i.test(html)) {
        throw new AodError(`Desafio de acesso detectado em ${asin}`, {
            code: "CAPTCHA", blocking: true
        });
    }

    let resultado;
    try {
        resultado = parseAodPrimeiraPagina(html);
    } catch (erro) {
        throw new AodError(`HTML inválido para ${asin}: ${erro.message}`, {
            code: "INVALID_AOD_HTML"
        });
    }

    return {
        ...resultado,
        httpStatus: 200,
        duracaoMs: Math.round(performance.now() - inicio),
        bytesRecebidos: Buffer.byteLength(html)
    };
}
