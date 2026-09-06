[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('config', 'build', 'up', 'down', 'restart', 'status', 'logs', 'health', 'token-create', 'token-list', 'token-revoke-id', 'token-revoke-label', 'backup', 'restore', 'serve', 'serve-status', 'migration-check', 'help')]
    [string] $Action = 'help',

    [Parameter(Position = 1)]
    [string] $Argument,

    [Parameter(Position = 2)]
    [string] $SecondArgument,

    [switch] $Confirm
)

$ErrorActionPreference = 'Stop'
$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent $DeployDir
$ComposeFile = Join-Path $DeployDir 'docker-compose.yml'
$DataDir = Join-Path $DeployDir 'data'

function Invoke-Compose {
    param([Parameter(Mandatory = $true)][string[]] $ComposeArgs)
    $envArgs = @()
    $envFile = Join-Path $DeployDir '.env'
    if (Test-Path $envFile -PathType Leaf) { $envArgs = @('--env-file', $envFile) }
    & docker compose --project-directory $RepoDir @envArgs -f $ComposeFile @ComposeArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose failed with exit code $LASTEXITCODE" }
}

function Get-AnimaPort {
    if ($env:ANIMA_PORT -match '^\d+$') { return $env:ANIMA_PORT }
    $envFile = Join-Path $DeployDir '.env'
    if (Test-Path $envFile -PathType Leaf) {
        $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*ANIMA_PORT\s*=\s*\d+\s*$' } | Select-Object -Last 1
        if ($line -and $line -match '=\s*(\d+)\s*$') { return $Matches[1] }
    }
    return '18000'
}

function Require-Runtime {
    if (-not (Test-Path (Join-Path $DeployDir '.env'))) {
        throw 'deploy/.env is missing; copy deploy/.env.example to deploy/.env and edit it first'
    }
    if (-not (Test-Path (Join-Path $RepoDir 'server/standalone.js'))) {
        throw 'server/standalone.js is missing; deployment is intentionally blocked because server/index.js is only a SillyTavern plugin entry point'
    }
}

function Show-Usage {
    @'
Usage: .\deploy\anima.ps1 <action> [argument] [second-argument]

config | build | up | down | restart | status | logs | health
token-create <label> | token-list | token-revoke-id <id> | token-revoke-label <label>
backup [archive.tar.gz] | restore <archive.tar.gz> -Confirm
serve | serve-status | migration-check <SillyTavern-docker-dir> | help
'@ | Write-Host
}

switch ($Action) {
    'config' { Invoke-Compose @('config'); break }
    'build' { Require-Runtime; Invoke-Compose @('build'); break }
    'up' {
        Require-Runtime
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        Invoke-Compose @('up', '-d', '--build')
        Invoke-Compose @('ps')
        break
    }
    'down' { Invoke-Compose @('down'); break }
    'restart' { Require-Runtime; Invoke-Compose @('restart', 'anima-remote'); break }
    'status' { Invoke-Compose @('ps'); break }
    'logs' {
        if ($Argument) { Invoke-Compose @('logs', $Argument, 'anima-remote') }
        else { Invoke-Compose @('logs', 'anima-remote') }
        break
    }
    'health' {
        $port = Get-AnimaPort
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/healthz" | Select-Object -ExpandProperty Content
        break
    }
    'token-create' {
        if (-not $Argument) { throw 'token-create requires a label' }
        Invoke-Compose @('run', '--rm', '--no-deps', '--no-ports', 'anima-remote', 'node', '/app/deploy/token-cli.js', 'create', '--label', $Argument)
        break
    }
    'token-list' {
        Invoke-Compose @('run', '--rm', '--no-deps', '--no-ports', 'anima-remote', 'node', '/app/deploy/token-cli.js', 'list')
        break
    }
    'token-revoke-id' {
        if (-not $Argument) { throw 'token-revoke-id requires an id' }
        Invoke-Compose @('run', '--rm', '--no-deps', '--no-ports', 'anima-remote', 'node', '/app/deploy/token-cli.js', 'revoke', '--id', $Argument)
        break
    }
    'token-revoke-label' {
        if (-not $Argument) { throw 'token-revoke-label requires a label' }
        Invoke-Compose @('run', '--rm', '--no-deps', '--no-ports', 'anima-remote', 'node', '/app/deploy/token-cli.js', 'revoke', '--label', $Argument)
        break
    }
    'backup' {
        New-Item -ItemType Directory -Force -Path (Join-Path $DeployDir 'backups') | Out-Null
        $archive = if ($Argument) { $Argument } else { Join-Path $DeployDir ('backups/anima-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.tar.gz') }
        if (Test-Path $archive) { throw "refusing to overwrite existing archive: $archive" }
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        $running = (& docker compose --project-directory $RepoDir -f $ComposeFile ps --status running -q anima-remote).Trim()
        if ($running) { Invoke-Compose @('stop', 'anima-remote') }
        try {
            & tar -czf $archive -C $DeployDir data
            if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
            & certutil -hashfile $archive SHA256
        }
        finally {
            if ($running) { Invoke-Compose @('start', 'anima-remote') }
        }
        Write-Host "Backup created: $archive"
        break
    }
    'restore' {
        if (-not $Argument) { throw 'restore requires an archive path' }
        if (-not $Confirm) { throw 'restore moves the active data directory; rerun with -Confirm' }
        if (-not (Test-Path $Argument -PathType Leaf)) { throw "archive does not exist: $Argument" }
        $temp = Join-Path ([IO.Path]::GetTempPath()) ('anima-restore-' + [guid]::NewGuid().ToString('N'))
        $rollback = Join-Path $DeployDir ('data.pre-restore-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
        New-Item -ItemType Directory -Force -Path $temp | Out-Null
        try {
            & tar -tzf $Argument | ForEach-Object {
                if ($_ -match '(^/|(^|/)\.\.(\/|$))') { throw 'archive contains an unsafe absolute or parent-traversal path' }
            }
            & tar -xzf $Argument -C $temp
            $staged = Join-Path $temp 'data'
            if (-not (Test-Path $staged -PathType Container)) { throw 'archive must contain a top-level data/ directory' }
            $running = (& docker compose --project-directory $RepoDir -f $ComposeFile ps --status running -q anima-remote).Trim()
            if ($running) { Invoke-Compose @('stop', 'anima-remote') }
            if (Test-Path $DataDir) { Move-Item -LiteralPath $DataDir -Destination $rollback }
            Move-Item -LiteralPath $staged -Destination $DataDir
            if ($running) { Invoke-Compose @('start', 'anima-remote') }
            Write-Host "Restored data. Previous data remains at: $rollback"
        }
        finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
        break
    }
    'serve' {
        $port = Get-AnimaPort
        & tailscale serve --bg --https=443 "http://127.0.0.1:$port"
        & tailscale serve status
        break
    }
    'serve-status' { & tailscale serve status; break }
    'migration-check' {
        if (-not $Argument) { throw 'migration-check requires the existing SillyTavern docker directory' }
        $plugin = Join-Path $Argument 'plugins/anima-rag'
        if (-not (Test-Path $plugin -PathType Container)) { throw "source plugin directory not found: $plugin" }
        Write-Host "Read-only check: $plugin"
        Get-ChildItem -LiteralPath $plugin -File -Recurse -Depth 2 | Select-Object -First 80 -ExpandProperty FullName
        if ((Test-Path (Join-Path $RepoDir 'server/migrate.js')) -or (Test-Path (Join-Path $RepoDir 'server/bin/anima-migrate.js'))) {
            Write-Warning 'A migration CLI candidate exists; review its dry-run contract before running it.'
        } else {
            Write-Host 'STATUS: 暂不迁移 — no migration CLI is present in this checkout.'
        }
        break
    }
    default { Show-Usage; break }
}
