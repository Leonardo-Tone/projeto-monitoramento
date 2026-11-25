// Extracted from teste-ml-persistente-v3.mjs; originals remain unchanged.
// Adaptations: per-product seller identity, delivery/reputation fields and sanitized diagnostics.
import { isMlBrowserWall, isTrustedMlPage, sameMlDestination, waitForMlBrowserWall } from './ml-verification.mjs';
import { inspectPurchasePage } from './purchase-dom.mjs';

const TIMEOUT_MS=20000;
const quietLog=()=>{};
const captchaMarkup=html=>/<(?:iframe|div)\b[^>]*(?:g-recaptcha|h-captcha|src=["'][^"']*(?:recaptcha|hcaptcha))/i.test(html??'');
function origemDe(url) {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function exigeVerificacao(url) {
    if (!url) return false;

    try {
        const caminho = new URL(url).pathname.toLowerCase();

        return (
            caminho.includes("account-verification") ||
            caminho.includes("captcha") ||
            caminho.includes("challenge")
        );
    } catch {
        return false;
    }
}

async function navegarML(page,url,signal) {
    let lastResponse,enteredWall;
    const wallEntered=new Promise(resolve=>{enteredWall=resolve;});
    const track=response=>{
        const request=response.request();
        if(request.isNavigationRequest()&&request.frame()===page.mainFrame()){
            lastResponse=response;
            if(isMlBrowserWall(response.url()))enteredWall({wall:true});
        }
    };
    page.on('response',track);
    try {
        const navigation=page.goto(url,{waitUntil:'domcontentloaded',timeout:TIMEOUT_MS}).then(response=>({response}),error=>({error}));
        const outcome=await Promise.race([navigation,wallEntered]);
        signal?.throwIfAborted();
        if(!outcome.wall&&!isMlBrowserWall(page.url())) {
            if(outcome.error)throw outcome.error;
            return outcome.response?.status()??null;
        }
        const result=await waitForMlBrowserWall(async()=>{
            const current=page.url();
            if(!isTrustedMlPage(current))return {kind:'LOADING'};
            let state;
            try{state=await inspectPurchasePage(page);}
            catch(error){if(page.isClosed())throw error;return {kind:'LOADING'};}
            if(current!==page.url())return {kind:'LOADING'};
            if(state.challengeVisible)return {kind:'CAPTCHA'};
            if(isMlBrowserWall(current))return {kind:'WALL'};
            return {kind:state.loaded&&sameMlDestination(current,url)&&lastResponse?.url().split('#')[0]===current.split('#')[0]?'READY':'LOADING'};
        },{signal});
        if(result.kind==='CAPTCHA')throw new Error('CAPTCHA no Mercado Livre. Resolva a verificação no perfil de monitoramento.');
        if(result.kind==='WALL_TIMEOUT')throw new Error('O Mercado Livre não retornou ao endereço esperado após 15 segundos de verificação.');
        return lastResponse.status();
    } finally {page.off('response',track);}
}

function extrairEstado(html) {
    const match = html.match(
        /<script\b(?=[^>]*\bid=["']__NORDIC_RENDERING_CTX__["'])[^>]*>([\s\S]*?)<\/script\s*>/i
    );

    if (!match) {
        throw new Error("NORDIC_RENDERING_CTX ausente");
    }

    const script = match[1];

    const inicio = /_n\.ctx\.r\s*=\s*\{/.exec(script);

    if (!inicio) {
        throw new Error("Objeto Nordic nao encontrado");
    }

    const posicaoInicial = script.indexOf(
        "{",
        inicio.index
    );

    let nivel = 0;
    let dentroString = false;
    let escapado = false;
    let fim = -1;

    for (let i = posicaoInicial; i < script.length; i++) {
        const c = script[i];

        if (dentroString) {
            if (escapado) {
                escapado = false;
            } else if (c === "\\") {
                escapado = true;
            } else if (c === '"') {
                dentroString = false;
            }

            continue;
        }

        if (c === '"') {
            dentroString = true;
        } else if (c === "{") {
            nivel++;
        } else if (c === "}") {
            nivel--;

            if (nivel === 0) {
                fim = i + 1;
                break;
            }
        }
    }

    if (fim === -1) {
        throw new Error("JSON Nordic incompleto");
    }

    const dados = JSON.parse(
        script.slice(posicaoInicial, fim)
    );

    const estado = dados.appProps?.pageProps?.initialState;

    if (!estado) {
        throw new Error("initialState ausente");
    }

    const tracking =
        estado.track?.melidata_event?.event_data ??
        estado.components?.track?.melidata_event?.event_data ??
        {};

    const sellerData=estado.components?.seller_data;
    const sellerTracking=sellerData?.viewport_track?.melidata_event?.event_data;
    const summary=estado.components?.seller_summary;
    const summarySeller=summary?.seller;
    const sellerId=tracking.seller_id;
    const sameSeller=id=>sellerId!=null&&id!=null&&String(id)===String(sellerId);
    const header=sellerData?.components?.find(component=>component.id==='seller_header');
    const nameFromSummary=sameSeller(summarySeller?.id)?summarySeller?.name??summary?.seller_link?.label?.text:null;
    const nameFromHeader=sameSeller(sellerTracking?.seller_id)&&String(sellerTracking?.item_id)===String(tracking.item_id)?header?.title?.text??sellerTracking?.shop_name:null;
    const sellerName=[nameFromSummary,nameFromHeader].find(value=>typeof value==='string'&&value.trim());

    return {
        idPagina: estado.id ?? null,
        layout: estado.layout ?? null,
        idOferta: tracking.item_id ?? null,
        vendedor: tracking.seller_id ?? null,
        sellerName:sellerName?sellerName.replace(/\s+/g,' ').trim().slice(0,160):null,
        variationId:tracking.variation_id==null||tracking.variation_id==='not_apply'?null:String(tracking.variation_id),
        lojaOficial: tracking.official_store_id ?? null,
        status: tracking.item_status ?? null,
        hasStock: tracking.has_stock ?? null,
        quantidade: tracking.quantity ?? null,
        inativo: estado.no_active_item ?? null,
        preco: tracking.price ?? null,
        shippingMode: tracking.shipping_mode ?? null,
        logisticType: tracking.logistic_type ?? null,
        reputationLevel: tracking.reputation_level ?? estado.components?.seller_summary?.seller?.reputation_level ?? estado.components?.seller_data?.viewport_track?.melidata_event?.event_data?.reputation ?? null,
        powerSellerStatus: tracking.power_seller_status ?? estado.components?.seller_summary?.seller?.power_seller_status ?? null
    };
}

// ==================================================
// CLASSIFICACAO COM IDENTIDADE
// ==================================================

function classificar(produto, estado) {
    const idsPermitidos = [
        produto.id,
        produto.catalogo
    ].filter(Boolean);

    if (
        estado.idPagina == null ||
        !idsPermitidos.includes(String(estado.idPagina))
    ) {
        return "identity_mismatch";
    }

    if (estado.idOferta == null || estado.vendedor == null) {
        return "unknown_identity";
    }

    if (
        String(estado.idOferta) !== produto.id ||
        (produto.vendedorEsperado != null && String(estado.vendedor) !== String(produto.vendedorEsperado))
    ) {
        return "identity_mismatch";
    }

    if (
        estado.inativo === true ||
        (
            estado.status != null &&
            estado.status !== "active"
        ) ||
        estado.hasStock === false
    ) {
        return "unavailable";
    }

    if (estado.hasStock === true) {
        return "available";
    }

    return "unknown";
}

// ==================================================
// BOOTSTRAP DE UMA ABA
// ==================================================

async function prepararAba(
    browser,
    nome,
    url,
    origemEsperada,
    exigirNordic,
    signal
) {
    const page = await browser.newPage();

    const inicio = performance.now();

    try {
        const http = await navegarML(page,url,signal);
        if (exigirNordic && http === 200 && !exigeVerificacao(page.url())) {
            await page.waitForSelector("#__NORDIC_RENDERING_CTX__", {timeout: 5000}).catch(erro => {
                if (erro.name !== "TimeoutError") throw erro;
            });
        }
        const urlFinal = page.url();

        const temNordic = exigirNordic
            ? await page.evaluate(() =>
                Boolean(
                    document.querySelector(
                        "#__NORDIC_RENDERING_CTX__"
                    )
                )
            )
            : null;

        const verificacao = exigeVerificacao(urlFinal);
        const origemValida =
            origemDe(urlFinal) === origemEsperada;

        const pronto =
            http === 200 &&
            origemValida &&
            !verificacao &&
            (!exigirNordic || temNordic);

        const motivo = verificacao
            ? "verificacao_requerida"
            : !origemValida
                ? "origem_divergente"
                : http !== 200
                    ? "http_" + http
                    : exigirNordic && !temNordic
                        ? "nordic_ausente"
                        : "ok";

        const diagnostico = {http, urlFinal, pronto, motivo};

        const resultado = {
            page,
            nome,
            http,
            urlFinal,
            tempoMs: Math.round(
                performance.now() - inicio
            ),
            pronto,
            motivo,
            diagnostico
        };

        quietLog(
            `[BOOTSTRAP ${nome}]`,
            JSON.stringify({
                http,
                urlFinal,
                tempoMs: resultado.tempoMs,
                pronto,
                motivo,
                diagnostico
            })
        );

        return resultado;

    } catch (erro) {
        quietLog(
            `[BOOTSTRAP ${nome}]`,
            erro.message
        );

        return {
            page,
            nome,
            http: null,
            urlFinal: page.url(),
            pronto: false,
            motivo: "erro_bootstrap",
            erro: erro.message
        };
    }
}

// ==================================================
// CONSULTA TRADICIONAL - FETCH PARALELO
// ==================================================

async function consultarProduto(page, produto, {browser,signal}={}) {
    const inicio = performance.now();

    const resultado = await page.evaluate(
        async ({ url, timeoutMs }) => {
            const controller = new AbortController();

            const timer = setTimeout(
                () => controller.abort(),
                timeoutMs
            );

            const inicioFetch = performance.now();

            let etapa = "iniciando";
            let http = null;
            let urlFinal = null;

            try {
                if (new URL(url).origin !== location.origin) {
                    return {
                        erro: "origem_incorreta",
                        etapa: "validacao_origem"
                    };
                }

                etapa = "aguardando_resposta";

                const resposta = await fetch(url, {
                    method: "GET",
                    credentials: "same-origin",
                    redirect: "manual",
                    cache: "no-store",
                    signal: controller.signal
                });

                if(resposta.type==='opaqueredirect')return {navigationRequired:true};
                http = resposta.status;
                urlFinal = resposta.url;

                etapa = "lendo_html";

                const html = resposta.ok
                    ? await resposta.text()
                    : null;

                etapa = "concluido";

                return {
                    http,
                    urlFinal,
                    html,
                    etapa,
                    redirect: resposta.redirected,
                    tempoFetchMs: Math.round(
                        performance.now() - inicioFetch
                    )
                };

            } catch (erro) {
                return {
                    http,
                    urlFinal,
                    html: null,
                    etapa,
                    timeout: controller.signal.aborted,
                    erro: erro.name + ": " + erro.message,
                    tempoFetchMs: Math.round(
                        performance.now() - inicioFetch
                    )
                };

            } finally {
                clearTimeout(timer);
            }
        },
        {
            url: produto.url,
            timeoutMs: TIMEOUT_MS
        }
    );

    if(browser&&(resultado.navigationRequired||exigeVerificacao(resultado.urlFinal)||captchaMarkup(resultado.html)||/<title[^>]*>[^<]*(?:captcha|verifica|challenge)/i.test(resultado.html??''))){
        signal?.throwIfAborted();
        const navigationPage=await browser.newPage();
        try{return await consultarCatalogo(navigationPage,produto,{signal});}
        finally{await navigationPage.close();}
    }
    return {
        ...resultado,
        metodo: "fetch",
        tempoMs: Math.round(
            performance.now() - inicio
        )
    };
}

// ==================================================
// CONSULTA CATALOGO - NAVEGACAO SEQUENCIAL
// ==================================================

async function consultarCatalogo(page, produto, {signal}={}) {
    const inicio = performance.now();

    let etapa = "navegando";
    let http = null;
    let urlFinal = null;

    try {
        http = await navegarML(page,produto.url,signal);
        urlFinal = page.url();

        // Nao ler o HTML de paginas bloqueadas.
        if (
            http !== 200 ||
            exigeVerificacao(urlFinal)
        ) {
            return {
                metodo: "page.goto",
                http,
                urlFinal,
                etapa,
                html: null,
                tempoMs: Math.round(
                    performance.now() - inicio
                )
            };
        }

        etapa = "lendo_html";

        const html = await page.content();
        if(captchaMarkup(html)&&(await inspectPurchasePage(page)).challengeVisible)throw new Error('CAPTCHA no Mercado Livre. Resolva a verificação no perfil de monitoramento.');

        etapa = "concluido";

        return {
            metodo: "page.goto",
            http,
            urlFinal,
            etapa,
            html,
            tempoMs: Math.round(
                performance.now() - inicio
            )
        };

    } catch (erro) {
        return {
            metodo: "page.goto",
            http,
            urlFinal: page.url(),
            etapa,
            erro: erro.name + ": " + erro.message,
            timeout: erro.name === "TimeoutError",
            html: null,
            tempoMs: Math.round(
                performance.now() - inicio
            )
        };
    }
}


export { extrairEstado, classificar, prepararAba, consultarProduto, consultarCatalogo };
