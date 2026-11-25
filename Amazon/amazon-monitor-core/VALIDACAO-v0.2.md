# Validação v0.2 (03/11/2026)

Ambiente de elaboração: Node.js 22.16.0, sem a dependência `cheerio`
instalada e sem testes HTTP reais desta versão.

- `node --check`: módulos alterados com sintaxe válida.
- `npm test`: **17 testes aprovados, 1 teste HTML pulado** (Cheerio ausente).
- Outbox: teste interrupção antes de publicar, após append e antes de ACK,
  recuperando sem duplicar; teste de lock e migração v0.1.
- IDs únicos: ocorrências idênticas recebem UUIDs distintos; `dedupKey`
  estável e não é usado para eliminar recorrência legítima.
- Integração real entre `Monitor` e `FileStore`: reinicialização sem alerta
  repetido, mudança de preço após restart com evento persistido, JSONL
  inválido falha fechado sem apagar arquivo.
- Replay offline do histórico anterior (`Texto colado(20261103-220503).txt`):
  600 snapshots, 10 produtos, 1 `TOTAL_OFERTAS_AOD_ALTERADO` e 2
  `VENDEDOR_DESCONHECIDO_VISIVEL` (não alterado pela v0.2).
- Persistência em arquivo e logs é adequada ao piloto monoprocesso,
  **não** fornece transação ACID nem garante integridade sob toda forma de
  perda abrupta de energia/sistema de arquivos.
- Adoção da v0.2 no Windows precisa de `npm install` e `npm test`; não
  considerar o parser HTML homologado até execução efetiva do teste Cheerio.
- Vendedores desconhecidos: proteção `DESCONHECIDA` e diagnóstico de texto,
  sem afirmar ter recuperado `sellerId` real na ausência de HTML bruto.

O monitor anterior v0.1 foi testado pelo usuário durante 60s e 600s:
60/60 e 600/600 coletas, respectivamente, sem falhas na carga relatada.
A v0.2 tem mudanças de persistência e **deve ser testada separadamente**.

## Homologação local com cópia dos dados reais da v0.1

Em diretório temporário isolado, carregados `state.json`, `events.jsonl` e
`observations.jsonl` fornecidos pelo usuário (sem alterar os originais):
10 produtos reconhecidos, 2 eventos legados preservados. Um ciclo sintético
com os mesmos dados de snapshot concluiu 10/10 coletas, 0 falhas,
0 eventos novos e `outbox=[]`. Este é um teste de migração **offline**,
não um teste HTTP do parser v0.2.
