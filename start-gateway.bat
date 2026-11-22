@echo off

chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem agent-gateway 启动脚本（范式照抄 qq-bridge start.bat）
rem
rem 职责：
rem   1. 探测合格的 Node 解释器（package.json engines: >=22.13）
rem   2. 首次运行把 .env.example 复制为 .env（提示补配置）
rem   3. 启动 src/main.mjs；崩溃 5 秒后自动重启
rem   4. --check-node 只打印会用的解释器，不启动
rem ============================================================

set "NODE_EXE="
set "NODE_VER="
set "PROBE_LOG=%TEMP%\_gateway_probe.log"
if exist "%PROBE_LOG%" del "%PROBE_LOG%" >nul 2>&1
>"%PROBE_LOG%" echo.

rem 探测顺序：
rem   1. GATEWAY_NODE 覆盖（运维显式指定）
rem   2. DSH 自带 node（bridge 是 DSH 伴生，这台机器上它必然存在且 >=22）
rem   3. PATH 上每个 node（where 顺序）
rem   4. workbuddy 下载的 runtime
call :probe "%GATEWAY_NODE%"
call :probe "C:\DeepSeekHarness\node\node.exe"
for /f "delims=" %%P in ('where node 2^>nul') do call :probe "%%P"
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do call :probe "%%D\node.exe"

if not defined NODE_EXE (
    echo [ERROR] No usable Node found. Need Node 22+.
    echo.
    echo   Rejected candidates:
    type "%PROBE_LOG%"
    echo.
    echo   Fix any one of these:
    echo     1. install Node 22+
    echo     2. set GATEWAY_NODE to a Node 22+ executable, e.g.
    echo          set GATEWAY_NODE=C:\DeepSeekHarness\node\node.exe
    del "%PROBE_LOG%" >nul 2>&1
    pause
    exit /b 1
)
del "%PROBE_LOG%" >nul 2>&1

rem 复核胜出者（探测通过 != 启动时仍合格）。
"%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] "%NODE_EXE%" passed probing but failed the re-check. Aborting.
    pause
    exit /b 1
)
echo [node] %NODE_VER%  (%NODE_EXE%)

if /i "%~1"=="--check-node" echo RESOLVED %NODE_VER% "%NODE_EXE%"
if /i "%~1"=="--check-node" exit /b 0

rem 首跑：init-env 负责「清理 .env 退役 token 键 + 确保 operator-token / mcp-bus.secret 文件存在」。
rem 幂等：凭据文件已存在且合法不会被覆盖，所以每次启动都可以安全调用。
rem 失败不阻断启动（凭据缺失会在 loadConfig fail-closed 时给出明确文案），只提示。
echo.
"%NODE_EXE%" scripts\init-env.mjs
if errorlevel 1 echo [env] init-env 失败（忽略，继续启动；可手工运行 npm run env:init 排查）。
echo.

rem 把选中解释器放 PATH 最前，子进程（mcp-bus 等）继承同一版本。
for %%I in ("%NODE_EXE%") do set "PATH=%%~dpI;%PATH%"

:loop
"%NODE_EXE%" src\main.mjs
set code=%errorlevel%
echo [%date% %time%] gateway exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop

rem ---- 子程序：验收 %1 为解释器，不合格记入 PROBE_LOG ----
:probe
if defined NODE_EXE goto :eof
if "%~1"=="" goto :eof
if not exist "%~1" goto :eof
set "CAND_VER=?"
"%~1" -v > "%TEMP%\_gateway_ver.txt" 2>nul
set /p CAND_VER=<"%TEMP%\_gateway_ver.txt"
del "%TEMP%\_gateway_ver.txt" >nul 2>&1
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>&1
if errorlevel 1 goto :probe_reject
set "NODE_EXE=%~1"
set "NODE_VER=%CAND_VER%"
goto :eof

:probe_reject
>>"%PROBE_LOG%" echo   - [%CAND_VER%] "%~1"
goto :eof
