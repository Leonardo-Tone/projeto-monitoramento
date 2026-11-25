param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputDir = ''
)

# Exportacao somente leitura do codigo original do Vigia.
# Compatibilidade: Windows PowerShell 5.1 / PowerShell 7+.
$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd([char[]]@('\', '/'))
$interfaceServer = Join-Path $ProjectRoot 'interface\server.mjs'
if (-not (Test-Path -LiteralPath $interfaceServer -PathType Leaf)) {
    throw "O projeto ORIGINAL nao foi encontrado: $interfaceServer"
}
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $ProjectRoot 'BACKUPS-CODIGO'
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# Escopo do projeto. Inclui automaticamente scripts/testes/patches adicionais
# localizados nestes componentes, mesmo que nao tenham sido vistos antes.
$Sources = @(
    'interface\app.js', 'interface\cards.js', 'interface\index.html',
    'interface\styles.css', 'interface\INICIAR-PAINEL.cmd', 'interface\launch.mjs',
    'interface\panel-api.mjs', 'interface\server.mjs', 'interface\package.json',
    'interface\server',
    'Amazon\amazon-monitor-core\src', 'Amazon\amazon-monitor-core\package.json',
    'Amazon\amazon-monitor-core\package-lock.json',
    'Mercado_Livre\integracao-native.mjs',
    'Mercado_Livre\puppeteer-headless-runtime\src',
    'Mercado_Livre\puppeteer-headless-runtime\scripts\apply-puppeteer-runtime-patch.js',
    'Mercado_Livre\puppeteer-headless-runtime\scripts\native-metadata.js',
    'Mercado_Livre\puppeteer-headless-runtime\scripts\verify-puppeteer-runtime-patch.js',
    'Mercado_Livre\puppeteer-headless-runtime\patches',
    'Mercado_Livre\puppeteer-headless-runtime\package.json',
    'Mercado_Livre\puppeteer-headless-runtime\package-lock.json'
)

$CodeExtensions = @(
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
    '.json', '.jsonc', '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.vue', '.svelte', '.py', '.ps1', '.psm1', '.psd1', '.cmd', '.bat',
    '.sh', '.sql', '.yaml', '.yml', '.toml', '.xml', '.graphql', '.gql',
    '.patch', '.diff'
)
$StaticAssetExtensions = @('.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico')
$SpecialNames = @('Dockerfile', 'Containerfile', '.gitignore', '.dockerignore', 'README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md')

$IgnoredDirs = @(
    '.git', '.data', '.runtime', '.cache', '.next', '.turbo', '.vscode', '.idea',
    'node_modules', 'dist', 'build', 'coverage', 'vendor', '__pycache__',
    'tmp', 'temp', 'logs', 'log', 'data', 'BACKUPS-CODIGO',
    'perfis', 'profiles', 'chrome-profiles', 'chrome-profiles-backup',
    'user-data', 'user-data-dir', 'browser-data', 'Default', 'Local Storage',
    'Session Storage', 'IndexedDB', 'Cache', 'Code Cache', 'GPUCache',
    'Service Worker', 'Crashpad', '.venv', 'venv', '.pytest_cache',
    'artifacts', 'reports', 'screenshots', 'downloads', 'traces'
)

function Get-RelativePath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $prefix = $ProjectRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Tentativa de incluir caminho fora do projeto original: $full"
    }
    return $full.Substring($prefix.Length).Replace('\', '/')
}

function Test-ExcludedDirectory([string]$Name) {
    if ($IgnoredDirs -contains $Name) { return $true }
    if ($Name -match '(?i)^(?:backup|backups|bak)(?:$|[-_.])') { return $true }
    if ($Name -match '(?i)^(?:old|legacy-copy)(?:$|[-_.])') { return $true }
    return $false
}

function Test-AllowedFile([System.IO.FileInfo]$File, [string]$Relative) {
    $name = $File.Name
    $relativeLower = $Relative.ToLowerInvariant()

    # Arquivos gerados, sessoes, segredos, backups e dados operacionais.
    if ($name -match '(?i)(^\.env(?:$|\.)|\.secret(?:s)?\.|\.credentials\.|\.(?:pem|p12|pfx|key|db|sqlite|sqlite3|jsonl|log)$)') { return $false }
    if ($name -match '(?i)^(?:cookies?|tokens?|secrets?|credentials?|passwords?|auth[-_.]?state|session[-_.]?state|storage[-_.]?state)(?:[-_.]|$)') { return $false }
    if ($name -match '(?i)(^|[-_.])(?:private[-_.]?key|api[-_.]?key|access[-_.]?token|refresh[-_.]?token|client[-_.]?secret)(?:[-_.]|$)') { return $false }
    if ($name -match '(?i)(?:\.bak|\.backup|\.old|\.orig|\.tmp|\.swp|~)$') { return $false }
    if ($name -match '(?i)^(?:registry(?:[-_.].*)?|state|session|cookies|local-state)\.json$') { return $false }
    if ($name -match '(?i)^(?:mission|missao|progresso|progresso-agent|relatorio-resiliencia)\.md$') { return $false }
    if ($relativeLower -in @('amazon/amazon-monitor-core/src/cli.mjs', 'amazon/amazon-monitor-core/src/replay.mjs')) { return $false }
    if ($relativeLower -match '(?i)(^|/)(?:backup|backups|bak)(?:$|[-_.])') { return $false }
    if ($File.Length -gt 15MB) { return $false }

    if ($CodeExtensions -contains $File.Extension.ToLowerInvariant()) { return $true }
    if ($SpecialNames -contains $name) { return $true }
    if ($StaticAssetExtensions -contains $File.Extension.ToLowerInvariant()) {
        return ($relativeLower -match '(?i)(^|/)(?:assets|public|static|fixtures)(/|$)')
    }
    return $false
}

$Files = New-Object 'System.Collections.Generic.List[object]'
$Seen = @{}
$MissingSources = New-Object 'System.Collections.Generic.List[string]'
$ExcludedCount = 0

function Add-Candidate([System.IO.FileInfo]$File) {
    $relative = Get-RelativePath $File.FullName
    if (-not (Test-AllowedFile $File $relative)) { $script:ExcludedCount++; return }
    if ($script:Seen.ContainsKey($relative.ToLowerInvariant())) { return }
    $script:Seen[$relative.ToLowerInvariant()] = $true
    [void]$script:Files.Add([pscustomobject]@{
        Absolute = $File.FullName
        Relative = $relative
        Length = $File.Length
    })
}

foreach ($source in $Sources) {
    $sourcePath = Join-Path $ProjectRoot $source
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        [void]$MissingSources.Add($source)
        continue
    }
    $item = Get-Item -LiteralPath $sourcePath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Fonte e um link simbolico/junction, nao sera seguida: $sourcePath"
    }
    if ($item -is [System.IO.FileInfo]) {
        Add-Candidate $item
        continue
    }
    $stack = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
    $stack.Push($item)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($entry in (Get-ChildItem -LiteralPath $dir.FullName -Force -ErrorAction Stop)) {
            if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($entry -is [System.IO.DirectoryInfo]) {
                if (Test-ExcludedDirectory $entry.Name) { continue }
                $stack.Push($entry)
            } elseif ($entry -is [System.IO.FileInfo]) {
                Add-Candidate $entry
            }
        }
    }
}

if ($MissingSources.Count -gt 0) { throw ('Fontes obrigatorias ausentes; ZIP nao gerado: ' + ($MissingSources -join ', ')) }
if ($Files.Count -eq 0) { throw 'Nenhum arquivo de codigo encontrado; ZIP nao gerado.' }
$SortedFiles = @($Files | Sort-Object Relative)

# Analise estatica conservadora: imports relativos explicitos e entradas dos package.json.
# Imports criados dinamicamente e arquivos internos do npm nao sao verificaveis aqui.
$MissingReferences = New-Object 'System.Collections.Generic.List[object]'
$RefSeen = @{}
$ScannedImports = 0
$ScannedPackageScripts = 0

function Add-Reference([string]$Origin, [string]$Reference, [string]$Kind) {
    $originPath = Join-Path $ProjectRoot ($Origin.Replace('/', '\'))
    $baseDir = Split-Path -Parent $originPath
    $refClean = ($Reference -split '[?#]', 2)[0].Replace('/', '\')
    if ([string]::IsNullOrWhiteSpace($refClean)) { return }
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $baseDir $refClean))
    $rootPrefix = $ProjectRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    $alternatives = @($candidate)
    if ([string]::IsNullOrWhiteSpace([System.IO.Path]::GetExtension($candidate))) {
        $alternatives += @("$candidate.js", "$candidate.mjs", "$candidate.cjs", "$candidate.json")
        $alternatives += (Join-Path $candidate 'index.js')
        $alternatives += (Join-Path $candidate 'index.mjs')
    }
    $foundInExport = $false
    $foundOnDisk = $false
    foreach ($alt in $alternatives) {
        if (Test-Path -LiteralPath $alt -PathType Leaf) {
            $foundOnDisk = $true
            $rel = Get-RelativePath $alt
            if ($script:Seen.ContainsKey($rel.ToLowerInvariant())) { $foundInExport = $true }
        }
    }
    if ($foundInExport) { return }
    $refKey = ($Origin + '|' + $Reference + '|' + $Kind).ToLowerInvariant()
    if ($script:RefSeen.ContainsKey($refKey)) { return }
    $script:RefSeen[$refKey] = $true
    [void]$script:MissingReferences.Add([pscustomobject]@{
        origin = $Origin
        reference = $Reference
        kind = $Kind
        status = $(if ($foundOnDisk) { 'exists_but_excluded' } else { 'not_found_on_disk' })
    })
}

$importPattern = '(?m)\b(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)[''\"](?<path>\.{1,2}/[^''\"]+)[''\"]'
$scriptPattern = '(?i)(?<path>(?:\.{1,2}[/\\])?(?:[a-z0-9_.-]+[/\\])*[a-z0-9_.*-]+\.(?:mjs|cjs|js|ts|ps1|cmd|bat))'
$htmlPattern = '(?i)\b(?:src|href)\s*=\s*[''\"](?<path>[^''\"]+)[''\"]'

foreach ($file in $SortedFiles) {
    $ext = [System.IO.Path]::GetExtension($file.Absolute).ToLowerInvariant()
    $isPatch = ($file.Relative -match '(?i)/patches/')
    if (($ext -in @('.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx')) -and (-not $isPatch)) {
        $content = [System.IO.File]::ReadAllText($file.Absolute)
        foreach ($match in [regex]::Matches($content, $importPattern)) {
            $ScannedImports++
            Add-Reference $file.Relative $match.Groups['path'].Value 'static_import'
        }
    }
    if ($ext -in @('.htm', '.html')) {
        $content = [System.IO.File]::ReadAllText($file.Absolute)
        foreach ($match in [regex]::Matches($content, $htmlPattern)) {
            $ref = $match.Groups['path'].Value
            if ($ref -match '^(?:https?:|data:|#|//|javascript:|mailto:|/|blob:)') { continue }
            Add-Reference $file.Relative $ref 'html_asset'
        }
    }
    if ($file.Relative -match '(?i)/?package\.json$') {
        try {
            $pkg = [System.IO.File]::ReadAllText($file.Absolute) | ConvertFrom-Json -ErrorAction Stop
            $commands = @()
            if ($pkg.main -is [string]) { $commands += [string]$pkg.main }
            if ($pkg.scripts) {
                foreach ($script in $pkg.scripts.PSObject.Properties) { if ($script.Name -in @('start', 'postinstall', 'verify')) { $commands += [string]$script.Value } }
            }
            foreach ($command in $commands) {
                foreach ($match in [regex]::Matches($command, $scriptPattern)) {
                    $ref = $match.Groups['path'].Value
                    if ($ref.Contains('*')) { continue }
                    $ScannedPackageScripts++
                    Add-Reference $file.Relative $ref 'package_script_or_main'
                }
            }
        } catch {
            Write-Warning "Falha ao inspecionar package.json: $($file.Relative): $($_.Exception.Message)"
        }
    }
}

$gitInfo = $null
if (Get-Command git -ErrorAction SilentlyContinue) {
    try {
        $gitRoot = Join-Path $ProjectRoot 'interface'
        $commit = (& git -C $gitRoot rev-parse HEAD 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and $commit) {
            $gitInfo = [ordered]@{
                commit = [string]$commit
                hasUncommittedChanges = ([bool]((& git -C $gitRoot status --porcelain 2>$null) | Select-Object -First 1))
            }
        }
    } catch { $gitInfo = $null }
}

$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss-fff'
$zipPath = Join-Path $OutputDir "Vigia-Codigo-$stamp.zip"
$partialPath = "$zipPath.partial"
$ManifestFiles = New-Object 'System.Collections.Generic.List[object]'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$archive = $null
try {
    $archive = [System.IO.Compression.ZipFile]::Open($partialPath, [System.IO.Compression.ZipArchiveMode]::Create)
    foreach ($file in $SortedFiles) {
        # Ler exatamente os bytes que entram no ZIP; hash da mesma copia (evita divergencia por arquivos alterados).
        $bytes = [System.IO.File]::ReadAllBytes($file.Absolute)
        $hash = [System.BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
        $entry = $archive.CreateEntry($file.Relative, [System.IO.Compression.CompressionLevel]::Optimal)
        $stream = $entry.Open()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        [void]$ManifestFiles.Add([pscustomobject]@{
            path = $file.Relative
            bytes = $bytes.Length
            sha256 = $hash
        })
    }
    $manifest = [ordered]@{
        schemaVersion = 2
        generatedAt = (Get-Date).ToString('o')
        purpose = 'Codigo aplicado ao Vigia e arquivos necessarios para instalacao; nao e backup operacional.'
        sources = $Sources
        missingSources = @($MissingSources.ToArray())
        fileCount = $ManifestFiles.Count
        excludedFileCandidates = $ExcludedCount
        sourceReferenceChecks = [ordered]@{
            staticImportsScanned = $ScannedImports
            packageScriptsScanned = $ScannedPackageScripts
            missingOrExcludedReferences = @($MissingReferences.ToArray())
            note = 'Analise estatica parcial. Imports dinamicos e dependencias npm externas nao estao incluidos.'
        }
        git = $gitInfo
        files = @($ManifestFiles.ToArray())
    }
    $manifestText = $manifest | ConvertTo-Json -Depth 16
    $manifestEntry = $archive.CreateEntry('manifest-codigo.json', [System.IO.Compression.CompressionLevel]::Optimal)
    $writer = New-Object System.IO.StreamWriter($manifestEntry.Open(), (New-Object System.Text.UTF8Encoding($false)))
    try { $writer.Write($manifestText) } finally { $writer.Dispose() }
} finally {
    if ($archive) { $archive.Dispose() }
    $sha256.Dispose()
}

try {
    # Verificar quantidade e hashes dos arquivos exportados, nao apenas a lista montada antes.
    $verifyZip = [System.IO.Compression.ZipFile]::OpenRead($partialPath)
    $checkSha = [System.Security.Cryptography.SHA256]::Create()
    try {
        if ($verifyZip.Entries.Count -ne ($ManifestFiles.Count + 1)) {
            throw "Quantidade inesperada de entradas no ZIP: $($verifyZip.Entries.Count)"
        }
        foreach ($file in $ManifestFiles) {
            $entry = $verifyZip.GetEntry($file.path)
            if (-not $entry) { throw "Faltando no ZIP: $($file.path)" }
            $stream = $entry.Open()
            try {
                $actualHash = [System.BitConverter]::ToString($checkSha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
            } finally { $stream.Dispose() }
            if ($actualHash -ne $file.sha256) { throw "Hash divergente: $($file.path)" }
        }
    } finally {
        $checkSha.Dispose()
        $verifyZip.Dispose()
    }
    Move-Item -LiteralPath $partialPath -Destination $zipPath -ErrorAction Stop
} catch {
    if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
    throw
}

Write-Host ''
Write-Host 'EXPORTACAO CONCLUIDA E VERIFICADA' -ForegroundColor Green
Write-Host "ZIP: $zipPath"
Write-Host "Arquivos de codigo: $($ManifestFiles.Count)"
Write-Host "Candidatos excluidos pelas regras: $ExcludedCount"
Write-Host "Referencias locais ausentes/excluidas: $($MissingReferences.Count)"
if ($MissingSources.Count -gt 0) {
    Write-Warning ('FONTES AUSENTES: ' + ($MissingSources -join ', '))
}
if ($MissingReferences.Count -gt 0) {
    Write-Warning 'Foram encontradas referencias locais ausentes. Consulte manifest-codigo.json antes de considerar o pacote completo.'
    $MissingReferences | Select-Object -First 12 | ForEach-Object {
        Write-Host ("  {0} => {1} [{2}]" -f $_.origin, $_.reference, $_.status) -ForegroundColor Yellow
    }
}
Write-Host 'Aviso: nenhum filtro automatico garante detectar segredos embutidos diretamente em codigo. Revise o ZIP antes de compartilhar.'
