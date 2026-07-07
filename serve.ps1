$Port = 8080
$Public = $args[0] -eq "-Public"
$Force = $args -contains "-Force"
$Root = $PSScriptRoot

if (-not (Test-Path (Join-Path $Root "index.html"))) {
    Write-Host ""
    Write-Host "  [ERROR] index.html not found"
    Write-Host "  Game root: $Root"
    Write-Host "  Run serve.bat inside the game folder."
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

function Test-PortFree([int]$p) {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $p)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) {
            try { $listener.Stop() } catch {}
        }
    }
}

if (-not (Test-PortFree $Port)) {
    if ($Force) {
        $procIds = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
        foreach ($procId in $procIds) {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 600
    }
    if (-not (Test-PortFree $Port)) {
        Write-Host ""
        Write-Host "  [ERROR] Port $Port is already in use."
        Write-Host "  Close other server windows, then run start-all.bat again."
        Write-Host "  Check: netstat -ano | findstr :$Port"
        Write-Host ""
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "  Released old process on port $Port."
}

Write-Host ""
Write-Host "  Tanqi Wenji - Online Edition"
Write-Host "  Root: $Root"
Write-Host "  Open: http://127.0.0.1:${Port}/"
Write-Host ""

if ($Public) {
    $t = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($t) {
        Write-Host "Starting cloudflared tunnel..."
        Start-Process -FilePath python -ArgumentList @(
            "-m", "http.server", $Port, "--bind", "0.0.0.0", "--directory", $Root
        ) -WorkingDirectory $Root -WindowStyle Minimized
        Start-Sleep -Seconds 1
        cloudflared tunnel --url "http://127.0.0.1:${Port}"
        exit
    }
    Write-Host "cloudflared not found. Install: winget install Cloudflare.cloudflared"
    Write-Host "Then re-run: serve-public.bat"
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Press Ctrl+C to stop."
& python -m http.server $Port --bind 0.0.0.0 --directory $Root
