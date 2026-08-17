param([string]$Profile = "web")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($dsh) {
  & $dsh.Source plugin --profile $Profile add $root
} else {
  $bin = Join-Path $HOME ".dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
  if (-not (Test-Path -LiteralPath $bin)) { throw "dsh CLI was not found" }
  & node $bin plugin --profile $Profile add $root
}
if ($LASTEXITCODE -ne 0) { throw "dsh plugin installation failed with exit code $LASTEXITCODE" }
Write-Output "INSTALLED dsh-codex-workflow into profile $Profile"
