$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function New-LocalSecret {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes); return [Convert]::ToBase64String($bytes) }
  finally { $generator.Dispose() }
}

try {
  $setupStage = 'certificate-modules'
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  Import-Module (Join-Path $PSHOME 'Modules/PKI/PKI.psd1') -ErrorAction Stop
  $setupStage = 'environment'
  $projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
  $environmentPath = Join-Path $projectDirectory '.env'
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $environmentText = if (Test-Path -LiteralPath $environmentPath) { [System.IO.File]::ReadAllText($environmentPath) } else { '' }
  $settings = @{}
  foreach ($line in ($environmentText -split '\r?\n')) {
    if ($line -match '^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
      $name = $Matches[1]
      $value = $Matches[2].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
      else { $value = ($value -split '#', 2)[0].Trim() }
      $settings[$name] = $value
    }
  }
  $defaults = [ordered]@{
    PORT = '4317'; HOST = '127.0.0.1'; LOCAL_ORIGIN = 'https://localhost:4317';
    LOCAL_TLS_PFX = '.data/tls/localhost.pfx'; DATA_DIR = '.data';
    TWITCH_REDIRECT_URI = 'https://localhost:4317/auth/twitch/callback'
  }
  foreach ($name in @('SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY', 'PUBLISH_SHARED_SECRET', 'LOCAL_TLS_PASSPHRASE')) {
    if (-not $settings[$name]) { $defaults[$name] = New-LocalSecret }
  }
  foreach ($entry in $defaults.GetEnumerator()) {
    if (-not $settings[$entry.Key]) {
      $escapedName = [Regex]::Escape($entry.Key)
      $pattern = '(?m)^\s*(?:export\s+)?' + $escapedName + '\s*=.*$'
      $replacement = $entry.Key + '=' + $entry.Value
      if ([Regex]::IsMatch($environmentText, $pattern)) { $environmentText = [Regex]::Replace($environmentText, $pattern, $replacement) }
      else { $environmentText = $environmentText.TrimEnd() + "`r`n" + $replacement + "`r`n" }
      $settings[$entry.Key] = $entry.Value
    }
  }
  # A temporary file and rename prevent partially written credentials. Existing nonempty values survive.
  $temporaryPath = $environmentPath + '.setup-tmp'
  [System.IO.File]::WriteAllText($temporaryPath, $environmentText, $utf8)
  Move-Item -LiteralPath $temporaryPath -Destination $environmentPath -Force

  $setupStage = 'tls-path'
  $tlsDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectDirectory '.data/tls'))
  $pfxPath = [System.IO.Path]::GetFullPath((Join-Path $projectDirectory $settings['LOCAL_TLS_PFX']))
  if (-not $pfxPath.StartsWith($tlsDirectory + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'TLS path must remain inside the ignored .data/tls directory.' }
  [System.IO.Directory]::CreateDirectory($tlsDirectory) | Out-Null
  $password = ConvertTo-SecureString -String $settings['LOCAL_TLS_PASSPHRASE'] -AsPlainText -Force
  $certificate = $null
  if (Test-Path -LiteralPath $pfxPath) {
    $setupStage = 'existing-pfx'
    $pfxData = Get-PfxData -FilePath $pfxPath -Password $password
    $certificate = $pfxData.EndEntityCertificates | Select-Object -First 1
    if ($certificate.NotAfter -lt (Get-Date).AddDays(14)) { $certificate = $null }
    elseif (-not ($certificate.DnsNameList.Unicode -contains 'localhost')) { throw 'The configured certificate does not cover localhost.' }
  }
  if ($null -eq $certificate) {
    $setupStage = 'certificate-create'
    $certificate = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation 'Cert:\CurrentUser\My' -FriendlyName 'Previously localhost development' -NotAfter (Get-Date).AddYears(1) -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -Type SSLServerAuthentication
    $setupStage = 'certificate-export'
    Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password -Force | Out-Null
  }
  # Trust only this user; machine-wide roots and TLS validation settings are untouched.
  $setupStage = 'certificate-trust'
  $publicCertificatePath = Join-Path $tlsDirectory 'localhost.cer'
  [System.IO.File]::WriteAllBytes($publicCertificatePath, $certificate.RawData)
  $trustedCertificate = Get-Item -LiteralPath ('Cert:\CurrentUser\Root\' + $certificate.Thumbprint) -ErrorAction SilentlyContinue
  if ($null -eq $trustedCertificate) {
    Write-Output 'Windows may ask to trust the localhost certificate. Confirm that local certificate in the Windows Security Warning to finish setup.'
    $trustLog = Join-Path $tlsDirectory 'certificate-import.log'
    $trustErrorLog = Join-Path $tlsDirectory 'certificate-import-error.log'
    # CurrentUser Root may require a Windows confirmation even with -f. Never disable TLS checks.
    $trustProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/certutil.exe') -ArgumentList @('-user', '-f', '-addstore', 'Root', ('"' + $publicCertificatePath + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput $trustLog -RedirectStandardError $trustErrorLog
    if (-not $trustProcess.WaitForExit(60000)) {
      $trustProcess.Kill()
      Write-Output 'Certificate trust was not confirmed within 60 seconds. Run npm run setup:local again when ready to answer the Windows dialog.'
      throw 'Certificate trust confirmation timed out.'
    }
    $trustProcess.Refresh()
    if ($trustProcess.ExitCode -ne 0) { throw 'CurrentUser certificate installation failed.' }
    Remove-Item -LiteralPath $trustLog, $trustErrorLog -Force -ErrorAction SilentlyContinue
  }
  Write-Output 'Local HTTPS setup is ready. Existing credentials were preserved.'
  Write-Output 'Start Previously and open https://localhost:4317.'
} catch {
  # Never print caught exceptions: crypto/file errors can contain sensitive supplied values.
  Write-Output ('Setup diagnostic: stage=' + $setupStage + '; exception=' + $_.Exception.GetType().Name + '; line=' + $_.InvocationInfo.ScriptLineNumber)
  Write-Error 'Local setup could not finish. Verify .env setting names, the existing TLS passphrase, and CurrentUser certificate access. No credential values were logged.'
  exit 1
}
