param(
  [int]$Port = 4173
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

Write-Host "Web Ham Logger running at http://localhost:$Port"
Write-Host "[note] static files only - /api/* is not implemented here, so callsign"
Write-Host "       lookup, LoTW and satellite TLE fetch will not work. Use"
Write-Host "       'npm start' (server.js) for the full server."

# This table is now an ALLOWLIST, not just a lookup: anything without an entry
# is refused. It has to cover every type the app actually loads -- .webmanifest
# and .mjs were missing, and would have started 404ing once the fallback stopped
# serving unknown extensions as octet-stream.
$mimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"
  ".mjs" = "text/javascript; charset=utf-8"
  ".css" = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".webmanifest" = "application/manifest+json; charset=utf-8"
  ".wasm" = "application/wasm"
  ".svg" = "image/svg+xml"
  ".png" = "image/png"
  ".jpg" = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif" = "image/gif"
  ".webp" = "image/webp"
  ".ico" = "image/x-icon"
  ".woff" = "font/woff"
  ".woff2" = "font/woff2"
  ".ttf" = "font/ttf"
  ".txt" = "text/plain; charset=utf-8"
  ".map" = "application/json; charset=utf-8"
}

function Get-ReasonPhrase($statusCode) {
  switch ($statusCode) {
    200 { "OK" }
    404 { "Not Found" }
    default { "OK" }
  }
}

function Write-Response($stream, $statusCode, $contentType, [byte[]]$bodyBytes) {
  $writer = [System.IO.StreamWriter]::new($stream, [System.Text.Encoding]::ASCII, 1024, $true)
  $writer.NewLine = "`r`n"
  $writer.WriteLine("HTTP/1.1 $statusCode $(Get-ReasonPhrase $statusCode)")
  $writer.WriteLine("Content-Type: $contentType")
  $writer.WriteLine("Content-Length: $($bodyBytes.Length)")
  $writer.WriteLine("Cache-Control: no-cache")
  # Same security headers server.js sends. This fallback had none, so following
  # the PowerShell instruction in the README ran the app with no CSP at all.
  # Keep in sync with SECURITY_HEADERS in server.js; the script-src hash covers
  # index.html's inline theme bootstrap.
  $writer.WriteLine("X-Content-Type-Options: nosniff")
  $writer.WriteLine("X-Frame-Options: SAMEORIGIN")
  $writer.WriteLine("Referrer-Policy: strict-origin-when-cross-origin")
  $writer.WriteLine("Permissions-Policy: geolocation=(self), microphone=(self), camera=(), payment=(), usb=(self), interest-cohort=()")
  $csp = @(
    "default-src 'self'",
    "script-src 'self' 'sha256-PxYpOAntedsUntWSVSNJ8tkM00yECRo0ccasTNtMyaI=' 'wasm-unsafe-eval' https://unpkg.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
    "connect-src 'self' https://api.pota.app https://api.sotl.as https://api.allorigins.win wss://mqtt.pskreporter.info:1886 ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ) -join "; "
  $writer.WriteLine("Content-Security-Policy: $csp")
  $writer.WriteLine("Connection: close")
  $writer.WriteLine()
  $writer.Flush()
  $stream.Write($bodyBytes, 0, $bodyBytes.Length)
  $stream.Flush()
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()

    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)
      $requestLine = $reader.ReadLine()

      if (-not $requestLine) {
        continue
      }

      while ($reader.ReadLine()) {
      }

      $parts = $requestLine.Split(" ")
      $method = $parts[0]
      $path = if ($parts.Length -ge 2) { $parts[1] } else { "/" }

      if ($method -ne "GET") {
        $body = [System.Text.Encoding]::UTF8.GetBytes("Only GET is supported")
        Write-Response $stream 200 "text/plain; charset=utf-8" $body
        continue
      }

      if ($path -eq "/") {
        $path = "/index.html"
      }

      $decodedPath = [System.Uri]::UnescapeDataString($path.Split("?")[0])
      $relative = $decodedPath.TrimStart("/") -replace "/", "\"
      $target = [System.IO.Path]::GetFullPath((Join-Path $root $relative))

      if (-not $target.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
        $body = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        Write-Response $stream 404 "text/plain; charset=utf-8" $body
        continue
      }

      # Extension allowlist, dot-path refusal, and the same server-side files
      # server.js blocks by name. Without these the fallback served every file
      # under the root -- including .git/config and the whole repository history.
      $extension = [System.IO.Path]::GetExtension($target).ToLowerInvariant()
      $contentType = $mimeTypes[$extension]
      $leaf = [System.IO.Path]::GetFileName($target)
      $blocked = @("server.js", "server.pl", "package.json", "package-lock.json")
      if ((-not $contentType) -or ($decodedPath -match "(^|/)\.") -or ($blocked -contains $leaf)) {
        $body = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        Write-Response $stream 404 "text/plain; charset=utf-8" $body
        continue
      }

      $body = [System.IO.File]::ReadAllBytes($target)
      Write-Response $stream 200 $contentType $body
    }
    finally {
      $client.Close()
    }
  }
}
finally {
  $listener.Stop()
}
