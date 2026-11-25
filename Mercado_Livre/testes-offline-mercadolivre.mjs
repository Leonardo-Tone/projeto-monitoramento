/**
 * Testes offline do parser Mercado Livre.
 * Uso: node teste-offline-ml.mjs [caminho-moltres.html] [caminho-bota.html]
 * Sem dependencias de terceiros. Nao usa rede, cookies, CDP ou navegador.
 * NAO imprime nem persiste o HTML completo ou dados pessoais da sessao.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const pastaScript = dirname(fileURLToPath(import.meta.url));
const PADRAO = [
  join(pastaScript, 'moltres-MLB5214725509.html'),
  join(pastaScript, 'bota-MLB801319673.html')
];

function extrairJsonContexto(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('HTML vazio ou invalido');
  }

  const script = html.match(
    /<script\b(?=[^>]*\bid=["']__NORDIC_RENDERING_CTX__["'])[^>]*>([\s\S]*?)<\/script\s*>/i
  );
  if (!script) throw new Error('Script __NORDIC_RENDERING_CTX__ ausente');

  const texto = script[1];
  const marcador = /_n\.ctx\.r\s*=\s*/g;
  const local = marcador.exec(texto);
  if (!local) throw new Error('Atribuicao _n.ctx.r nao encontrada');

  const inicio = texto.indexOf('{', local.index + local[0].length);
  if (inicio === -1) throw new Error('JSON inicial nao encontrado');

  // Procura o fechamento do objeto JSON sem confundir chaves dentro de strings.
  let nivel = 0;
  let emString = false;
  let escapado = false;
  let fim = -1;

  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
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
      if (nivel === 0) {
        fim = i + 1;
        break;
      }
      if (nivel < 0) throw new Error('Chaves JSON desbalanceadas');
    }
  }
  if (fim < 0) throw new Error('JSON incompleto no estado inicial');

  try {
    return JSON.parse(texto.slice(inicio, fim));
  } catch {
    throw new Error('JSON do estado inicial invalido');
  }
}

function classificar(obs) {
  if (
    !['active', 'paused'].includes(obs.itemStatus) ||
    typeof obs.hasStock !== 'boolean' ||
    typeof obs.noActiveItem !== 'boolean' ||
    !Number.isInteger(obs.quantidadeIndicada) ||
    obs.quantidadeIndicada < 0
  ) return 'INDETERMINADO';

  if (
    obs.itemStatus === 'active' &&
    obs.hasStock === true &&
    obs.noActiveItem === false &&
    obs.quantidadeIndicada > 0
  ) return 'DISPONIVEL';

  if (
    obs.itemStatus === 'paused' &&
    obs.hasStock === false &&
    obs.noActiveItem === true &&
    obs.quantidadeIndicada === 0
  ) return 'INDISPONIVEL';

  return 'INCONSISTENTE';
}

function extrairObservacao(html, { idEsperado, vendedorEsperado } = {}) {
  const contexto = extrairJsonContexto(html);
  const estado = contexto?.appProps?.pageProps?.initialState;
  const evento = estado?.track?.melidata_event?.event_data;
  if (!estado || !evento) throw new Error('Estado do anuncio ou dados estruturados ausentes');

  if (!/^MLB\d+$/.test(estado.id ?? '')) {
    throw new Error('ID do anuncio ausente ou invalido');
  }
  if (evento.item_id !== estado.id) {
    throw new Error('ID do anuncio diverge entre estado e telemetria');
  }
  if (idEsperado && estado.id !== idEsperado) {
    throw new Error(`ID inesperado: ${estado.id}`);
  }
  if (vendedorEsperado && evento.seller_id !== vendedorEsperado) {
    throw new Error('Vendedor diferente do esperado');
  }

  const componentePreco = estado.components?.short_description?.find(
    c => c.id === 'price'
  );
  const componenteAcoes = estado.components?.short_description?.find(
    c => c.id === 'main_actions'
  );
  const acoesCompra = componenteAcoes?.actions ?? [];
  const schemaProduto = estado.schema?.find(c => c['@type'] === 'Product');
  const preco = evento.price;
  const precoTela = componentePreco?.price?.value;

  const obs = {
    itemId: estado.id,
    titulo: componentePreco ? contexto.title?.split(' | ')[0]?.trim() ?? null : null,
    itemStatus: evento.item_status ?? null,
    hasStock: evento.has_stock ?? null,
    noActiveItem: estado.no_active_item ?? null,
    quantidadeIndicada: evento.quantity ?? null,
    // Pode ser um limite da interface; NAO pressupor estoque fisico exato.
    precoCentavos: typeof preco === 'number' && Number.isFinite(preco)
      ? Math.round(preco * 100) : null,
    precoTelaCentavos: typeof precoTela === 'number' && Number.isFinite(precoTela)
      ? Math.round(precoTela * 100) : null,
    sellerId: evento.seller_id ?? null,
    officialStoreId: evento.official_store_id ?? null,
    hasVariations: evento.has_variations ?? null,
    botoesCompraDesabilitados: acoesCompra.length > 0
      ? acoesCompra.every(a => a.disabled === true) : null,
    jsonLdInStock: schemaProduto?.offers?.availability === 'https://schema.org/InStock',
    layout: estado.layout ?? null
  };
  obs.classificacao = classificar(obs);
  return obs;
}

function mesmaIdentidade(a, b) {
  return Boolean(
    a && b &&
    a.itemId === b.itemId &&
    Number.isInteger(a.sellerId) && a.sellerId === b.sellerId &&
    a.officialStoreId === b.officialStoreId
  );
}

function detectarCandidataReposicao(anterior, atual) {
  return mesmaIdentidade(anterior, atual) &&
    anterior.classificacao === 'INDISPONIVEL' &&
    atual.classificacao === 'DISPONIVEL';
}

function confirmarCandidataReposicao(anterior, primeira, segunda) {
  return detectarCandidataReposicao(anterior, primeira) &&
    mesmaIdentidade(primeira, segunda) &&
    segunda.classificacao === 'DISPONIVEL';
}

function formatarPreco(centavos) {
  return centavos == null ? 'N/D' :
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(centavos / 100);
}

const testes = [];
function teste(descricao, fn) {
  try {
    fn();
    testes.push({ descricao, resultado: 'PASSOU' });
    console.log(`  OK  ${descricao}`);
  } catch (e) {
    testes.push({ descricao, resultado: 'FALHOU' });
    console.error(`  FALHOU  ${descricao}: ${e.message}`);
  }
}

function executar() {
  if (process.argv.includes('--help')) {
    console.log('Uso: node teste-offline-ml.mjs [moltres.html] [bota.html]');
    return;
  }

  if (process.argv.length > 4) {
    throw new Error('Informe no maximo dois caminhos de HTML');
  }
  const caminhos = process.argv.slice(2);
  const [caminhoMoltres, caminhoBota] = caminhos.length === 0
    ? PADRAO : caminhos.length === 2 ? caminhos.map(x => resolve(x)) : (() => {
      throw new Error('Informe os dois HTMLs ou nenhum (ambos na pasta do script)');
    })();

  // Le somente arquivos locais; nao usa fetch nem outras chamadas de rede.
  const htmlMoltres = readFileSync(caminhoMoltres, 'utf8');
  const htmlBota = readFileSync(caminhoBota, 'utf8');
  const moltres = extrairObservacao(htmlMoltres, {
    idEsperado: 'MLB5214725509', vendedorEsperado: 768826009
  });
  const bota = extrairObservacao(htmlBota, {
    idEsperado: 'MLB801319673', vendedorEsperado: 170885659
  });

  console.log('\nOBSERVACOES EXTRAIDAS (apenas campos comerciais)');
  console.table([moltres, bota].map(o => ({
    anuncio: o.itemId,
    status: o.itemStatus,
    temEstoque: o.hasStock,
    inativo: o.noActiveItem,
    quantidadeIndicada: o.quantidadeIndicada,
    preco: formatarPreco(o.precoCentavos),
    vendedor: o.sellerId,
    lojaOficial: o.officialStoreId,
    classificacao: o.classificacao
  })));

  console.log('\nTESTES OFFLINE');
  teste('Moltres: identificador correto', () => assert.equal(moltres.itemId, 'MLB5214725509'));
  teste('Bota: identificador correto', () => assert.equal(bota.itemId, 'MLB801319673'));
  teste('Moltres: status pausado', () => assert.equal(moltres.itemStatus, 'paused'));
  teste('Bota: status ativo', () => assert.equal(bota.itemStatus, 'active'));
  teste('Moltres: estoque falso e inativo', () => {
    assert.equal(moltres.hasStock, false);
    assert.equal(moltres.noActiveItem, true);
  });
  teste('Bota: estoque verdadeiro e ativo', () => {
    assert.equal(bota.hasStock, true);
    assert.equal(bota.noActiveItem, false);
  });
  teste('Moltres: quantidade indicada zero', () => assert.equal(moltres.quantidadeIndicada, 0));
  teste('Bota: quantidade correta e nao o primeiro quantity:2', () => assert.equal(bota.quantidadeIndicada, 100));
  teste('Moltres: preco em centavos', () => assert.equal(moltres.precoCentavos, 7799));
  teste('Bota: preco em centavos', () => assert.equal(bota.precoCentavos, 44990));
  teste('Precos do estado e da tela concordam', () => {
    assert.equal(moltres.precoCentavos, moltres.precoTelaCentavos);
    assert.equal(bota.precoCentavos, bota.precoTelaCentavos);
  });
  teste('Vendedores e lojas oficiais diferentes', () => {
    assert.equal(moltres.officialStoreId, 236642);
    assert.equal(bota.officialStoreId, 701);
    assert.notEqual(moltres.sellerId, bota.sellerId);
  });
  teste('Moltres: INDISPONIVEL', () => assert.equal(moltres.classificacao, 'INDISPONIVEL'));
  teste('Bota: DISPONIVEL', () => assert.equal(bota.classificacao, 'DISPONIVEL'));
  teste('InStock do JSON-LD nao gera falso positivo para Moltres', () => {
    assert.equal(moltres.jsonLdInStock, true);
    assert.equal(moltres.classificacao, 'INDISPONIVEL');
  });
  teste('Bota com variacoes e botoes desabilitados segue disponivel', () => {
    assert.equal(bota.hasVariations, true);
    assert.equal(bota.botoesCompraDesabilitados, true);
    assert.equal(bota.classificacao, 'DISPONIVEL');
  });
  teste('Nao aceita HTML vazio', () => assert.throws(() => extrairObservacao(''), /HTML vazio/));
  teste('Nao aceita HTML sem estado inicial', () => assert.throws(() =>
    extrairObservacao('<html><body>"item_status":"active"</body></html>'), /ausente/));
  teste('Nao aceita JSON truncado', () => assert.throws(() => {
    const conteudo = '<script id="__NORDIC_RENDERING_CTX__">_n.ctx.r={"abc":1</script>';
    extrairObservacao(conteudo);
  }, /incompleto/));
  teste('Recusa ID esperado errado', () => assert.throws(() =>
    extrairObservacao(htmlMoltres, { idEsperado: 'MLB1234567890' }), /inesperado/));
  teste('Recusa vendedor esperado errado', () => assert.throws(() =>
    extrairObservacao(htmlBota, { vendedorEsperado: 768826009 }), /Vendedor diferente/));
  teste('Ativo sem estoque marcado: INCONSISTENTE', () => assert.equal(
    classificar({ ...bota, hasStock: false }), 'INCONSISTENTE'));
  teste('Pausado com estoque marcado: INCONSISTENTE', () => assert.equal(
    classificar({ ...moltres, hasStock: true }), 'INCONSISTENTE'));
  teste('Ativo com no_active_item=true: INCONSISTENTE', () => assert.equal(
    classificar({ ...bota, noActiveItem: true }), 'INCONSISTENTE'));
  teste('Ativo com quantidade zero: INCONSISTENTE', () => assert.equal(
    classificar({ ...bota, quantidadeIndicada: 0 }), 'INCONSISTENTE'));
  teste('Campo de estoque ausente: INDETERMINADO', () => assert.equal(
    classificar({ ...bota, hasStock: null }), 'INDETERMINADO'));
  teste('Status desconhecido: INDETERMINADO', () => assert.equal(
    classificar({ ...bota, itemStatus: 'unknown' }), 'INDETERMINADO'));
  teste('Dois produtos diferentes nao representam reposicao', () => assert.equal(
    detectarCandidataReposicao(moltres, bota), false));
  const simuladaAtiva = { ...moltres, itemStatus: 'active', hasStock: true,
    noActiveItem: false, quantidadeIndicada: 5, classificacao: 'DISPONIVEL' };
  teste('Simulacao: indisponivel -> disponivel gera candidata', () => assert.equal(
    detectarCandidataReposicao(moltres, simuladaAtiva), true));
  teste('Simulacao: dois resultados disponiveis confirmam candidata', () => assert.equal(
    confirmarCandidataReposicao(moltres, simuladaAtiva, { ...simuladaAtiva }), true));
  teste('Nao gera nova candidata com disponivel -> disponivel', () => assert.equal(
    detectarCandidataReposicao(simuladaAtiva, { ...simuladaAtiva }), false));
  teste('Nao confirma se vendedor mudou', () => assert.equal(
    confirmarCandidataReposicao(moltres, simuladaAtiva, { ...simuladaAtiva, sellerId: 123 }), false));
  teste('Nao confirma se segunda observacao for indeterminada', () => assert.equal(
    confirmarCandidataReposicao(moltres, simuladaAtiva, { ...simuladaAtiva, classificacao: 'INDETERMINADO' }), false));
  teste('Observacoes nao incluem identificadores privados de sessao', () => {
    const saida = JSON.stringify([moltres, bota]);
    assert.equal(/buyerEmail|buyerId|csrfToken|session-id|d2id|secure_us/i.test(saida), false);
  });

  const falhas = testes.filter(t => t.resultado === 'FALHOU');
  console.log(`\nRESULTADO: ${testes.length - falhas.length}/${testes.length} testes aprovados`);
  if (falhas.length) process.exitCode = 1;
  else console.log('Nenhum acesso a rede. Nenhum HTML bruto foi gravado ou exibido.');
}

try {
  executar();
} catch (e) {
  console.error('ERRO:', e.message);
  process.exitCode = 1;
}
