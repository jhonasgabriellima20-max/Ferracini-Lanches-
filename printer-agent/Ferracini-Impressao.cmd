@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

:menu
cls
echo ==========================================
echo        FERRACINI - IMPRESSAO AUTOMATICA
echo ==========================================
echo.
echo  [1] Configurar impressora e token
echo  [2] Imprimir teste
echo  [3] Instalar inicio automatico com Windows
echo  [4] Iniciar agente agora
echo  [5] Abrir arquivo de log
echo  [0] Sair
echo.
set /p OP=Escolha uma opcao: 

if "%OP%"=="1" goto setup
if "%OP%"=="2" goto test
if "%OP%"=="3" goto startup
if "%OP%"=="4" goto run
if "%OP%"=="5" goto log
if "%OP%"=="0" goto end
goto menu

:setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0FerraciniPrintAgent.ps1" -Mode Setup
echo.
pause
goto menu

:test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0FerraciniPrintAgent.ps1" -Mode Test
echo.
pause
goto menu

:startup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0FerraciniPrintAgent.ps1" -Mode InstallStartup
echo.
pause
goto menu

:run
echo O agente ficara ativo nesta janela. Para parar, pressione Ctrl+C.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0FerraciniPrintAgent.ps1" -Mode Run
echo.
pause
goto menu

:log
if exist "%~dp0ferracini-print.log" (
  start "" notepad.exe "%~dp0ferracini-print.log"
) else (
  echo Ainda nao existe arquivo de log.
  pause
)
goto menu

:end
endlocal
exit /b 0
