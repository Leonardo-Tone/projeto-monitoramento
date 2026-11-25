# Validação da v0.3 — 04/11/2026

- O projeto foi derivado do ZIP completo v0.2 anteriormente entregue.
- Comando executado no ambiente de montagem: `node --test`.
- Resultado: **25 passaram, 0 falharam, 1 pulado** (Cheerio ausente no ambiente offline).
- Novo teste de timeout simulado: conexão demora 10.506 ms em ciclo de 10 s;
  houve uma falha, agendador pulou slot perdido, retomou no próximo horário,
  sessão finita concluiu sem interrupção fatal.
- Teste de confirmação: mudança 10000→9000→10000 não gerou evento;
  mudança persistente 10000→8500→8500 gerou somente um evento confirmado.
- Teste de reinicialização: pendingConfirmation é persistido e consumido
  no próximo ciclo compatível; IDs e outbox continuam sem duplicação.
- Teste com 1.500 ciclos: arrays de métricas permanecem com 1.024 medidas.
- Teste de 6000 segundos com relógio simulado: 600 ciclos, sem espera real.
- Testes existentes de HTTP 429, outbox, lock, recuperação e estados legados
  continuam passando.

**Pendente de homologação:** `npm install` + `npm test` no Windows (incluindo
Cheerio), execução curta real com estado copiado e eventual teste de duração.
Não há garantia de disponibilidade do serviço, de autorização para consulta
contínua ou de precisão de dados fora da primeira página AOD.
