# 创建桌面快捷方式：绿色启动方式。
# 直接驱动已就绪且被系统信任的 node_modules/electron/dist/electron.exe 加载本项目，
# 零复制、零重命名，避免安全软件对新建未签名 exe 的隔离。
# 双击桌面「Token 记录」即弹出悬浮窗，显示品牌图标。

$root = Split-Path -Parent $PSScriptRoot
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$iconPath = Join-Path $root 'build\icon.ico'

if (-not (Test-Path $electronExe)) {
  Write-Error '未找到 Electron 运行时，请先执行 npm install。'
  exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Token 记录.lnk'

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $electronExe
# 参数为项目根目录，Electron 据此加载 package.json 的入口 main。
$lnk.Arguments = '"' + $root + '"'
$lnk.WorkingDirectory = $root
if (Test-Path $iconPath) { $lnk.IconLocation = $iconPath }
$lnk.Description = 'Token 消耗与花费监控悬浮窗（Claude Code / Codex / Grok Build）'
$lnk.WindowStyle = 7  # 最小化启动控制台（Electron 为窗口程序，实际无控制台）
$lnk.Save()

Write-Output ('已创建桌面快捷方式：' + $lnkPath)
