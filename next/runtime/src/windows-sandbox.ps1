param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-sandbox.cs')
  $request = [System.IO.File]::ReadAllText([BridgeSandbox]::FileSystemPath($RequestFile), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($request.operation -eq 'launch-supervisor') {
    @{ processId = [BridgeSandbox]::LaunchSupervisor($request.helper, $request.supervisorRequest, $request.cwd) } | ConvertTo-Json -Compress
  } elseif ($request.operation -eq 'sid') {
    @{ sid = [BridgeSandbox]::Sid($request.name) } | ConvertTo-Json -Compress
  } elseif ($request.operation -eq 'existing-profile') {
    $sid = [BridgeSandbox]::Sid($request.name)
    $key = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings\' + $sid
    if (-not (Test-Path -LiteralPath $key)) { throw 'AppContainer profile is not already provisioned' }
    $mapping = Get-ItemProperty -LiteralPath $key
    if ($mapping.Moniker -ine $request.name) { throw 'AppContainer profile moniker mismatch' }
    @{ sid = $sid; existing = $true } | ConvertTo-Json -Compress
  } elseif ($request.operation -eq 'workspace-owner') {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = [System.IO.Directory]::GetAccessControl([BridgeSandbox]::FileSystemPath($request.workspace))
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -ne $identity.User.Value) { throw 'Workspace must be owned by the current host user' }
    @{ userSid = $identity.User.Value; ownerSid = $ownerSid } | ConvertTo-Json -Compress
  } elseif ($request.operation -eq 'provision') {
    @{ sid = [BridgeSandbox]::Provision($request.name) } | ConvertTo-Json -Compress
  } elseif ($request.operation -eq 'host-run' -and $request.hostCoordinator -eq $true) {
    $receipt = [BridgeSandbox]::RunHost($request.executable, [string[]]$request.arguments, $request.workspace, $request.stdout, $request.stderr, $request.parentId, $request.timeoutMs, $request.stop, $request.nodeDirectory)
    [System.IO.File]::WriteAllText([BridgeSandbox]::FileSystemPath($request.receipt), $receipt, (New-Object System.Text.UTF8Encoding($false)))
  } elseif ($request.operation -eq 'run') {
    [BridgeSandbox]::Run($request.name, $request.executable, [string[]]$request.arguments, $request.workspace, $request.stdout, $request.stderr, $request.parentId, $request.timeoutMs, ($request.internetClient -eq $true), $request.nodeDirectory)
  } elseif ($request.operation -eq 'interactive') {
    $receipt = [BridgeSandbox]::RunInteractive($request.name, $request.executable, [string[]]$request.arguments, $request.workspace, $request.stdout, $request.stderr, $request.parentId, $request.timeoutMs, $request.stdin, $request.stop, ($request.internetClient -eq $true), $request.nodeDirectory)
    [System.IO.File]::WriteAllText([BridgeSandbox]::FileSystemPath($request.receipt), $receipt, (New-Object System.Text.UTF8Encoding($false)))
  } else { throw 'Unknown sandbox operation' }
} catch {
  $failure = $_.Exception.GetBaseException()
  @{ code='SANDBOX_UNAVAILABLE'; detail=$failure.Message; nativeError=$failure.NativeErrorCode } | ConvertTo-Json -Compress
  exit 1
}
