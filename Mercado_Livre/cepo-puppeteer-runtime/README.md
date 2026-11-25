# Puppeteer do CEPO

Este repositório privado reúne o runtime completo de Puppeteer usado pelo Agent do CEPO, baseado em `puppeteer-core@24.8.1`. A cópia em `vendor/puppeteer-core` inclui os arquivos distribuídos pelo pacote npm e os quatro arquivos CommonJS modificados. O código TypeScript e os artefatos ESM do pacote base foram preservados. O CEPO usa o ponto de entrada CommonJS, onde o patch é aplicado.

## Como funciona

O Agent instala a versão base sob o alias npm `cepo-puppeteer-runtime`. O instalador confere os hashes SHA-256 dos quatro arquivos do patch, verifica que o destino pertence a esta instalação e substitui as cópias correspondentes em `lib/cjs/puppeteer/cdp`. O verificador compara o manifesto, a origem e a instalação.

| Arquivo | Responsabilidade no runtime |
|---|---|
| `ExecutionContext.js` | Configura e usa contextos de execução CDP e bindings. |
| `FrameManager.js` | Inicializa e acompanha contextos associados a frames e navegações. |
| `IsolatedWorld.js` | Resolve os contextos principal e isolado usados na avaliação de código. |
| `WebWorker.js` | Inicializa os contextos CDP de workers. |

O adaptador em `src/puppeteer-runtime.js` define `REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding` antes de carregar o alias, limpa a opção de depuração e centraliza as opções de abertura do navegador. Os fluxos do Agent que usam esse adaptador incluem navegação de produtos, validação e sincronização de cupons.

## Instalação completa no Windows

### 1. Prepare o ambiente

Instale Git, GitHub CLI, Node.js 18 ou posterior com npm e Microsoft Edge. Abra o PowerShell e confira:

```powershell
git --version
gh --version
node --version
npm --version
```

Use uma conta com acesso ao repositório privado. Se precisar autenticar, execute `gh auth login -h github.com` e siga as instruções no navegador.

### 2. Clone o repositório e instale o runtime

```powershell
gh repo clone Leonardo-Tone/cepo-puppeteer-runtime
cd cepo-puppeteer-runtime
npm install
npm run verify
```

A instalação baixa a versão base e suas dependências do registro npm. O `postinstall` aplica os patches. A verificação deve listar os quatro arquivos com `OK`. Se o npm estiver configurado para ignorar scripts de instalação, aplique o patch manualmente:

```powershell
node scripts/apply-puppeteer-runtime-patch.js
npm run verify
```

### 3. Localize o Edge e faça um teste local

Na raiz do repositório, execute o bloco abaixo. Se o Edge estiver instalado em outro local, defina `CEPO_EDGE_EXECUTABLE` com o caminho completo de `msedge.exe`.

```powershell
$edgePaths = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$env:CEPO_EDGE_EXECUTABLE = $edgePaths |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1
if (-not $env:CEPO_EDGE_EXECUTABLE) {
  throw 'Edge não encontrado. Ajuste os caminhos acima para a sua instalação.'
}

@'
const puppeteer = require('./src/puppeteer-runtime');

async function main() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CEPO_EDGE_EXECUTABLE,
  });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    console.log(await page.evaluate(() => 2 + 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
'@ | node -
```

O resultado esperado é o Edge abrir com um perfil temporário, imprimir `4` no terminal e fechar. O teste usa uma página em branco e dispensa login no CEPO ou no Mercado Livre.

### 4. Integre ao seu código

Carregue o adaptador com `require('./src/puppeteer-runtime')` e passe o caminho do navegador em `launch({ executablePath })`. O adaptador mantém o navegador visível. Se copiar a integração para outro projeto, leve juntos o adaptador, o alias npm, os scripts de aplicação e verificação e a pasta de patches. As contas, perfis e dados do CEPO ficam no ambiente do usuário.

## Origem e licença

Base em [Puppeteer 24.8.1](https://github.com/puppeteer/puppeteer/tree/puppeteer-v24.8.1), sob Apache 2.0. O texto da licença e os avisos dos arquivos de origem foram preservados. Os quatro arquivos alterados e seus hashes estão descritos em `patches/puppeteer-runtime-24.8.1/patch-manifest.json`.
