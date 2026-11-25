# Contratos do núcleo — v0.3 (schemaVersion=1, compatível)

## Entrada

`config/products.json`: `schemaVersion=1`, configurações de agendamento, `products[]`. Identidade de produto: **ASIN**, com nome amigável. Preferências por ASIN: `enabled`, `categories[]`, `target`.

## Saída: EventEmitter

```javascript
monitor.on("snapshot", snapshot => { /* atualizar UI/cache */ });
monitor.on("event", evento => { /* centro de notificações / roteamento */ });
monitor.on("status", estado => { /* aguardando / rodando / interrompido */ });
monitor.on("problem", problema => { /* status de falha e diagnóstico */ });
monitor.on("cycle", ciclo => { /* indicadores e saúde */ });
monitor.on("candidate", candidato => { /* mudança observada 1/2, não confirmada */ });
monitor.on("schedule", aviso => { /* CICLO_LENTO ou SLOTS_PULADOS */ });
```

A futura interface não deve fazer `fetch` direto do renderizador. O núcleo roda em processo principal/worker/backend; o Codex implementará uma ponte IPC ou WebSocket, mantendo os contratos versionados.

## Tipos de eventos (`schemaVersion=1`)

- `AMAZON_DIRETA_AGORA_VISIVEL`: apareceu após ao menos um snapshot anterior sem essa modalidade.
- `AMAZON_DIRETA_NAO_OBSERVADA`: deixou de aparecer **na primeira página** (não é falta de estoque).
- `PRECO_AMAZON_DIRETA_ALTERADO`: preço normal identificado para venda direta mudou.
- `MENOR_PRECO_VISIVEL_ALTERADO`: menor preço normal observado em categoria terceira mudou (não mínimo global).
- `TOTAL_OFERTAS_AOD_ALTERADO`: contador exibido pelo AOD mudou, sem explicação causal automática.
- `ALVO_ATINGIDO`: oferta visível qualificada ficou dentro do limite configurado, inclusive em primeira coleta.
- `ALVO_NAO_OBSERVADO`: não há mais oferta qualificada observável; não implica esgotamento.
- `VENDEDOR_DESCONHECIDO_VISIVEL`: extração insuficiente; requer revisão manual.

Exemplo de evento:

```json
{
  "schemaVersion": 1,
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "dedupKey": "hash-semantico-da-transicao",
  "tipo": "TOTAL_OFERTAS_AOD_ALTERADO",
  "prioridade": "INFO",
  "horario": "2026-11-03T21:57:26.098Z",
  "origem": "AMAZON_AOD_PRIMEIRA_PAGINA",
  "asin": "B000GAYQJ0",
  "nome": "Casio A158WA",
  "ciclo": 18,
  "runId": "uuid-da-execucao",
  "cobertura": "PRIMEIRA_PAGINA_PARCIAL",
  "detalhes": {"anterior": 36, "atual": 37},
  "executavel": false
}
```

`id` é um UUID **único por ocorrência**, inclusive quando a contagem de ciclos
recomeça em outra execução. `dedupKey` representa a *mesma transição semântica*
(ASIN + tipo + detalhes canonizados), mas **não é uma chave única**: a mesma
transição pode ocorrer legitimamente mais de uma vez ao longo do tempo.
Não use `dedupKey` como chave primária ou para suprimir ocorrências futuras.
`runId` identifica a sessão atual do monitor.

O monitor grava `state.json` com `outbox[]` e snapshots antes de publicar os
IDs em `events.jsonl`. Reinícios conferem o log e publicam apenas IDs ainda
não encontrados. A UI deve construir seu histórico a partir de
`events.jsonl` e consumir `monitor.on("event")` para novidades depois da
persistência; um evento recuperado não é reemitido como novidade.

Essa recuperação entre arquivos não substitui transações ACID para
pagamentos/compras. Um `events.jsonl` truncado é erro bloqueante, não reparado
silenciosamente.

## Mudanças confirmadas e diagnóstico da execução (v0.3)

Por padrão, uma transição em relação à linha de base confirmada precisa ser
observada em **dois ciclos válidos consecutivos** (`confirmationCycles: 2`,
opcionalmente 1 a 5). A primeira observação gera `candidate` em memória;
a segunda gera os eventos duráveis (`event`). Oscilações de apenas um ciclo
não se tornam eventos confirmados. Primeira observação sem baseline mantém os
alertas iniciais (`ALVO_ATINGIDO`, `VENDEDOR_DESCONHECIDO_VISIVEL`) da v0.2.

A UI não deve confundir `candidate` com `event` nem tratar qualquer um como
autorização de compra; `executavel` sempre é `false`.

`state.products[asin].confirmedSnapshot` mantém o baseline de comparação;
`pendingConfirmation = {signature, count, firstSeenAt}` fica persistido para
preservar a confirmação entre reinicializações. Uma falha de coleta anula a
sequência candidata, mas preserva o último snapshot confirmado. O primeiro
ciclo da v0.3 com estado v0.2 inicia o baseline a partir de `snapshot`.

O agendador **não** finaliza por uma única requisição que ultrapasse o
intervalo; não se sobrepõe e pula horários vencidos sem rajadas. Bloqueios
identificados (HTTP 403, 429, 503, CAPTCHA) continuam interrompendo;
`maxConsecutiveFailures` também permanece ativo.

`monitor.resumo()` retorna contadores totais e métricas em janela móvel:
`latencias`, `duracoes`, P50 e P95 representam até **1.024 últimas amostras**.
`maiorCicloMs`, `falhasPorCodigo`, `ciclosLentos`, `ciclosPulados`,
`maiorAtrasoSlotPuladoMs`,
`requisicoesTentadas`, `bytes` são cumulativos. Após `executar()` também há
`arquivosBytes`, se o armazenamento suportar. `memoriaRssMB` é uma fotografia
do processo, não uma série histórica. `runId` continua único por execução.

## Estado por produto

`state.json` guarda `products[asin] = { snapshot, confirmedSnapshot, pendingConfirmation, consecutiveFailures, lastError, status }`
e, a partir da v0.2, `outbox: Evento[]`. Continua `schemaVersion=1` para
compatibilidade retroativa; formatos aditivos não alteram eventos legados.
- `status=ATUALIZADO`: último snapshot validado.
- `status=DESATUALIZADO`: falha atual, preservando a última fotografia.
- `snapshot.cobertura`: `PRIMEIRA_PAGINA_PARCIAL` ou `PRIMEIRA_PAGINA_COMPLETA`.
- `snapshot.amazonDiretaVisivel`: booleano de **presença observada**.
- `snapshot.melhoresVisiveis`: menores preços normais **na página consultada**, por categoria.
- `snapshot.alvo.atingido`: booleano da regra configurada, nunca comando de compra.
- `snapshot.ofertas[].vendedorDiagnostico`: evidência textual resumida de
  terceiros sem sellerId (quando fornecida pelo parser), não identificação
  comprovada do vendedor.

## Preparação para guias e filas (Codex)

Não existe acoplamento com filas ou guias do CEPO neste núcleo. O futuro orquestrador deverá consumir eventos por `event.id` (UUID ou ID legado), aplicar `guideId`, `queueId`, `ruleId` e escrever ações em seu próprio repositório transacional. Nunca deixar lógica de guias/filas controlar diretamente o parser HTTP.

## Preparação para compra (não implementada)

Nunca usar um snapshot AOD como autorização de compra: será necessário checagem atualizada no checkout, disponibilidade de estoque, preço final, frete, limites, identidade da conta, confirmação humana, trilha de auditoria e tratamento de idempotência/pagamentos.
