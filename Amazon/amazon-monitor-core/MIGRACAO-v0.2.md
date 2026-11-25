# Migrar v0.1 → v0.2 com segurança (Windows)

**Importante:** primeiro feche o monitor; confirme que nenhum processo Node
está usando a mesma pasta `data`. Não exclua nem sobrescreva os arquivos
originais antes de fazer uma cópia.

Exemplo considerando o ZIP salvo em
`C:\Users\leoto\Desktop\Projeto Amazon\amazon-monitor-core-v0.2.zip`.

```powershell
cd "C:\Users\leoto\Desktop\Projeto Amazon"

# Backup completo do estado antigo
Copy-Item ".\amazon-monitor-core\data" ".\amazon-monitor-data-backup" -Recurse

# Extrai nova versão ao lado, sem substituir a antiga
Expand-Archive ".\amazon-monitor-core-v0.2.zip" -DestinationPath ".\" -Force

# Copia os 660 registros históricos, 2 eventos e estado existente
Copy-Item ".\amazon-monitor-core\data" ".\amazon-monitor-core-v0.2\data" -Recurse

cd ".\amazon-monitor-core-v0.2"
npm install
npm test
npm run monitor -- --seconds 60
```

Se o arquivo ZIP foi salvo em Downloads, copie-o para `Projeto Amazon` ou
altere o caminho indicado. Após os testes curtos, um teste de até 600s pode
ser feito somente se o acesso automatizado estiver autorizado.

## Conferência dos dados

- `data/events.jsonl` deve conter os **2 eventos antigos** antes de surgir
  qualquer nova ocorrência legítima.
- `data/state.json` deve guardar os **10 produtos** existentes; depois do
  primeiro ciclo, aparece `outbox: []` se não houver pendências.
- Se `monitor.lock` existir na pasta nova, confirme que não há outra instância
  ativa. Não apague o lock de um monitor rodando.
- Se o parser HTML produzir `DESCONHECIDA`, mantenha o diagnóstico para
  revisão sem converter em Amazon direta ou habilitar compra.

## Rollback

A pasta `amazon-monitor-core` (v0.1) continua intocada; a pasta
`amazon-monitor-data-backup` também. Pare a v0.2 antes de voltar à anterior.
Se a v0.2 tiver gerado eventos novos, **não sobrescreva seu histórico novo
com o antigo** sem reconciliar os IDs. Não rode versões simultaneamente.
