# Deploy the arcade to CT 112 (arcade, 10.0.0.153) through the Proxmox host.
# Needs: tar, scp, ssh with a key for root@server. Undo: pct snapshot 112 <name> before, pct rollback 112 <name> after.
$ErrorActionPreference = 'Stop'
$ssh = @('-o', 'HostKeyAlias=server')
$tar = Join-Path $env:TEMP 'arcade.tar'
Push-Location $PSScriptRoot
try {
  tar -cf $tar --exclude=.git --exclude=node_modules --exclude=*.test.mjs --exclude=package.json --exclude=README.md --exclude=deploy.ps1 --exclude=.gitignore .
  scp @ssh -q $tar server:/tmp/arcade.tar
  ssh @ssh server "pct push 112 /tmp/arcade.tar /tmp/arcade.tar && pct exec 112 -- bash -c 'rm -rf /var/www/arcade.new && mkdir -p /var/www/arcade.new && tar -xf /tmp/arcade.tar -C /var/www/arcade.new --no-same-owner && chmod -R a+rX /var/www/arcade.new && rm -rf /var/www/arcade.old && mv /var/www/arcade /var/www/arcade.old && mv /var/www/arcade.new /var/www/arcade && rm -rf /var/www/arcade.old /tmp/arcade.tar' && rm /tmp/arcade.tar"
  $code = ssh @ssh server "curl -s -o /dev/null -w '%{http_code}' http://10.0.0.153/game/"
  Write-Host "Deployed. CT 112 /game/ -> HTTP $code"
} finally { Pop-Location; Remove-Item $tar -ErrorAction SilentlyContinue }
