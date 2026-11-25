// Mercado Livre: coleta por origem, ate 3 requisicoes simultaneas.
// Execute este MESMO script uma vez em produto.mercadolivre.com.br
// e outra vez em www.mercadolivre.com.br. Cada execucao gera seu ZIP.
(async () => {
  'use strict';

  const CONFIG = {
    concorrencia: 3,
    timeoutMs: 25000,
    vendedorEsperado: '768826009',
    lotes: {
      'https://produto.mercadolivre.com.br': [
        ['MLB5214725509', 'Moltres_Mini', 'https://produto.mercadolivre.com.br/MLB-5214725509-_JM'],
        ['MLB5214725529', 'Night', 'https://produto.mercadolivre.com.br/MLB-5214725529-_JM'],
        ['MLB5214725539', 'Nigh_Pika', 'https://produto.mercadolivre.com.br/MLB-5214725539-_JM'],
        ['MLB5214725541', 'Mini_5541', 'https://produto.mercadolivre.com.br/MLB-5214725541-_JM'],
        ['MLB5214725543', 'Mini_5543', 'https://produto.mercadolivre.com.br/MLB-5214725543-_JM'],
        ['MLB5214725553', 'Espeon', 'https://produto.mercadolivre.com.br/MLB-5214725553-_JM'],
        ['MLB5214725555', 'Produto_5555', 'https://produto.mercadolivre.com.br/MLB-5214725555-_JM']
      ],
      'https://www.mercadolivre.com.br': [
        ['MLB5214725545', 'Greninja_Night_Catalogo', 'https://www.mercadolivre.com.br/pokemon-tcg-30th-mini-tin-greninja-night-ingles/p/MLB2123122684?pdp_filters=item_id%3AMLB5483907791'],
        ['MLB5276063543', 'Pitch_Black_Catalogo', 'https://www.mercadolivre.com.br/pokemontcg-megaevolution-pitch-black-booster-bundle-ingles/p/MLB76489730?pdp_filters=item_id%3AMLB5276063543'],
        ['MLB6823331442', 'Toxel_Catalogo', 'https://www.mercadolivre.com.br/pokemon-me04-caos-ascendente-blister-quadruplo-toxel-4-boosters-copag/p/MLB69735015?pdp_filters=item_id%3AMLB6823331442']
      ]
    }
  };

  const origem = location.origin;
  const itens = CONFIG.lotes[origem];
  if (!itens) {
    console.error('Abra uma pagina em produto.mercadolivre.com.br ou www.mercadolivre.com.br.');
    return;
  }

  const encoder = new TextEncoder();
  const arquivos = new Array(itens.length).fill(null);
  const relatorio = new Array(itens.length).fill(null);
  let proximo = 0;
  let restricao = null;
  const inicioLote = performance.now();

  function extrairEstado(html, idSolicitado) {
    const match = html.match(/<script\b(?=[^>]*\bid=["']__NORDIC_RENDERING_CTX__["'])[^>]*>([\s\S]*?)<\/script\s*>/i);
    if (!match) return { parser: 'sem_script_nordic', disponibilidade: 'unknown' };

    const codigo = match[1];
    const atribuicao = /\b_n\.ctx\.r\s*=\s*/.exec(codigo);
    if (!atribuicao) return { parser: 'sem_atribuicao_nordic', disponibilidade: 'unknown' };
    let inicio = atribuicao.index + atribuicao[0].length;
    while (/\s/.test(codigo[inicio] || '') && inicio < codigo.length) inicio++;
    if (codigo[inicio] !== '{') return { parser: 'json_nordic_inesperado', disponibilidade: 'unknown' };

    let profundidade = 0, emString = false, escapado = false, fim = -1;
    for (let i = inicio; i < codigo.length; i++) {
      const c = codigo[i];
      if (emString) {
        if (escapado) escapado = false;
        else if (c === '\\') escapado = true;
        else if (c === '"') emString = false;
      } else if (c === '"') emString = true;
      else if (c === '{') profundidade++;
      else if (c === '}' && --profundidade === 0) { fim = i + 1; break; }
    }
    if (fim < 0) return { parser: 'json_nordic_incompleto', disponibilidade: 'unknown' };

    try {
      const dados = JSON.parse(codigo.slice(inicio, fim));
      const estado = dados.appProps?.pageProps?.initialState;
      if (!estado?.id) return { parser: 'estado_nao_identificado', disponibilidade: 'unknown' };

      // Os dois layouts possuem caminhos internos diferentes.
      const evento = estado.track?.melidata_event?.event_data
        ?? estado.components?.track?.melidata_event?.event_data
        ?? {};
      const idOferta = evento.item_id ?? (estado.layout === 'pdp' ? null : estado.id);
      const vendedor = evento.seller_id ?? null;
      const status = evento.item_status ?? null;
      const temEstoque = evento.has_stock ?? null;
      const inativo = estado.no_active_item ?? null;
      const identidade = !idOferta || vendedor == null ? 'unknown'
        : idOferta !== idSolicitado ? 'identity_mismatch'
        : String(vendedor) !== CONFIG.vendedorEsperado ? 'seller_mismatch' : 'ok';

      let disponibilidade = 'unknown';
      if (identidade !== 'ok') disponibilidade = 'unknown';
      else if (status === 'paused' || (status && status !== 'active') || inativo === true || temEstoque === false) {
        disponibilidade = 'unavailable';
      } else if (temEstoque === true && inativo !== true && (status === 'active' || (estado.layout === 'pdp' && status == null))) {
        disponibilidade = 'available';
      }

      return {
        parser: 'ok', layout: estado.layout ?? null,
        idPagina: estado.id, idOferta,
        identidade, disponibilidade,
        status, hasStock: temEstoque, noActiveItem: inativo,
        quantityHint: evento.quantity ?? null,
        preco: evento.price ?? null,
        vendedor, lojaOficial: evento.official_store_id ?? null
      };
    } catch (e) {
      return { parser: 'json_invalido', detalhe: String(e.message), disponibilidade: 'unknown' };
    }
  }

  // Gerador ZIP sem dependencias (arquivos sem compressao).
  function criarZip(entradas) {
    const tabela = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xEDB88320 : 0);
      tabela[n] = c >>> 0;
    }
    function crc32(bytes) {
      let c = 0xFFFFFFFF;
      for (const b of bytes) c = tabela[(c ^ b) & 255] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }
    const locais = [], diretorio = [];
    let offset = 0, tamanhoDiretorio = 0;
    const agora = new Date();
    const data = ((Math.max(1980, agora.getFullYear()) - 1980) << 9)
      | ((agora.getMonth() + 1) << 5) | agora.getDate();
    const hora = (agora.getHours() << 11)
      | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);

    for (const entrada of entradas) {
      const nome = encoder.encode(entrada.nome);
      const bytes = encoder.encode(entrada.conteudo);
      const crc = crc32(bytes);
      const local = new Uint8Array(30 + nome.length);
      const l = new DataView(local.buffer);
      l.setUint32(0, 0x04034b50, true);
      l.setUint16(4, 20, true);
      l.setUint16(6, 0x0800, true);
      l.setUint16(10, 0, true);
      l.setUint16(12, hora, true);
      l.setUint32(14, crc, true);
      l.setUint32(18, bytes.length, true);
      l.setUint32(22, bytes.length, true);
      l.setUint16(26, nome.length, true);
      local.set(nome, 30);
      locais.push(local, bytes);

      const central = new Uint8Array(46 + nome.length);
      const d = new DataView(central.buffer);
      d.setUint32(0, 0x02014b50, true);
      d.setUint16(4, 20, true);
      d.setUint16(6, 20, true);
      d.setUint16(8, 0x0800, true);
      d.setUint16(12, hora, true);
      d.setUint16(14, data, true);
      d.setUint32(16, crc, true);
      d.setUint32(20, bytes.length, true);
      d.setUint32(24, bytes.length, true);
      d.setUint16(28, nome.length, true);
      d.setUint32(42, offset, true);
      central.set(nome, 46);
      diretorio.push(central);
      offset += local.length + bytes.length;
      tamanhoDiretorio += central.length;
    }

    const final = new Uint8Array(22);
    const f = new DataView(final.buffer);
    f.setUint32(0, 0x06054b50, true);
    f.setUint16(8, entradas.length, true);
    f.setUint16(10, entradas.length, true);
    f.setUint32(12, tamanhoDiretorio, true);
    f.setUint32(16, offset, true);
    return new Blob([...locais, ...diretorio, final], { type: 'application/zip' });
  }

  async function consultar(indice, trabalhador) {
    const [id, apelido, url] = itens[indice];
    const inicio = performance.now();
    console.log(`[${indice + 1}/${itens.length}] worker ${trabalhador} iniciou ${id}`);
    const controller = new AbortController();
    let expirou = false;
    const timeout = setTimeout(() => { expirou = true; controller.abort(); }, CONFIG.timeoutMs);
    try {
      if (new URL(url).origin !== origem) throw new Error('URL fora da origem autorizada');
      const resposta = await fetch(url, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        // Em /produto, evitar seguir redirecionamento para www (CORS).
        redirect: origem.includes('produto.') ? 'manual' : 'follow',
        signal: controller.signal
      });
      const tempoMs = Math.round(performance.now() - inicio);
      if (resposta.type === 'opaqueredirect' || (resposta.status >= 300 && resposta.status < 400)) {
        relatorio[indice] = { id, resultado: 'redirect_nao_seguido', http: resposta.status || null, tempoMs };
        console.warn(id, 'redirecionamento detectado: nenhuma tentativa de contornar CORS');
        return;
      }
      if (!resposta.ok) {
        relatorio[indice] = { id, resultado: 'falha_http', http: resposta.status, tempoMs };
        console.warn(id, 'HTTP', resposta.status);
        if ([401, 403, 429, 503].includes(resposta.status)) {
          restricao = { id, http: resposta.status };
          console.warn('Restricao detectada. Novas consultas serao suspensas.');
        }
        return;
      }

      const html = await resposta.text();
      const nomeArquivo = `${id}_${apelido}.html`;
      // HTML e salvo INDEPENDENTEMENTE do resultado do parser.
      arquivos[indice] = { nome: nomeArquivo, conteudo: html };
      const info = extrairEstado(html, id);
      relatorio[indice] = {
        id, resultado: 'html_salvo', http: resposta.status,
        tempoMs: Math.round(performance.now() - inicio),
        caracteres: html.length, arquivo: nomeArquivo,
        urlFinal: resposta.url, ...info
      };
      console.log(`${id}: salvo; parser=${info.parser}, identidade=${info.identidade ?? 'unknown'}, disponibilidade=${info.disponibilidade}`);
      if (info.identidade === 'identity_mismatch' || info.identidade === 'seller_mismatch') {
        console.warn(id, 'Nao considerar como reposicao do anuncio original.');
      }
      if (info.parser !== 'ok') {
        restricao = restricao || { id, motivo: 'resposta_sem_estado_valido' };
        console.warn('Parser sem estado valido. Suspensas novas consultas; HTML preservado para analise.');
      }
    } catch (erro) {
      relatorio[indice] = {
        id, resultado: expirou ? 'timeout' : 'erro_rede_ou_cors',
        detalhe: String(erro.message), tempoMs: Math.round(performance.now() - inicio)
      };
      console.warn(id, erro.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function trabalhador(numero) {
    while (!restricao && proximo < itens.length) {
      // Reserva um indice de forma sincrona, antes do primeiro await.
      const indice = proximo++;
      await consultar(indice, numero);
    }
  }

  console.log('Iniciando lote:', origem, '| itens:', itens.length, '| concorrencia maxima:', CONFIG.concorrencia);
  const numeroTrabalhadores = Math.min(CONFIG.concorrencia, itens.length);
  await Promise.all(Array.from({ length: numeroTrabalhadores }, (_, i) => trabalhador(i + 1)));

  for (let i = 0; i < relatorio.length; i++) {
    if (!relatorio[i]) relatorio[i] = { id: itens[i][0], resultado: 'nao_executado_parada' };
  }
  const htmls = arquivos.filter(Boolean);
  const arquivoRelatorio = origem.includes('produto.') ? 'relatorio-produto.json' : 'relatorio-catalogo.json';
  const duracaoMs = Math.round(performance.now() - inicioLote);
  htmls.push({ nome: arquivoRelatorio, conteudo: JSON.stringify({
    origem, concorrencia: CONFIG.concorrencia, duracaoMs,
    iniciadoEm: new Date(Date.now() - duracaoMs).toISOString(),
    concluidoEm: new Date().toISOString(), solicitados: itens.length,
    htmlsSalvos: htmls.length, restricao, consultas: relatorio
  }, null, 2) });

  const blob = criarZip(htmls);
  const urlZip = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = urlZip;
  link.download = origem.includes('produto.') ? 'ml-lote-produto-paralelo3.zip' : 'ml-lote-catalogo-paralelo3.zip';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(urlZip), 30000);

  console.table(relatorio.map(r => ({
    id: r.id, http: r.http ?? '-', resultado: r.resultado,
    parser: r.parser ?? '-', identidade: r.identidade ?? '-',
    disponibilidade: r.disponibilidade ?? '-', tempoMs: r.tempoMs ?? '-'
  })));
  console.log(`Finalizado em ${duracaoMs} ms. HTMLs: ${arquivos.filter(Boolean).length}/${itens.length}; arquivo: ${link.download}`);
  if (restricao) console.warn('Lote interrompido:', restricao);
})();
