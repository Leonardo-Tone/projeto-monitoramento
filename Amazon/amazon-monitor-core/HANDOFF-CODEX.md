# Handoff para Codex — Monitor Amazon

## Estado recebido

Atualização v0.2: os IDs dos eventos novos são UUIDs; `dedupKey` é apenas para
agrupar transições equivalentes, nunca chave de unicidade. A outbox no estado
faz reconciliação de eventos após crash. A UI deve recuperar notificações
persistidas em `events.jsonl` ao iniciar e escutar apenas novidades do monitor.
Nunca alterar diretamente `state.json`/`events.jsonl` pelo renderizador.
O parser exige sellerId para classificar vendedores terceiros; o campo
`vendedorDiagnostico` é evidência de revisão, **não identidade autorizada**.
Duas ofertas ainda exigem amostras HTML reais sanitizadas para diagnóstico.


Atualização **v0.3**: o monitor agora emite `candidate` (mudança provisória)
e `schedule` (`CICLO_LENTO`, `SLOTS_PULADOS`), além de `snapshot`, `event`,
`status`, `problem`, `cycle`. Eventos duráveis de transição precisam de
`confirmationCycles` leituras válidas consecutivas, padrão 2. Não criar uma
notificação de compra para um candidato. `confirmedSnapshot` e
`pendingConfirmation` são persistidos no estado; preservar a pasta `data`.
P50/P95 e arrays de amostras são **móveis (últimas 1024)**, enquanto contadores
e `maiorCicloMs` são cumulativos. Rodadas finitas podem durar até 7 dias.

A camada `src/` deste pacote constitui o núcleo de monitoramento **sem UI e sem compra**. Não redesenhar o parser sem um caso/fixture que reproduza o defeito. Abrir primeiro `README.md`, `CONTRATOS.md` e executar `npm test` + replay offline com JSONL real do usuário.

## Missão do próximo ciclo do Codex

Construir a experiência de uso e integrar o núcleo, em vez de reimplementar a coleta dentro da interface. O monitor deve permanecer um serviço autoritativo e isolado do renderizador. O projeto CEPO oferece conceitos reaproveitáveis (guias e filas), mas não presumir que arquivos do CEPO podem ser copiados sem revisão de contratos/escopo.

### 1. Interface de operação

- Dashboard de saúde: status global, última consulta por ASIN, latência P50/P95, próximo ciclo, bloqueios/erros, cobertura parcial/completa, eventos e erros por produto.
- Tabela de produtos: ASIN, nome, habilitado, categorias permitidas, preço normal / exibido, preço-alvo, última oferta direta, vendedor, envio, frete e `minQty`/`maxQty` (limites do botão, não estoque).
- Detalhe do ASIN: ofertas visíveis da primeira página, destaque separado, vendedor desconhecido para revisão, histórico de preço e alteração do total AOD.
- Centro de notificações: consumir eventos tipados; não emitir notificação por alterações de `offerHash`.
- Todos os títulos de preços devem informar se incluem frete; exibir `Não informado` para frete desconhecido.

### 2. Cadastro e configuração

- CRUD de ASIN (10 caracteres) com nome amigável, validação, habilitar/desabilitar, categorias por produto, preço-alvo opcional e base de preço (`NORMAL`/`DISPLAYED`).
- Não alterar manualmente `state.json` a partir da UI. Substituir acesso a `config/products.json` por repositório/serviço com validação e gravação atômica; dar ao monitor uma versão de configuração aplicada em cada ciclo.
- Incorporar eventos para `Produto atualizado`, `Regra alterada`, `Produto pausado` (contratos futuros), sem acoplar à página da Amazon.

### 3. Guias e filas inspiradas no CEPO

- Guia = agrupamento configurável de ASINs e/ou regras; referências por ID, nunca somente por texto de guia.
- Fila = sequência de ações/avaliações futuras de eventos; definir `guideId`, `queueId`, `ruleId`, `eventId`, status, ordem, prioridade e política de repetição.
- Estudar modelos do CEPO: ordem atual, um por guia, balanceamento, aleatório, pesos/cotas, prioridade alta/normal, ondas, seed, idempotência, locks e recuperação após crash. Reusar sem importar dependências do WhatsApp/BullMQ quando não houver necessidade.
- Importante: **não transformar fila em compra automática neste ciclo**. No máximo criar roteamento de eventos e ações visuais/teste sem efeitos externos.

### 4. Integração

- `Monitor` em `src/monitor.mjs` emite `snapshot`, `event`, `status`, `problem`, `cycle`, `candidate`, `schedule`.
- Criar ponte tipada do processo de monitoramento para UI (IPC/HTTP/WebSocket conforme arquitetura decidida). Renderizador não consulta AOD diretamente.
- Regras continuam no domínio (`src/domain.mjs`), não em componentes React.
- Registrar `schemaVersion` e adicionar migrations quando mudar formatos.
- Separar estado persistido de estado visual e nunca converter `DESATUALIZADO` para `SEM_ESTOQUE`.

### 5. Critérios de aceite da UI

1. O núcleo executa os testes de domínio/replay sem interface aberta.
2. Cadastro de produto inválido/duplicado é rejeitado e alterações persistem após reinício.
3. Alterações de `offerHash` sem mudança de preço/vendedor não geram notificação.
4. Evento `TOTAL_OFERTAS_AOD_ALTERADO` (36→37, Casio) é exibido corretamente no replay.
4a. Históricos carregados após reinício não geram notificações duplicadas;
    eventos recorrentes legitimamente diferentes não são apagados pela `dedupKey`.
4b. Testes de falha de arquivo/crash antes e depois de append passam.
5. Oferta ausente da página 1 nunca é descrita como estoque esgotado.
6. HTTP 429/403/503 ou CAPTCHA interrompem a coleta e a interface mostra causa sem contorno.
6a. Mudanças de uma única coleta aparecem como candidato, mas não entram no
    histórico definitivo; segunda observação consistente confirma a transição.
6b. Um timeout isolado não encerra a sessão e o agendador não recupera horários
    atrasados em rajada; contador de slots pulados deve ficar visível.
7. Dois processos não escrevem ao mesmo tempo no mesmo diretório de estado.
8. Guias/filas roteiam eventos, sem executar transações reais.

## Fase posterior, separada: mecanismo de compra

Só iniciar depois de autorização humana explícita e design de segurança. Prioridades: transações ACID + outbox idempotente; revalidação de vendedor, preço final, frete, quantidade disponível no checkout; confirmação humana por compra, limite financeiro, fail closed, credenciais protegidas e auditoria. O AOD pode servir como sinal inicial, **não como fonte definitiva para débito/checkout**.
