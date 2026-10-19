@echo off
setlocal
chcp 65001 >nul
title Ferracini - Atualizador da Comanda Universal
echo ========================================================
echo           FERRACINI LANCHES - COMANDA UNIVERSAL
echo ========================================================
echo.
echo Instala um modelo para marmitex, lanches, doces,
echo sobremesas e bebidas na Bematech existente.
echo Preserva config.json, token.dat, log e impressora.
echo.
set "FERRACINI_AGENT=C:\FerraciniPrintAgent\FerraciniPrintAgent.ps1"
if not exist "%FERRACINI_AGENT%" (
  echo ERRO: Nao encontrei %FERRACINI_AGENT%
  echo Consulte a pasta de instalacao da Bematech antes de continuar.
  pause
  exit /b 1
)
echo Pare a impressao automatica no notebook antes da atualizacao.
echo Pedidos antigos nao serao reimpressos ou apagados por este programa.
echo.
choice /C SN /M "Deseja atualizar somente o modelo da comanda"
if errorlevel 2 exit /b 0

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $p=$env:FERRACINI_AGENT; $tmp=$p+'.novaversao'; $backup=$p+'.backup.'+(Get-Date -Format 'yyyyMMdd-HHmmss'); [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/jhonasgabriellima20-max/Ferracini-Lanches-/main/printer-agent/FerraciniPrintAgent.ps1' -OutFile $tmp -ErrorAction Stop; if ((Get-Item -LiteralPath $tmp).Length -lt 20000) { throw 'Download incompleto' }; $tokens=$null; $erros=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($tmp,[ref]$tokens,[ref]$erros); if ($erros.Count -gt 0) { throw 'Arquivo recebido contem erro de sintaxe'; }; $conteudo=Get-Content -LiteralPath $tmp -Raw -Encoding UTF8; if (!$conteudo.Contains('function Item-Label') -or !$conteudo.Contains('Taxa de entrega:')) { throw 'Versao incorreta da comanda'; }; Copy-Item -LiteralPath $p -Destination $backup -ErrorAction Stop; try { Copy-Item -LiteralPath $tmp -Destination $p -Force -ErrorAction Stop; } catch { Copy-Item -LiteralPath $backup -Destination $p -Force -ErrorAction SilentlyContinue; throw; }; Write-Host ('Modelo atualizado com sucesso. Backup: '+$backup) -ForegroundColor Green; } catch { Write-Host ('Falha: '+$_.Exception.Message) -ForegroundColor Red; exit 1; } finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue; }"
if errorlevel 1 (
  echo.
  echo Atualizacao NAO concluida. O modelo anterior foi preservado ou ha backup.
  pause
  exit /b 1
)
echo.
echo Modelo instalado. Reinicie o agente para carregar a versao nova.
echo Depois, no Ferracini-Impressao.cmd, escolha a opcao 2.
echo Serao impressas DUAS comandas de TESTE: entrega e mesa.
echo Elas nao criam pedido real nem modificam a fila.
echo.
pause
endlocal
exit /b 0
