# Backlog — Vigia

## P1 · Blindar persistência local do `registry.json` contra corrupção (bytes zerados)

- **Registrado em:** 2026-11-28
- **Arquivo afetado:** `interface/server/storage.mjs` (`loadRegistry` e `registryWriter`)
- **Problema observado:**
  Em encerramentos abruptos do Windows/processo durante a escrita (`writeFile` + `rename` sem `fsync`), o arquivo `registry.json` em `%APPDATA%\Vigia\data\` pode ficar preenchido com bytes nulos (`0x00`). Na inicialização seguinte, `JSON.parse` lança `SyntaxError`, impedindo o Vigia de abrir (inclusive após reinstalar outra versão).
- **Correção planejada:**
  1. Em `registryWriter`: gravar o arquivo temporário com `fileHandle.sync()` (`fsync`) antes do `rename` para `registry.json`.
  2. Manter uma cópia íntegra anterior em `registry.bak.json` a cada gravação válida.
  3. Em `loadRegistry`: se `registry.json` falhar no `JSON.parse` ou na validação de schema:
     - Mover o arquivo corrompido para quarentena (`registry.json.corrupted-<timestamp>`).
     - Tentar restaurar automaticamente de `registry.bak.json`.
     - Se também não houver backup válido, iniciar com `{ schemaVersion: 1, products: [] }` para o app abrir normalmente e ressincronizar os dados a partir da VPS.
  4. Adicionar testes unitários cobrindo `registry.json` zerado/truncado, recuperação via `registry.bak.json` e fallback limpo.

## P2 · Detectar automaticamente a plataforma (Amazon / Mercado Livre) pelo link ao adicionar produto

- **Registrado em:** 2026-11-28
- **Arquivos afetados:** `interface/app.js`, `interface/index.html`, `interface/server/model.mjs`
- **Problema observado:**
  Atualmente, ao adicionar um novo produto no Vigia, o usuário precisa selecionar manualmente a plataforma (Amazon ou Mercado Livre) mesmo que o próprio link colado já identifique inequivocamente a loja (`amazon.com.br` / `www.amazon.com.br` vs. `mercadolivre.com.br` / `www.mercadolivre.com.br` / `produto.mercadolivre.com.br`).
- **Melhoria planejada:**
  1. Inferir automaticamente `store` (`amazon` ou `ml`) a partir do hostname do link em `productIdentity` / `productInput` (no backend) e ao colar/digitar o link no formulário (no frontend).
  2. Remover a necessidade de seleção manual de plataforma no fluxo de cadastro (exibindo apenas um badge/indicador visual da loja detectada automaticamente e ajustando os campos específicos, como `expectedSellerId` no ML).
  3. Adicionar testes cobrindo cadastro sem `store` explícito (auto-detecção por URL) e validação de links de domínios não suportados.

