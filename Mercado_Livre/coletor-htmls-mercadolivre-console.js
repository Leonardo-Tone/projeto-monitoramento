// Cole todo este arquivo no Console (F12). Execute uma vez em cada origem.
(async () => {
  const lotes = {
    'https://produto.mercadolivre.com.br': [
      ['MLB5214725509', 'Moltres_Mini', 'https://produto.mercadolivre.com.br/MLB-5214725509-_JM'],
      ['MLB5214725529', 'Night', 'https://produto.mercadolivre.com.br/MLB-5214725529-_JM'],
      ['MLB5214725539', 'Mewtwo', 'https://produto.mercadolivre.com.br/MLB-5214725539-_JM'],
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
  };

  const itens = lotes[location.origin];
  if (!itens) {
    console.error('Abra uma página em produto.mercadolivre.com.br ou www.mercadolivre.com.br');
    return;
  }

  const pausa = ms => new Promise(resolve => setTimeout(resolve, ms));
  const encoder = new TextEncoder();

  function parsearEstado(html) {
    const match = html.match(/<script\b(?=[^>]*\bid=["']__NORDIC_RENDERING_CTX__["'])[^>]*>([\s\S]*?)<\/script\s*>/i);
    if (!match) return { parser: 'sem_script_nordic' };

    const codigo = match[1];
    const atribuicao = /\b_n\.ctx\.r\s*=\s*/.exec(codigo);
    if (!atribuicao) return { parser: 'sem_atribuicao_nordic' };

    const inicio = atribuicao.index + atribuicao[0].length;
    if (codigo[inicio] !== '{') return { parser: 'json_nordic_inesperado' };

    let nivel = 0;
    let emString = false;
    let escapado = false;
    let fim = -1;

    for (let i = inicio; i < codigo.length; i++) {
      const c = codigo[i];
      if (emString) {
        if (escapado) escapado = false;
        else if (c === '\\') escapado = true;
        else if (c === '"') emString = false;
      } else if (c === '"') {
        emString = true;
      } else if (c === '{') {
        nivel++;
      } else if (c === '}') {
        nivel--;
        if (nivel === 0) { fim = i + 1; break; }
      }
    }

    if (fim < 0) return { parser: 'json_nordic_incompleto' };

    try {
      const dados = JSON.parse(codigo.slice(inicio, fim));
      const estado = dados.appProps?.pageProps?.initialState;
      if (!estado?.id) return { parser: 'estado_nao_identificado' };
      const evento = estado.track?.melidata_event?.event_data ?? {};
      return {
        parser: 'ok',
        idEncontrado: estado.id,
        status: evento.item_status ?? null,
        hasStock: evento.has_stock ?? null,
        noActiveItem: estado.no_active_item ?? null,
        quantityHint: evento.quantity ?? null,
        preco: evento.price ?? null,
        vendedor: evento.seller_id ?? null
      };
    } catch (e) {
      return { parser: 'json_invalido', detalhe: e.message };
    }
  }

  // Cria ZIP padrão (sem compressão), diretamente no navegador.
  function criarZip(arquivos) {
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
    const local = [], central = [];
    let offset = 0, tamanhoCentral = 0;
    const agora = new Date();
    const ano = Math.max(1980, agora.getFullYear());
    const data = ((ano - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();
    const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | (agora.getSeconds() >> 1);

    for (const arquivo of arquivos) {
      const nome = encoder.encode(arquivo.nome);
      const bytes = encoder.encode(arquivo.conteudo);
      const crc = crc32(bytes);
      const cab = new Uint8Array(30 + nome.length);
      const l = new DataView(cab.buffer);
      l.setUint32(0, 0x04034b50, true);
      l.setUint16(4, 20, true);
      l.setUint16(6, 0x0800, true); // Nome UTF-8
      l.setUint16(10, hora, true);
      l.setUint16(12, data, true);
      l.setUint32(14, crc, true);
      l.setUint32(18, bytes.length, true);
      l.setUint32(22, bytes.length, true);
      l.setUint16(26, nome.length, true);
      cab.set(nome, 30);
      local.push(cab, bytes);

      const dir = new Uint8Array(46 + nome.length);
      const d = new DataView(dir.buffer);
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
      dir.set(nome, 46);
      central.push(dir);
      offset += cab.length + bytes.length;
      tamanhoCentral += dir.length;
    }
    const fim = new Uint8Array(22);
    const e = new DataView(fim.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, arquivos.length, true);
    e.setUint16(10, arquivos.length, true);
    e.setUint32(12, tamanhoCentral, true);
    e.setUint32(16, offset, true);
    return new Blob([...local, ...central, fim], { type: 'application/zip' });
  }

  const arquivos = [];
  const relatorio = [];
  console.log('Origem:', location.origin, '| Consultas:', itens.length);

  for (let i = 0; i < itens.length; i++) {
    const [id, nome, url] = itens[i];
    const inicio = performance.now();
    let parar = false;
    console.log(`[${i + 1}/${itens.length}] ${id}`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let resposta;
      try {
        resposta = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal
        });
      } finally { clearTimeout(timeout); }

      const tempoMs = Math.round(performance.now() - inicio);
      if (!resposta.ok) {
        relatorio.push({ id, http: resposta.status, resultado: 'falha_http', tempoMs });
        console.warn(`${id}: HTTP ${resposta.status}`);
        if ([403, 429, 503].includes(resposta.status)) parar = true;
      } else {
        // A CAPTURA não depende do sucesso do PARSER.
        const html = await resposta.text();
        const arquivo = `${id}_${nome}.html`;
        arquivos.push({ nome: arquivo, conteudo: html });
        const info = parsearEstado(html);
        relatorio.push({ id, http: resposta.status, resultado: 'html_salvo',
          arquivo, caracteres: html.length, tempoMs, urlFinal: resposta.url, ...info });
        console.log(`${id}: HTML salvo (${html.length} caracteres); parser=${info.parser}`);
        if (info.idEncontrado && info.idEncontrado !== id) {
          console.warn(`${id}: ID no estado=${info.idEncontrado}; confira o redirecionamento!`);
        }
      }
    } catch (e) {
      relatorio.push({ id, resultado: 'erro_rede_ou_cors', detalhe: e.message,
        tempoMs: Math.round(performance.now() - inicio) });
      console.warn(`${id}: ${e.message}`);
    }
    if (parar) { console.warn('Bloqueio HTTP detectado; encerrando este lote.'); break; }
    if (i < itens.length - 1) await pausa(2000);
  }

  arquivos.push({ nome: location.origin.includes('produto.') ? 'relatorio-produto.json' : 'relatorio-catalogo.json', conteudo: JSON.stringify({
    origem: location.origin, geradoEm: new Date().toISOString(),
    htmls: arquivos.length, solicitados: itens.length, consultas: relatorio
  }, null, 2) });

  const zip = criarZip(arquivos);
  const link = document.createElement('a');
  const blobUrl = URL.createObjectURL(zip);
  link.href = blobUrl;
  link.download = location.origin.includes('produto.') ? 'ml-lote-produto.zip' : 'ml-lote-catalogo.zip';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  console.table(relatorio.map(({ id, http, resultado, parser, status, hasStock, quantityHint, tempoMs }) =>
    ({ id, http, resultado, parser, status, hasStock, quantityHint, tempoMs })));
  console.log('Finalizado:', arquivos.length - 1, 'HTML(s) solicitados para download:', link.download);
})();
