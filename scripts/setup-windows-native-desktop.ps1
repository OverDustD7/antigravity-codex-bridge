param(
    [switch]$Install,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
if ($Install -and $Uninstall) { throw 'Choose one operation.' }
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root '.runtime/native-desktop-transport'
$adapter = Join-Path $output 'codex.exe'
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
    throw 'Node.js 24 or later is required.'
}

Push-Location -LiteralPath $root
try {
    # Use stdin so Windows PowerShell does not strip quotes from Node's source argument.
    # Encode the path so it survives Windows PowerShell's console code page.
    $encodedSelection = "import { nativeDesktopSelection } from './src/config.mjs'; console.log(Buffer.from(nativeDesktopSelection).toString('base64'));" |
        & $node --input-type=module -
    if ($LASTEXITCODE -ne 0 -or -not $encodedSelection) { throw 'Could not locate the bridge state directory.' }
    $selection = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedSelection))
} finally { Pop-Location }

$previous = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User')
$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (($Install -or $Uninstall) -and $package) {
    $mainExecutable = Join-Path $package.InstallLocation 'app/ChatGPT.exe'
    $running = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {
        $_.ExecutablePath -ieq $mainExecutable -and $_.CommandLine -notmatch '(?:^|\s)--type='
    } | Select-Object -First 1
    if ($running) { throw 'Finish active work and fully quit Codex before changing how it starts.' }
}
if ($Uninstall) {
    $removeRegistration = $false
    if (Test-Path -LiteralPath $selection) {
        $registered = Get-Content -LiteralPath $selection -Raw | ConvertFrom-Json
        $removeRegistration = $registered.adapter -ieq $adapter
    }
    if ($previous -ieq $adapter) { [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $null, 'User') }
    try {
        if ($removeRegistration) { Remove-Item -LiteralPath $selection -ErrorAction Stop }
    } catch {
        if ($previous -ieq $adapter) { [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $adapter, 'User') }
        throw
    }
} else {
    if ($Install -and $previous -and $previous -ine $adapter) { throw 'An existing Codex CLI override is configured. Keep it until you decide how to migrate it.' }
    if (-not $package) { throw 'Install the official Codex desktop app first.' }
    $codex = Join-Path $package.InstallLocation 'app/resources/codex.exe'
    if (-not (Test-Path -LiteralPath $codex -PathType Leaf)) { throw 'Could not locate the CLI bundled with the official Codex desktop app.' }
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $null = New-Item -Path $output -ItemType Directory -Force
    & $compiler /nologo /target:exe "/out:$adapter" (Join-Path $PSScriptRoot 'CodexDesktopTransport.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the Codex desktop transport adapter.' }
    [IO.File]::WriteAllText((Join-Path $output 'node-path.txt'), $node)
    [IO.File]::WriteAllText((Join-Path $output 'codex-path.txt'), $codex)
    if ($Install) {
        $null = New-Item -Path (Split-Path -Parent $selection) -ItemType Directory -Force
        $firstRegistration = -not (Test-Path -LiteralPath $selection)
        if (-not $firstRegistration) {
            $registered = Get-Content -LiteralPath $selection -Raw | ConvertFrom-Json
            if ($registered.adapter -ine $adapter) { throw 'A different bridge directory is registered for normal startup.' }
        } else {
            [IO.File]::WriteAllText($selection, ([pscustomobject]@{ adapter = $adapter } | ConvertTo-Json -Compress))
        }
        try { [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $adapter, 'User') }
        catch {
            if ($firstRegistration) { Remove-Item -LiteralPath $selection -ErrorAction Stop }
            throw
        }
    }
}
[pscustomobject]@{ adapter = $adapter; installed = [bool]$Install; removed = [bool]$Uninstall } | ConvertTo-Json -Compress
