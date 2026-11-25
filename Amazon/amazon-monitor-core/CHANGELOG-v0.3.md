# Alterações — Amazon Monitor Core v0.3

Correção da parada encontrada no teste `--seconds Infinity` de 03/11/2026:
um ciclo chegou a 10.506 ms depois de `UND_ERR_CONNECT_TIMEOUT`, e a v0.2
parou por `CICLO_MAIS_LONGO_QUE_INTERVALO` apesar de a falha não ser bloqueante.

## Mudanças implementadas

1. **Agendador tolerante:** não finaliza ao ultrapassar a janela de 10 s;
   termina o ciclo e agenda o próximo slot futuro. Slots vencidos são pulados,
   nunca recuperados por rajada. `schedule` emite `CICLO_LENTO` e `SLOTS_PULADOS`.
   Nenhuma requisição se sobrepõe ao ciclo anterior.
2. **Limites de segurança preservados:** HTTP 403/429/503, CAPTCHA/desafio e
   `maxConsecutiveFailures` continuam suspendendo o monitor. Não foi criado
   mecanismo de contorno, proxy ou retry agressivo.
3. **Monitoramento duradouro:** `seconds` aceita inteiro entre 10 e 604800
   (7 dias) ou `Infinity`. Agora `--seconds 6000` funciona diretamente.
4. **Métricas com memória limitada:** arrays `latencias` e `duracoes` armazenam
   no máximo 1.024 medidas recentes; P50/P95 medidos nessa janela.
   Totais, maior ciclo, falhas por código, ciclos lentos, slots perdidos,
   memória RSS e tamanho dos arquivos são publicados no resumo.
5. **Confirmação de mudanças:** `confirmationCycles` configurável (1 a 5,
   padrão 2), aplicado às mudanças após o baseline inicial. Um candidato
   provisório pode ser exibido via evento `candidate`, e é descartado se não
   se repetir em observação válida consecutiva. Depois da confirmação, o
   evento durável segue pela outbox e recebe UUID único. O estado contém
   `confirmedSnapshot` e `pendingConfirmation`, compatível com o `state.json`
   da v0.2 (`schemaVersion=1`).
6. **Testes offline:** simulam 10,506 s de ciclo, timeout não-bloqueante,
   agendamento sem rajadas, oscilação transitória de preço, confirmação
   após reinicialização, falha entre confirmações, janela de 1024 medidas e
   duração de 6000 segundos em relógio simulado.

## Limitações

- A validação da v0.3 é offline; não foi efetuada consulta real à Amazon.
- O teste de Cheerio ainda requer `npm install` no computador de destino.
- A confirmação por assinatura observa contador, presença da Amazon, preços
  mínimos por modalidade, alvo e vendedores desconhecidos; não identifica
  individualmente toda mudança de sellerId com preço inalterado.
- Persistência em JSONL/state é adequada para núcleo experimental, não ACID
  para transações financeiras. Nenhuma compra foi implementada.
