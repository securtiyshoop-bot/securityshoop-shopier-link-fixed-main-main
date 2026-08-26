param(
    [string]$ZipUrl = "https://securityshoop.vercel.app/securityshoop-plugin.zip",
    [string]$FolderName = "luatools",
    [string]$PluginId = "luatools"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Net.Http

function Write-Step {
    param([string]$Message)
    Write-Host "[SecurityShoop] $Message" -ForegroundColor Cyan
}

function Stop-SteamFully {
    Write-Step "Stopping Steam"
    $names = @("steam", "steamwebhelper", "GameOverlayUI", "steamerrorreporter")
    foreach ($name in $names) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 30; $i++) {
        $stillRunning = Get-Process -Name steam,steamwebhelper,GameOverlayUI -ErrorAction SilentlyContinue
        if (-not $stillRunning) { return }
        Start-Sleep -Milliseconds 300
        foreach ($proc in $stillRunning) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
    throw "Steam kapanmadi. Steam'i tamamen kapatip kurulumu tekrar calistir."
}

function Get-SteamPath {
    $registries = @(
        "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam",
        "HKLM:\SOFTWARE\Valve\Steam",
        "HKCU:\SOFTWARE\Valve\Steam"
    )

    foreach ($reg in $registries) {
        if (-not (Test-Path $reg)) { continue }
        $path = (Get-ItemProperty -Path $reg -Name "InstallPath" -ErrorAction SilentlyContinue).InstallPath
        if ($path -and (Test-Path (Join-Path $path "steam.exe"))) {
            return $path
        }
    }

    throw "Steam install folder was not found."
}

function Assert-ChildPath {
    param([string]$Parent, [string]$Child)
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $childFull = [System.IO.Path]::GetFullPath($Child)
    if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe target path blocked: $childFull"
    }
}

function Download-File {
    param([string]$Url, [string]$OutFile)
    $client = [System.Net.Http.HttpClient]::new()
    try {
        $client.Timeout = [System.TimeSpan]::FromSeconds(120)
        $client.DefaultRequestHeaders.UserAgent.ParseAdd("SecurityShoop Installer")
        $stream = $client.GetStreamAsync($Url).Result
        try {
            $fileStream = [System.IO.File]::Create($OutFile)
            try {
                $stream.CopyTo($fileStream)
            }
            finally {
                $fileStream.Dispose()
            }
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $client.Dispose()
    }
}

function Download-Text {
    param([string]$Url)
    $client = [System.Net.Http.HttpClient]::new()
    try {
        $client.Timeout = [System.TimeSpan]::FromSeconds(120)
        $client.DefaultRequestHeaders.UserAgent.ParseAdd("SecurityShoop Installer")
        return $client.GetStringAsync($Url).Result
    }
    finally {
        $client.Dispose()
    }
}

function Test-Steamtools {
    param([string]$SteamPath)
    foreach ($file in @("dwmapi.dll", "xinput1_4.dll")) {
        if (Test-Path (Join-Path $SteamPath $file)) {
            return $true
        }
    }
    return $false
}

function Install-Steamtools {
    param([string]$SteamPath)

    Write-Step "Installing Steamtools"
    $steamtoolsUrl = "https://luatools.vercel.app/st.ps1"
    $raw = Download-Text -Url $steamtoolsUrl
    if (-not $raw) {
        throw "Steamtools installer could not be downloaded."
    }

    $filtered = ($raw -split "`n") | Where-Object {
        ($_ -inotmatch "Start-Process.*steam") -and
        ($_ -inotmatch "steam\.exe") -and
        ($_ -inotmatch "Start-Sleep|Write-Host") -and
        ($_ -inotmatch "cls|exit") -and
        (-not ($_ -imatch "Stop-Process" -and $_ -inotmatch "Get-Process"))
    }
    $scriptBlock = $filtered -join "`n"

    for ($attempt = 1; $attempt -le 5; $attempt++) {
        Write-Step "Steamtools install attempt $attempt"
        Invoke-Expression $scriptBlock
        if (Test-Steamtools -SteamPath $SteamPath) {
            Write-Step "Steamtools installed"
            return
        }
        Start-Sleep -Seconds 1
    }

    throw "Steamtools installation failed. Run PowerShell as Administrator and try again."
}

function Test-Millennium {
    param([string]$SteamPath)
    foreach ($file in @("millennium.dll", "python311.dll")) {
        if (-not (Test-Path (Join-Path $SteamPath $file))) {
            return $false
        }
    }
    return $true
}

function Install-Millennium {
    param([string]$SteamPath)

    Write-Step "Installing Millennium"
    $millenniumUrl = "https://clemdotla.github.io/millennium-installer-ps1/millennium.ps1"
    $tempInstaller = Join-Path $env:TEMP "securityshoop-millennium-installer.ps1"

    Download-File -Url $millenniumUrl -OutFile $tempInstaller
    if (-not (Test-Path $tempInstaller)) {
        throw "Millennium installer could not be downloaded."
    }

    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tempInstaller -NoLog -DontStart -SteamPath $SteamPath
    }
    finally {
        Remove-Item -LiteralPath $tempInstaller -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Millennium -SteamPath $SteamPath)) {
        throw "Millennium installation failed. Run PowerShell as Administrator and try again."
    }
}

$steamPath = Get-SteamPath
$millenniumDir = Join-Path $steamPath "millennium"
$pluginsDir = Join-Path $millenniumDir "plugins"
$targetDir = Join-Path $pluginsDir $FolderName
$oldLuatoolsDir = Join-Path $pluginsDir "luatools"
$zipPath = Join-Path $env:TEMP "securityshoop-plugin.zip"

Stop-SteamFully

if (-not (Test-Steamtools -SteamPath $steamPath)) {
    Install-Steamtools -SteamPath $steamPath
} else {
    Write-Step "Steamtools already installed"
}

if (-not (Test-Millennium -SteamPath $steamPath)) {
    Install-Millennium -SteamPath $steamPath
} else {
    Write-Step "Millennium already installed"
}

Write-Step "Downloading SecurityShoop plugin"
Download-File -Url $ZipUrl -OutFile $zipPath
if (-not (Test-Path $zipPath)) {
    throw "Plugin ZIP could not be downloaded."
}

Write-Step "Preparing plugin folder"
New-Item -Path $pluginsDir -ItemType Directory -Force | Out-Null
Assert-ChildPath -Parent $pluginsDir -Child $targetDir
Assert-ChildPath -Parent $pluginsDir -Child $oldLuatoolsDir

$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entries = @($zip.Entries | Where-Object { $_.FullName -and -not $_.FullName.EndsWith("/") -and -not $_.FullName.EndsWith("\") })
    if ($entries.Count -eq 0) { throw "Plugin ZIP is empty." }

    $rootPrefix = "$FolderName/"
    $hasSecurityShoopRoot = $entries | Where-Object { $_.FullName.Replace('\','/').StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    $destinationRoot = if ($hasSecurityShoopRoot) { $pluginsDir } else { $targetDir }

    if (Test-Path $targetDir) {
        Write-Step "Removing old SecurityShoop folder"
        Remove-Item -LiteralPath $targetDir -Recurse -Force
    }
    if ((Test-Path $oldLuatoolsDir) -and ($oldLuatoolsDir -ne $targetDir)) {
        Write-Step "Removing old luatools folder"
        Remove-Item -LiteralPath $oldLuatoolsDir -Recurse -Force
    }

    Write-Step "Extracting plugin"
    foreach ($entry in $entries) {
        $relative = $entry.FullName.Replace('\','/')
        if ($relative.Contains("../") -or $relative.StartsWith("/")) {
            throw "Unsafe ZIP path blocked: $relative"
        }

        $dest = Join-Path $destinationRoot $relative
        Assert-ChildPath -Parent $pluginsDir -Child $dest
        $parent = Split-Path $dest -Parent
        New-Item -Path $parent -ItemType Directory -Force | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
    }
}
finally {
    $zip.Dispose()
}

Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue

$configDir = Join-Path $millenniumDir "config"
$configPath = Join-Path $configDir "config.json"
New-Item -Path $configDir -ItemType Directory -Force | Out-Null

if (Test-Path $configPath) {
    $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    $config = [pscustomobject]@{}
}

if (-not $config.plugins) {
    $config | Add-Member -MemberType NoteProperty -Name "plugins" -Value ([pscustomobject]@{ enabledPlugins = @() }) -Force
}
if (-not $config.plugins.enabledPlugins) {
    $config.plugins | Add-Member -MemberType NoteProperty -Name "enabledPlugins" -Value @() -Force
}

$enabled = @($config.plugins.enabledPlugins)
if ($enabled -notcontains $PluginId) {
    $enabled += $PluginId
    $config.plugins.enabledPlugins = $enabled
}
$config | ConvertTo-Json -Depth 20 | Set-Content $configPath -Encoding UTF8

Write-Step "Plugin enabled"
Write-Step "Starting Steam"
Start-Process (Join-Path $steamPath "steam.exe")
Write-Host "Done." -ForegroundColor Green
