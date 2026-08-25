#!/usr/bin/env perl

use strict;
use warnings;
use Cwd qw(abs_path);
use File::Basename qw(dirname);
use File::Spec;
use IO::Handle;
use IO::Socket::INET;

# STATIC FILES ONLY. This is the dependency-free fallback for machines without
# Node; it serves the app but implements none of the /api/* endpoints, so
# callsign lookup, LoTW download/upload and the satellite TLE fetch all fail
# against it. `npm start` (server.js) is the full server. Startup says so below
# rather than leaving it to be discovered when a lookup silently does nothing.
my $port = $ENV{PORT} || shift || 4173;
my $root = abs_path(dirname(__FILE__));

my %mime_types = (
  ".html" => "text/html; charset=utf-8",
  ".js"   => "application/javascript; charset=utf-8",
  ".css"  => "text/css; charset=utf-8",
  ".json" => "application/json; charset=utf-8",
  ".mjs"  => "text/javascript; charset=utf-8",
  ".webmanifest" => "application/manifest+json; charset=utf-8",
  ".woff2" => "font/woff2",
  ".woff" => "font/woff",
  ".jpg"  => "image/jpeg",
  ".jpeg" => "image/jpeg",
  ".gif"  => "image/gif",
  ".webp" => "image/webp",
  ".txt"  => "text/plain; charset=utf-8",
  ".wasm" => "application/wasm",
  ".svg"  => "image/svg+xml",
  ".png"  => "image/png",
  ".ico"  => "image/x-icon",
);

my $server = IO::Socket::INET->new(
  LocalAddr => "127.0.0.1",
  LocalPort => $port,
  Proto     => "tcp",
  Listen    => 10,
  ReuseAddr => 1,
) or die "Unable to bind to port $port: $!";

print "Web Ham Logger running at http://localhost:$port\n";
print "[note] static files only - /api/* is not implemented here, so callsign\n";
print "       lookup, LoTW and satellite TLE fetch will not work. Use\n";
print "       'npm start' (server.js) for the full server.\n";

while (my $client = $server->accept()) {
  $client->autoflush(1);

  my $request_line = <$client>;
  unless (defined $request_line) {
    close $client;
    next;
  }

  $request_line =~ s/\r?\n$//;
  while (my $header = <$client>) {
    last if $header =~ /^\r?\n$/;
  }

  my ($method, $path) = split /\s+/, $request_line;
  if (!$method || $method ne "GET") {
    write_response($client, 405, "text/plain; charset=utf-8", "Only GET is supported");
    close $client;
    next;
  }

  $path = "/" unless defined $path && length $path;
  $path = "/index.html" if $path eq "/";
  $path =~ s/\?.*$//;
  $path = uri_unescape($path);

  my @segments = grep { length $_ && $_ ne "." && $_ ne ".." } split m{/+}, $path;

  # Refuse dot-directories and dotfiles. Without this the server happily handed
  # out /.git/config and the rest of the repository history to anything that
  # asked -- it had no extension allowlist either, so every file under the root
  # was fetchable. server.js has always restricted itself to known types; this
  # brings the fallback in line.
  for my $segment (@segments) {
    if ($segment =~ /^\./) {
      write_response($client, 404, "text/plain; charset=utf-8", "Not found");
      close $client;
      next;
    }
  }

  my $target = @segments
    ? File::Spec->catfile($root, @segments)
    : File::Spec->catfile($root, "index.html");
  my $resolved = abs_path($target);

  if (!$resolved || index($resolved, $root) != 0 || !-f $resolved) {
    write_response($client, 404, "text/plain; charset=utf-8", "Not found");
    close $client;
    next;
  }

  my ($extension) = $resolved =~ /(\.[^.\/\\]+)$/;
  $extension = lc($extension || "");
  my $basename = (File::Spec->splitpath($resolved))[2];

  # Extension allowlist + the same server-side files server.js blocks by name.
  if (!exists $mime_types{$extension}
      || $basename eq "server.js" || $basename eq "server.pl"
      || $basename eq "package.json" || $basename eq "package-lock.json") {
    write_response($client, 404, "text/plain; charset=utf-8", "Not found");
    close $client;
    next;
  }

  my $fh;
  if (!open $fh, "<:raw", $resolved) {
    write_response($client, 500, "text/plain; charset=utf-8", "Server error");
    close $client;
    next;
  }

  local $/;
  my $body = <$fh>;
  close $fh;

  write_response($client, 200, $mime_types{$extension}, $body);
  close $client;
}

sub uri_unescape {
  my ($value) = @_;
  $value =~ s/\+/ /g;
  $value =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/eg;
  return $value;
}

sub write_response {
  my ($client, $status, $content_type, $body) = @_;
  my %reason = (
    200 => "OK",
    404 => "Not Found",
    405 => "Method Not Allowed",
    500 => "Server Error",
  );
  my $reason = $reason{$status} || "OK";
  my $length = length($body);

  print $client "HTTP/1.1 $status $reason\r\n";
  print $client "Content-Type: $content_type\r\n";
  print $client "Content-Length: $length\r\n";
  print $client "Cache-Control: no-cache\r\n";
  # Same security headers server.js sends. This fallback had none at all, so
  # anyone following the ./start-server.sh path in the README was running the app
  # with no CSP whatsoever — the weakest configuration, reached by the most
  # convenient-looking instruction. Keep in sync with SECURITY_HEADERS in
  # server.js; the CSP hash covers index.html's inline theme bootstrap.
  print $client "X-Content-Type-Options: nosniff\r\n";
  print $client "X-Frame-Options: SAMEORIGIN\r\n";
  print $client "Referrer-Policy: strict-origin-when-cross-origin\r\n";
  print $client "Permissions-Policy: geolocation=(self), microphone=(self), camera=(), payment=(), usb=(self), interest-cohort=()\r\n";
  print $client "Content-Security-Policy: "
    . "default-src 'self'; "
    . "script-src 'self' 'sha256-PxYpOAntedsUntWSVSNJ8tkM00yECRo0ccasTNtMyaI=' 'wasm-unsafe-eval' https://unpkg.com https://cdnjs.cloudflare.com; "
    . "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; "
    . "font-src 'self' https://fonts.gstatic.com; "
    . "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com; "
    . "connect-src 'self' https://api.pota.app https://api.sotl.as https://api.allorigins.win wss://mqtt.pskreporter.info:1886 ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*; "
    . "media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; "
    . "base-uri 'self'; form-action 'self'; frame-ancestors 'none'\r\n";
  print $client "Connection: close\r\n";
  print $client "\r\n";
  print $client $body;
}
