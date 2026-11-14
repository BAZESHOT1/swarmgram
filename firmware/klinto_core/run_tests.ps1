# Host-тесты для Windows. Сначала используется zig (без Visual Studio),
# затем g++, если он есть в PATH.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$zig = $env:ZIG_EXE
if (-not $zig) {
  $zig = Join-Path $env:LOCALAPPDATA 'zig\zig-windows-x86_64-0.13.0\zig.exe'
}
if (-not (Test-Path $zig)) { $zig = $null }

$core = @(
  'src/klinto_util.cpp', 'src/klinto_config.cpp', 'src/klinto_packet.cpp',
  'src/klinto_codec.cpp', 'src/klinto_crypto.cpp', 'src/klinto_dedup.cpp',
  'src/klinto_router.cpp', 'src/klinto_flash_queue.cpp', 'src/klinto_net.cpp',
  'src/klinto_channel_plan.cpp', 'src/klinto_cell.cpp',
  'src/klinto_gateway.cpp', 'src/klinto_bridge.cpp',
  'src/klinto_ota.cpp', 'src/klinto_ota_patcher.cpp', 'src/klinto_owner.cpp'
)

if ($zig) {
  Write-Host "Using zig: $zig"
  & $zig cc -O2 -I include -c src/unishox2.c -o unishox2.o
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $zig c++ -std=c++11 -O2 -Wall -Wextra -Wno-unused-parameter -I include -I src `
    test/test_core.cpp @core unishox2.o -o test_core.exe
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Host 'zig not found, trying g++'
  gcc -O2 -I include -c src/unishox2.c -o unishox2.o
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  g++ -std=c++11 -O2 -Wall -Wextra -Wno-unused-parameter -I include -I src `
    test/test_core.cpp @core unishox2.o -o test_core.exe
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

./test_core.exe
exit $LASTEXITCODE
