# Monitor Amazon AOD — núcleo funcional experimental (v0.3)

Um serviço Node.js independente de interface que observa **somente a primeira página** de ofertas de 10 ASINs. O objetivo é produzir observações e eventos estruturados para um futuro aplicativo desenvolvido pelo Codex. **Não compra produtos, não adiciona itens a carrinhos, não gerencia filas de compra e não contorna desafios de acesso.**

## O que já está implementado

- Coleta da primeira página AOD por ASIN, incluindo oferta destacada quando existe.
- Classificação: `AMAZON_DIRETA`, `TERCEIRO_ENVIO_AMAZON`, `TERCEIRO_ENVIO_PROPRIO`, `DESCONHECIDA`, `REVISAR_MODALIDADE`.
- Dados: preço normal, preço exibido (pode depender da condição de pagamento), frete quando informado e limites `minQty`/`maxQty` do controle de compra. **`maxQty` não prova o estoque existente.**
- Regras por produto: categorias aceitas, preço máximo opcional e preço normal ou exibido; inclusão de frete opcional, com valor desconhecido tratado como desconhecido.
- Eventos de mudança de preço visível, de oferta direta Amazon, de contador AOD e de objetivo de preço.
- Histórico JSONL de observações, eventos JSONL e último estado em `state.json`.
- Recuperação do último estado após reinício (para evitar tratar o primeiro ciclo sempre como novidade).
- Parada em HTTP 403/429/503, CAPTCHA e após 3 falhas consecutivas por produto; sem retries automáticos.
- Sem overlap entre ciclos; timeout isolado **não encerra** o monitor. Ciclos longos e slots perdidos são registrados; nenhum horário perdido é recuperado por rajada.
- Mudanças de mercado exigem duas observações válidas consecutivas por padrão (`confirmationCycles: 2`); candidatos são emitidos separadamente, sem autorizar compra.
- Métricas de latência/duração mantidas em janela móvel de até 1.024 amostras, com máximos e totais cumulativos.
- Porta (`consultar`) injetável, e `EventEmitter` para uma futura UI ou serviço backend.
- Reprodução offline de logs legados `SNAPSHOT_PRIMEIRA_PAGINA` (nenhuma consulta HTTP).

## Requisitos e instalação — PowerShell

Node.js 20.18.1 ou mais recente (preferencialmente um Node.js LTS atual) e npm. Na pasta onde descompactou o ZIP:

```powershell
npm install
npm test
```

`npm install` baixa a dependência `cheerio` que o coletor anterior já utilizava. O código não depende de navegador, puppeteer, proxies ou contas Amazon.

## Execução

**Primeiro execute um teste curto**, respeitando as condições de acesso aplicáveis:

```powershell
npm run monitor -- --seconds 60
```

Rodada de dez minutos:

```powershell
npm run monitor -- --seconds 600
```

Intervalo e concorrência podem ser limitados via linha de comando:

```powershell
npm run monitor -- --seconds 600 --interval 20 --concurrency 3
```

Rodada de cem minutos, desde que o monitoramento respeite as condições de acesso do serviço:

```powershell
npm run monitor -- --seconds 6000
```

Modo contínuo, **somente após autorização e validações operacionais**:

```powershell
npm run monitor -- --continuous
```

`Ctrl+C` solicita parada após o ciclo corrente. O intervalo padrão é 10 s para dez produtos (até dez requisições HTTP simultâneas). Para reduzir carga, aumente `intervalSeconds` e/ou reduza `maxConcurrency`. Não execute múltiplas instâncias na mesma pasta de dados. Limite de tempo para rodadas finitas: 604.800 segundos (7 dias). Por exemplo, `npm run monitor -- --seconds 6000` executa uma rodada de 100 minutos, sem precisar usar `Infinity`.

## Configurar produtos e regras

Edite `config/products.json`. `confirmationCycles` (1 a 5; padrão 2) define quantas observações válidas consecutivas são exigidas para confirmar uma mudança; com `1`, recupera o comportamento imediato da v0.2. Enquanto o Codex não construir o cadastro na interface, essa é a configuração de entrada. **Não há hot reload**: reinicie o monitor após modificá-la.

Um produto tem esta estrutura:

```json
{
  "asin": "B0H3Q76WTZ",
  "name": "Pokemon Colecao Greninja",
  "enabled": true,
  "categories": ["AMAZON_DIRETA"],
  "target": {
    "maxPriceCents": 20000,
    "priceBasis": "NORMAL",
    "includeShipping": false,
    "minQuantity": 1
  }
}
```

Aqui o alerta de objetivo refere-se a **R$ 200,00 de preço normal do item**, e somente quando vendido e enviado pela Amazon. `maxPriceCents: null` desativa o objetivo de preço, mas mantém a detecção de mudanças. `priceBasis: "DISPLAYED"` consulta o outro campo de preço, que pode ter condições específicas; não trate necessariamente como preço disponível a qualquer forma de pagamento. Com `includeShipping: true`, frete desconhecido impede um alerta de objetivo.

A comparação é de ofertas **visíveis na primeira página**. Ausência não prova estoque esgotado e preço mínimo não prova mínimo global quando existe paginação.

## Dados persistidos

Depois de uma execução:

- `data/state.json`: último snapshot por ASIN, baseline confirmado (`confirmedSnapshot`), candidato (`pendingConfirmation`), contadores de falhas, status e `outbox` de eventos pendentes.
- `data/observations.jsonl`: resumo de cada observação, sem replicar todo o HTML.
- `data/events.jsonl`: apenas alterações relevantes e objetivos atingidos.
- `data/monitor.lock`: exclusão mútua para evitar dois escritores simultâneos; removido no encerramento normal.

Se o programa ou Windows encerrou abruptamente e `monitor.lock` permanecer, **primeiro confirme que não há nenhum monitor rodando**. Somente depois remova manualmente o arquivo para reiniciar. Não remova um lock de uma instância ainda ativa.

**Atenção:** o estado inclui outbox persistente e reconciliação de IDs; os arquivos separados **não formam uma transação ACID**. Antes de qualquer mecanismo de compra, migrar para uma base transacional com outbox e pagamentos idempotentes. O diretório `data` é local e não tem criptografia própria.

## Replay offline: comparar com o teste de 10 minutos

```powershell
npm run replay -- "C:\caminho\do\seu\aod-primeira-pagina-....jsonl"
```

Também há um pequeno exemplo sintético:

```powershell
npm run replay -- fixtures/replay-sintetico.jsonl
```

Os 600 snapshots reais fornecidos pelo usuário foram reproduzidos offline nesta elaboração: **600 snapshots/10 ASINs**, com 1 alteração de contador AOD (Casio, 36→37) e 2 avisos iniciais de vendedor desconhecido. Não houve falsos eventos por variação do hash efêmero de oferta.

## Organização

```text
config/products.json           produtos e critérios
src/config.mjs               validação da configuração
src/parser.mjs               HTML AOD -> ofertas e cobertura
src/client.mjs               HTTP, timeout, captcha/bloqueios
src/domain.mjs               snapshots, filtros e eventos
src/store.mjs                JSONL + estado atômico simples
src/monitor.mjs              agendador resiliente, confirmação e EventEmitter
src/metricas.mjs              janela fixa de métricas + assinatura semântica
src/cli.mjs                  executável local
src/replay.mjs               reprodução offline dos logs antigos
test/                        testes sem chamadas à Amazon
HANDOFF-CODEX.md             próximo ciclo de desenvolvimento
CONTRATOS.md                 contrato de integração
VALIDACAO.md                 evidências e limitações de teste
CHANGELOG-v0.3.md             mudanças desta revisão
MIGRACAO-v0.3.md              atualização segura no Windows
CHANGELOG-v0.2.md             histórico da versão anterior
MIGRACAO-v0.2.md              histórico de migração v0.1 para v0.2
```

## Limitações importantes

- O AOD é HTML/endpoint interno, sem estabilidade contratual de layout. Mudanças na Amazon podem exigir atualização do parser.
- HTTP 200 comprova apenas resposta, não que o uso automatizado seja permitido ou que preços/estoque estejam confirmados no checkout.
- Falhas de rede geram estado `DESATUALIZADO`, **não** `INDISPONÍVEL`.
- `offerHash` é mantido para diagnóstico, mas **não é usado para detectar mudanças**.
- `maxQty` pode ser apenas o limite do botão de compra e não inventário real.
- O processo atual é um MVP para monitoramento/alertas, não é núcleo de compras autorizado.
- A base de testes de parse HTML real deve ser ampliada com fixtures AOD, sem guardar dados sensíveis nem fazer consultas adicionais desnecessárias.

## Atualização v0.2 → v0.3

Consulte [MIGRACAO-v0.3.md](MIGRACAO-v0.3.md). A pasta `data` **precisa ser copiada integralmente**, com o monitor parado. `schemaVersion=1` e os eventos antigos são preservados. A primeira nova execução passa a registrar `confirmedSnapshot` e `pendingConfirmation` de forma aditiva.

### Notificações, confirmação e métricas

- `monitor.on("candidate", ...)`: sinal provisório para exibição visual, **não** evento durável nem gatilho executável. Se a condição sumir no próximo ciclo, o candidato é descartado.
- `monitor.on("event", ...)`: evento confirmado e persistido na outbox/JSONL, com as exceções da primeira coleta (meta já atingida / vendedor desconhecido).
- `monitor.on("schedule", ...)`: `CICLO_LENTO` e `SLOTS_PULADOS` não interrompem a coleta. Bloqueios HTTP/CAPTCHA continuam interrompendo imediatamente, e `maxConsecutiveFailures` segue sendo limite de segurança por ASIN.
- `latencias[]`, `duracoes[]`, `latenciaP50ms`, `latenciaP95ms`: **somente últimas 1.024 amostras**, não estatística de toda a sessão. `maiorCicloMs`, contadores de tentativas/sucessos/falhas e bytes são cumulativos. `falhasPorCodigo`, `memoriaRssMB`, `arquivosBytes` ajudam a diagnosticar execuções longas.
- Timeout de uma requisição acima do intervalo não cancela as outras. Um ciclo lento termina antes de o próximo começar; horários perdidos são pulados. Um 429/403/503 ou CAPTCHA detectado continua sendo bloqueio e não há contorno automático.

## Histórico — atualização v0.1 → v0.2

**Não apague `data/`**. Pare todas as instâncias e siga
[MIGRACAO-v0.2.md](MIGRACAO-v0.2.md) para criar uma pasta nova e copiar com
segurança `data/state.json`, `data/events.jsonl` e `data/observations.jsonl`.
Depois teste com:

```powershell
npm install
npm test
npm run monitor -- --seconds 60
```

A versão 0.2 mantém `schemaVersion=1` e carrega o `state.json` da versão
anterior. Na primeira execução, adiciona em memória `outbox: []`; a alteração
é gravada no primeiro ciclo. Eventos antigos conservam seu ID original.
Novos eventos usam `id` UUID único e `dedupKey` semântica (não-única).

### Persistência após interrupções

A fonte autoritativa é `state.json`, com o último snapshot e `outbox[]` de
eventos pendentes. O estado e a outbox são salvos juntos com substituição
atômica do arquivo. Os eventos são gravados em `events.jsonl` com sincronização
para disco; os IDs do log são indexados na abertura. Na reinicialização, uma
outbox pendente é conciliada contra esse log, evitando duplicar o mesmo ID.

Isso protege as janelas testadas de interrupção do processo, **mas não é uma
transação ACID entre arquivos** e não deve sustentar compras. Em particular:

- Um arquivo JSONL truncado ou inválido impede a retomada; preserve os arquivos
  e examine a causa, sem excluir eventos para continuar silenciosamente.
- `observations.jsonl` é diagnóstico, não log transacional: pode faltar a
  observação de um ciclo interrompido depois do commit do estado.
- A interface deve carregar o histórico persistido ao iniciar; um evento
  recuperado de outbox pode já ter sido exibido antes da interrupção e,
  por isso, não é reemitido cegamente como notificação em tempo real.
- O índice atual lê `events.jsonl` ao iniciar; para retenção extensa/múltiplos
  processos, migrar para banco transacional e outbox/indexação adequados.

### Identidade de vendedor

Vendedor terceiro sem `sellerId` verificável permanece `DESCONHECIDA`, mesmo
que algum texto seja exibido no HTML, evitando dar identidade confiável a um
campo ambíguo. Para revisão técnica, ofertas assim incluem
`vendedorDiagnostico.textoBloco` (até 160 caracteres) e `possuiLinkSeller`.
Ainda é necessário obter uma amostra HTML sanitizada das duas ofertas com
vendedor desconhecido para concluir a correção da extração; não presumir
que o problema foi resolvido só por melhorar os seletores.
