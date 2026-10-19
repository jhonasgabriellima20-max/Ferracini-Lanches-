@echo off
setlocal
chcp 65001 >nul
title Ferracini - Atualizar comanda da Bematech
set "BASE=C:\FerraciniPrintAgent"
set "ORIGEM=%~dp0FerraciniPrintAgent.ps1"
set "DESTINO=%BASE%\FerraciniPrintAgent.ps1"
set "BACKUP=%DESTINO%.backup-antes-doces-sobremesas"
echo =====================================================
echo     FERRACINI - COMANDA UNICA DA BEMATECH
echo =====================================================
echo Marmitex Mini e Media + lanches + doces + sobremesas
echo Taxa de entrega, taxa de servico, emojis e negrito
echo.
if not exist "%ORIGEM%" (
  echo ERRO: Baixe FerraciniPrintAgent.ps1 junto deste atualizador.
  pause
  exit /b 1
)
if not exist "%DESTINO%" (
  echo ERRO: Instalacao existente nao encontrada em %BASE%.
  echo Nenhuma configuracao foi alterada.
  pause
  exit /b 1
)
echo A atualizacao troca APENAS o script de impressao.
echo Configuracoes, token, fila e logs serao preservados.
echo O agente atual deve ser reiniciado depois da atualizacao.
echo.
choice /C SN /M "Confirma a atualizacao"
if errorlevel 2 (
  echo Cancelado.
  exit /b 0
)
copy /Y "%DESTINO%" "%BACKUP%" >nul
if errorlevel 1 (
  echo ERRO ao fazer backup. Atualizacao cancelada.
  pause
  exit /b 1
)
copy /Y "%ORIGEM%" "%DESTINO%" >nul
if errorlevel 1 (
  echo ERRO na copia. Tentando restaurar backup...
  copy /Y "%BACKUP%" "%DESTINO%" >nul
  pause
  exit /b 1
)
fc /B "%ORIGEM%" "%DESTINO%" >nul
if errorlevel 1 (
  echo ERRO na verificacao. Tentando restaurar backup...
  copy /Y "%BACKUP%" "%DESTINO%" >nul
  pause
  exit /b 1
)
echo.
echo OK: nova comanda copiada e verificada.
echo Backup: %BACKUP%
echo Agora REINICIE o agente ou notebook antes de atender pedidos.
echo Abra o Ferracini-Impressao.cmd que ja existia na instalacao.
echo Use a opcao 2 para imprimir uma comanda de TESTE.
echo A comanda de teste NAO entra na fila de pedidos reais.
echo.
pause
endlocal
exit /b 0
