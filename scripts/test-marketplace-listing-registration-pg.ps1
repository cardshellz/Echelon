[CmdletBinding()]
param(
  [string]$PostgresBin = 'C:\Program Files\PostgreSQL\17\bin',
  [ValidateRange(0, 65535)]
  [int]$Port = 0,
  [switch]$KeepData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
  )
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Assert-NativeSuccess {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ExitCode,
    [Parameter(Mandatory = $true)]
    [string]$Operation,
    [object[]]$Output
  )

  if ($ExitCode -ne 0) {
    $renderedOutput = ($Output | Out-String).Trim()
    throw "$Operation failed with exit code $ExitCode.`n$renderedOutput"
  }
}

function Start-CapturedNativeProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
    foreach ($argument in $Arguments) {
      $startInfo.ArgumentList.Add($argument)
    }
  } else {
    # Windows PowerShell uses .NET Framework, which predates ArgumentList.
    # None of these generated arguments contain a quote or end in a slash, so
    # quoting each complete argument preserves whitespace without ambiguity.
    foreach ($argument in $Arguments) {
      if ($argument.Contains('"') -or $argument.EndsWith('\')) {
        throw "Unsupported native process argument: $argument"
      }
    }
    $startInfo.Arguments = (
      $Arguments | ForEach-Object { '"' + $_ + '"' }
    ) -join ' '
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Failed to start native process: $FilePath"
  }
  return $process
}

function Assert-SafeCleanupTarget {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Target
  )

  $resolvedTempRoot = [System.IO.Path]::GetFullPath('C:\tmp').TrimEnd('\')
  $resolvedTarget = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
  $expectedPrefix = $resolvedTempRoot + '\marketplace-registration-pg-'

  if (
    -not $resolvedTarget.StartsWith(
      $expectedPrefix,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Refusing cleanup outside the dedicated proof prefix: $resolvedTarget"
  }

  return $resolvedTarget
}

$repoRoot = [System.IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..')
)
$integrationRoot = Join-Path $repoRoot (
  'server\modules\marketplace-listings\__tests__\integration'
)
$proofSql = Join-Path $integrationRoot (
  'marketplace-listing-registration.pg.sql'
)
$lockHolderSql = Join-Path $integrationRoot (
  'marketplace-listing-registration-lock-holder.pg.sql'
)
$lockContenderSql = Join-Path $integrationRoot (
  'marketplace-listing-registration-lock-contender.pg.sql'
)

$postgres = Join-Path $PostgresBin 'postgres.exe'
$initdb = Join-Path $PostgresBin 'initdb.exe'
$pgCtl = Join-Path $PostgresBin 'pg_ctl.exe'
$pgIsReady = Join-Path $PostgresBin 'pg_isready.exe'
$createdb = Join-Path $PostgresBin 'createdb.exe'
$psql = Join-Path $PostgresBin 'psql.exe'

foreach ($requiredPath in @(
  $postgres,
  $initdb,
  $pgCtl,
  $pgIsReady,
  $createdb,
  $psql,
  $proofSql,
  $lockHolderSql,
  $lockContenderSql
)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required proof dependency does not exist: $requiredPath"
  }
}

$versionOutput = @(& $postgres --version 2>&1)
$versionExitCode = $LASTEXITCODE
Assert-NativeSuccess `
  -ExitCode $versionExitCode `
  -Operation 'PostgreSQL version check' `
  -Output $versionOutput
$versionText = ($versionOutput | Out-String).Trim()
if ($versionText -notmatch 'PostgreSQL\) 17\.') {
  throw "PostgreSQL 17 is required; found: $versionText"
}

if ($Port -eq 0) {
  $Port = Get-FreeTcpPort
}
if ($Port -lt 1024) {
  throw "The disposable PostgreSQL port must be at least 1024; received $Port"
}

$testRoot = Join-Path 'C:\tmp' (
  'marketplace-registration-pg-' + [System.Guid]::NewGuid().ToString('N')
)
$safeTestRoot = Assert-SafeCleanupTarget -Target $testRoot
$dataDir = Join-Path $safeTestRoot 'data'
$serverOutput = Join-Path $safeTestRoot 'postgres.stdout.log'
$serverError = Join-Path $safeTestRoot 'postgres.stderr.log'
$databaseName = 'marketplace_registration_proof'
$serverStarted = $false
$serverProcess = $null
$holder = $null

Write-Host "PostgreSQL runtime: $versionText"
Write-Host "Disposable cluster: $safeTestRoot"
Write-Host "Disposable port: $Port"

try {
  New-Item -ItemType Directory -Path $safeTestRoot | Out-Null

  $initOutput = @(
    & $initdb `
      "--pgdata=$dataDir" `
      '--auth=trust' `
      '--username=postgres' `
      '--no-locale' `
      '--encoding=UTF8' 2>&1
  )
  $initExitCode = $LASTEXITCODE
  Assert-NativeSuccess `
    -ExitCode $initExitCode `
    -Operation 'initdb' `
    -Output $initOutput

  # Start postgres directly so the harness owns and can deterministically stop
  # the exact postmaster process. pg_ctl start leaves a detached cmd.exe child
  # on Windows, which is unsuitable for process-tracked test runners.
  $serverArguments = @(
    '-D',
    $dataDir,
    '-h',
    '127.0.0.1',
    '-p',
    [string]$Port
  )
  $serverProcess = Start-Process `
    -FilePath $postgres `
    -ArgumentList $serverArguments `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $serverOutput `
    -RedirectStandardError $serverError

  for ($attempt = 1; $attempt -le 100; $attempt += 1) {
    if ($serverProcess.HasExited) {
      $startupOutput = @(
        Get-Content -LiteralPath $serverOutput -ErrorAction SilentlyContinue
        Get-Content -LiteralPath $serverError -ErrorAction SilentlyContinue
      ) | Out-String
      throw "PostgreSQL exited before becoming ready.`n$($startupOutput.Trim())"
    }

    & $pgIsReady `
      '--host=127.0.0.1' `
      "--port=$Port" `
      '--username=postgres' *> $null
    if ($LASTEXITCODE -eq 0) {
      $serverStarted = $true
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $serverStarted) {
    throw 'PostgreSQL did not become ready within 10 seconds.'
  }

  $createOutput = @(
    & $createdb `
      '--host=127.0.0.1' `
      "--port=$Port" `
      '--username=postgres' `
      $databaseName 2>&1
  )
  $createExitCode = $LASTEXITCODE
  Assert-NativeSuccess `
    -ExitCode $createExitCode `
    -Operation 'createdb' `
    -Output $createOutput

  $proofOutput = @(
    & $psql `
      '--host=127.0.0.1' `
      "--port=$Port" `
      '--username=postgres' `
      "--dbname=$databaseName" `
      '--no-psqlrc' `
      '--set=ON_ERROR_STOP=1' `
      "--file=$proofSql" 2>&1
  )
  $proofExitCode = $LASTEXITCODE
  Assert-NativeSuccess `
    -ExitCode $proofExitCode `
    -Operation 'registration migration proof' `
    -Output $proofOutput
  $proofOutput | Write-Host

  $connectionArguments = @(
    '--host=127.0.0.1',
    "--port=$Port",
    '--username=postgres',
    "--dbname=$databaseName",
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1'
  )
  $holderArguments = $connectionArguments + @("--file=$lockHolderSql")
  $holder = Start-CapturedNativeProcess `
    -FilePath $psql `
    -Arguments $holderArguments

  $holderReady = $false
  $readinessSql = @'
SELECT CASE
  WHEN pg_try_advisory_lock(6080001)
    THEN (pg_advisory_unlock(6080001) AND FALSE)
  ELSE TRUE
END;
'@
  for ($attempt = 1; $attempt -le 50; $attempt += 1) {
    if ($holder.HasExited) {
      break
    }

    $readinessOutput = @(
      & $psql `
        '--host=127.0.0.1' `
        "--port=$Port" `
        '--username=postgres' `
        "--dbname=$databaseName" `
        '--no-psqlrc' `
        '--tuples-only' `
        '--no-align' `
        "--command=$readinessSql" 2>&1
    )
    $readinessExitCode = $LASTEXITCODE
    Assert-NativeSuccess `
      -ExitCode $readinessExitCode `
      -Operation 'lock-holder readiness probe' `
      -Output $readinessOutput

    if (($readinessOutput | Out-String).Trim() -eq 't') {
      $holderReady = $true
      break
    }
    Start-Sleep -Milliseconds 100
  }

  if (-not $holderReady) {
    $earlyHolderOutput = if ($holder.HasExited) {
      @(
        $holder.StandardOutput.ReadToEnd()
        $holder.StandardError.ReadToEnd()
      )
    } else {
      @('The holder process remained alive without acquiring its readiness lock.')
    }
    throw (
      "The lock holder did not signal readiness.`n" +
      (($earlyHolderOutput | Out-String).Trim())
    )
  }

  $contenderArguments = $connectionArguments + @(
    "--file=$lockContenderSql"
  )
  $contender = Start-CapturedNativeProcess `
    -FilePath $psql `
    -Arguments $contenderArguments
  if (-not $contender.WaitForExit(5000)) {
    Stop-Process -Id $contender.Id -Force -ErrorAction SilentlyContinue
    throw 'The lock-contender process did not finish within 5 seconds.'
  }
  $contender.WaitForExit()
  $contenderText = (
    $contender.StandardOutput.ReadToEnd() +
    $contender.StandardError.ReadToEnd()
  )
  if ($contender.ExitCode -eq 0) {
    throw (
      'Concurrent scope lock unexpectedly succeeded while the first session ' +
      'held FOR UPDATE.'
    )
  }
  if (
    $contenderText -notmatch '55P03' -or
    $contenderText -notmatch 'lock timeout'
  ) {
    throw (
      "Concurrent scope lock failed for an unexpected reason.`n" +
      $contenderText.Trim()
    )
  }

  if (-not $holder.WaitForExit(15000)) {
    throw 'The lock-holder process did not finish within 15 seconds.'
  }
  $holder.WaitForExit()
  $holderText = (
    $holder.StandardOutput.ReadToEnd() +
    $holder.StandardError.ReadToEnd()
  )
  if ($holder.ExitCode -ne 0) {
    throw (
      "The lock-holder process failed with exit code $($holder.ExitCode).`n" +
      $holderText
    )
  }

  Write-Host (
    'PASS: second session received PostgreSQL 55P03 while the first session ' +
    'held the registration scope FOR UPDATE.'
  )
  Write-Host 'PASS: marketplace listing registration PostgreSQL proof completed.'
} finally {
  if ($null -ne $holder -and -not $holder.HasExited) {
    Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue
  }

  if ($serverStarted) {
    $stopOutput = @(
      & $pgCtl `
        '-D' $dataDir `
        'stop' `
        '-m' 'fast' `
        '-w' `
        '-t' '30' 2>&1
    )
    $stopExitCode = $LASTEXITCODE
    Assert-NativeSuccess `
      -ExitCode $stopExitCode `
      -Operation 'pg_ctl stop' `
      -Output $stopOutput
    Write-Host 'Disposable PostgreSQL cluster stopped.'
    if (
      $null -ne $serverProcess -and
      -not $serverProcess.WaitForExit(10000)
    ) {
      throw 'The disposable PostgreSQL process remained alive after pg_ctl stop.'
    }
  } elseif ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }

  if ($KeepData) {
    Write-Host "Kept verified disposable cluster path: $safeTestRoot"
  } elseif (Test-Path -LiteralPath $safeTestRoot) {
    $verifiedCleanupTarget = Assert-SafeCleanupTarget -Target $safeTestRoot
    Write-Host "Verified cleanup target: $verifiedCleanupTarget"
    Remove-Item -LiteralPath $verifiedCleanupTarget -Recurse -Force
    Write-Host 'Disposable PostgreSQL files removed.'
  }
}
