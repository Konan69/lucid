param([Parameter(Mandatory = $true)][string]$Output)
$ErrorActionPreference = 'Stop'
# All build products go to the explicitly supplied scratch/output directory.
# No downloads, registration, machine configuration or repository output is needed.
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (!(Test-Path $compiler)) { throw 'The in-box .NET Framework x64 compiler is missing' }
$assemblies = Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL'
$client = Join-Path $assemblies 'UIAutomationClient\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationClient.dll'
$types = Join-Path $assemblies 'UIAutomationTypes\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationTypes.dll'
$base = Join-Path $assemblies 'WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll'
foreach ($reference in @($client, $types, $base)) {
    if (!(Test-Path $reference)) { throw 'An in-box UI Automation assembly is missing' }
}
New-Item -ItemType Directory -Path $Output -Force | Out-Null
$executable = Join-Path $Output 'Vivid.Windows.exe'
$sources = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' | ForEach-Object FullName)
$arguments = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror+',
    "/out:$executable", '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll',
    '/r:System.Web.Extensions.dll', '/r:Microsoft.CSharp.dll', "/r:$client", "/r:$types", "/r:$base") + $sources
$quoted = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
Write-Output ("Command: `"$compiler`" " + $quoted)
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $compiler
$start.Arguments = $quoted
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($start)
# Retain the process handle before waiting: a short-lived compiler can otherwise
# leave PowerShell's Process wrapper without a usable ExitCode after it exits.
$handle = $process.Handle
Write-Output "Compiler PID=$($process.Id)"
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
$process.WaitForExit()
$stdout.Result | Write-Output
$stderr.Result | Write-Output
$exit = $process.ExitCode
$process.Dispose()
if ($exit -ne 0) { throw 'Windows helper compilation failed' }
Write-Output "Built $executable"
