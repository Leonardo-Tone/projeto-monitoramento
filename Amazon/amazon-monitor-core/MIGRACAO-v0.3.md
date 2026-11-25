# Migrar Amazon Monitor Core v0.2 → v0.3 (Windows)

**Não execute duas versões simultaneamente no mesmo `data/`.**

1. Pare a v0.2 com `Ctrl+C` e confira que o processo finalizou. Caso haja
   `monitor.lock`, confirme primeiro que não existe nenhum processo ativo.
2. Faça backup da pasta `data` original antes de mexer no projeto.
3. Extraia `amazon-monitor-core-v0.3.zip` em uma pasta **nova**, preferencialmente
   `C:\Users\leoto\Desktop\Projeto Amazon\amazon-monitor-core-v0.3`.
4. Copie toda a pasta `data` da v0.2 para a nova pasta da v0.3, preservando
   `state.json`, `events.jsonl`, `observations.jsonl` e quaisquer outros arquivos.
   Não combine os arquivos manualmente e não copie um `monitor.lock` antigo.
5. Na pasta nova execute `npm install`, `npm test` e um teste curto:

```powershell
cd "C:\Users\leoto\Desktop\Projeto Amazon\amazon-monitor-core-v0.3"
npm install
npm test
npm run monitor -- --seconds 60
```

A v0.3 usa `schemaVersion=1`, aceita o estado da v0.2 sem migração destrutiva
e mantém os UUIDs e os eventos anteriores. Após os ciclos válidos, cada
produto ganha `confirmedSnapshot` e `pendingConfirmation` (esta última normalmente
`null`). Na primeira mudança após o upgrade, o baseline é o último snapshot
persistido da v0.2. Um candidato pode aparecer como `[PENDENTE]`, sem gerar
um evento confirmado até a segunda observação consecutiva consistente.

Exemplo de rodada finita de 100 minutos, **somente se o acesso estiver permitido**:

```powershell
npm run monitor -- --seconds 6000
```

Se houver HTTP 429, 403, 503 ou CAPTCHA, o monitor continua interrompendo a
sessão. Não retome automaticamente em caso de restrição de acesso.

Para voltar à v0.2, pare a v0.3 e restaure **o backup original** da v0.2.
Não substitua o diretório novo com arquivos antigos sem preservar as mudanças
posteriores, porque eventos já gravados poderiam ser perdidos.
