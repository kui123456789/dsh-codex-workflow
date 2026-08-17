param([string]$Profile = "web")
$ErrorActionPreference = "Stop"
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($dsh) {
  & $dsh.Source plugin --profile $Profile remove dsh-codex-workflow
} else {
  $bin = Join-Path $HOME ".dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"
  if (-not (Test-Path -LiteralPath $bin)) { throw "dsh CLI was not found" }
  & node $bin plugin --profile $Profile remove dsh-codex-workflow
}
if ($LASTEXITCODE -ne 0) { throw "dsh plugin removal failed with exit code $LASTEXITCODE" }
Write-Output "REMOVED dsh-codex-workflow from profile $Profile"
