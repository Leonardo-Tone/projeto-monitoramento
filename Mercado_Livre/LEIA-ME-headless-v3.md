# Teste persistente com runtime integrado

Integração instalada em `C:\Users\leoto\Desktop\Projeto Monitoramento\Mercado_Livre`, separada do teste v2 e do runtime antigo. Runtime de origem: commit `7fe73dd3a755bb3589aebb948a396f02969130b5`, Puppeteer Core 24.8.1 com cinco patches. Dependências privadas instaladas com `npm ci --omit=dev --offline`; não há dependência do diretório de desenvolvimento nem de Puppeteer Extra/Stealth.

Executar no diretório de destino:

```powershell
node teste-ml-persistente-v3.mjs --minutos 5
node teste-ml-persistente-v3.mjs --minutos 10
node teste-ml-persistente-v3.mjs --minutos 30
node teste-ml-persistente-v3.mjs --minutos 60
node teste-ml-persistente-v3.mjs --minutos 90
```

Executar uma bateria por vez. O padrão é headless; `--headful` permite comparação visível. `ML_CHROME_EXECUTABLE` pode indicar outro executável Chrome. Perfil persistente próprio: `perfis/ml-chrome-headless-v3`; não importa login/cookies do perfil anterior do Edge. O bloqueio nativo do Chrome impede abrir esse perfil simultaneamente. Para preparar uma sessão manual, usar `--preparar-perfil`; não usar o perfil pessoal do navegador.

Para preparar o perfil sem iniciar uma bateria, executar `node teste-ml-persistente-v3.mjs --preparar-perfil`, fazer login manualmente na janela aberta, verificar acesso ao produto e pressionar Enter no terminal para encerrar. Depois executar a bateria headless. Nenhuma credencial é solicitada pelo script.

Diagnóstico de 2026-11-05: execução curta com perfil sem login redirecionou a página tradicional para `/gz/account-verification`, exibindo solicitação de acesso à conta. A checagem imediata após DOMContentLoaded podia registrar apenas `nordic_ausente`, antes do redirecionamento. Agora aguarda até cinco segundos pelo marcador e registra título, cabeçalhos e trecho de texto da página, além da URL final. Verificações continuam interrompendo a bateria. Não há evidência suficiente para atribuir essa exigência de login à detecção de automação. O acesso autenticado ainda depende de preparação manual e nova execução pelo usuário.

Cada execução coleta referência nativa nova numa página local antes de iniciar a integração. A auditoria compara página e worker dedicado. Os produtos, intervalo de 60 segundos, concorrência e regras de parada por verificação/erro do v2 são preservados. A duração se refere à observação após bootstrap; preparação, navegações em andamento e encerramento podem aumentar o tempo total.

Resultados em `ml-persistente-v3-<data>`: `referencia-native.json`, `progresso.json` por rodada (incluindo memória do coletor e estado da integração) e `relatorio.json` final com liberações de workers e erros. Memória do coletor não equivale à memória do Chrome. Ctrl+C solicita parada e salva o relatório após a operação em andamento. O resultado exige todas as consultas previstas e ausência de falha da integração.

Verificação realizada em 2026-11-05: cinco hashes de patches conferidos; análise de sintaxe; autoteste local com Chrome, página, worker e encerramento aprovado; duração inválida rejeitada. A espera de conexões HTTP do servidor de referência foi corrigida com fechamento explícito dessas conexões. Nenhuma bateria contra Mercado Livre foi iniciada nesta instalação.

```powershell
node teste-ml-persistente-v3.mjs --self-test
npm --prefix .\puppeteer-headless-runtime run verify
```

Esta pasta no repositório conserva o código da integração. Na instalação, colocar os dois arquivos `.mjs` ao lado da pasta `puppeteer-headless-runtime`, contendo `package.json`, `package-lock.json`, `src`, `patches` e os scripts `native-metadata.js`, `apply-puppeteer-runtime-patch.js`, `verify-puppeteer-runtime-patch.js` do runtime de origem. Não versionar perfis, dependências instaladas ou dados de sessão.
