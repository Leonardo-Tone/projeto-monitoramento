# Alterações aplicadas — v0.2

## Correções de integridade

1. `criarEvento`: IDs UUIDv4 por ocorrência. `dedupKey` semântica estável e
   `runId` por sessão; evita colisões quando `ciclo` recomeça em 1.
2. `FileStore`: `state.json` armazena `outbox[]` de eventos pendentes junto com
   o último snapshot; gravação temporária+rename e sincronização de arquivo.
3. `events.jsonl`: índice de IDs na inicialização, append sincronizado,
   publicação idempotente por ID, recuperação após interrupção antes ou
   depois do append sem repetir a mesma ocorrência.
4. `Monitor`: commit do estado/outbox uma vez por ciclo, publicação antes
   de emitir notificação, erros persistidos como `DESATUALIZADO`, sem
   descartar snapshot anterior.
5. Falha de JSONL: interrompe leitura sem descartar dados corrompidos.

## Identidade e diagnóstico

- Terceiro sem `sellerId` verificável permanece `DESCONHECIDA`; novos
  seletores textuais não são prova de identidade.
- Adicionado `vendedorDiagnostico` limitado a 160 caracteres para investigar
  vendedor ausente no HTML, sem acionar compras.
- **Pendente** identificar a causa precisa das duas ofertas sem vendedor:
  não foi fornecido HTML AOD integral/sanitizado.

## Compatibilidade

- `schemaVersion=1` mantido; estados e eventos v0.1 continuam legíveis.
- Não copiar dados pessoais/operacionais para dentro deste ZIP.
- Não inclui interface, guias/filas nem compra.

## Testes

17 passaram; 1 pulado por Cheerio ausente no ambiente offline.
Replay offline de 600 snapshots manteve 1 alteração de contador e 2 avisos
iniciais. A v0.2 ainda precisa de teste curto HTTP no Windows do usuário.
