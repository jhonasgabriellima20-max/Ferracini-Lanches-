param(
  [ValidateSet('Run','Setup','Test','InstallStartup')]
  [string]$Mode = 'Run'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptPath = $PSCommandPath
$BaseDir = Split-Path -Parent $ScriptPath
$ConfigPath = Join-Path $BaseDir 'config.json'
$TokenPath = Join-Path $BaseDir 'token.dat'
$LogPath = Join-Path $BaseDir 'ferracini-print.log'
$SitePadrao = 'https://ferracinilanches.com.br'
$MutexName = 'Local\FerraciniPrintAgent'

function Write-Log([string]$Message, [string]$Level = 'INFO') {
  try {
    if (Test-Path $LogPath) {
      $file = Get-Item $LogPath -ErrorAction SilentlyContinue
      if ($file -and $file.Length -gt 2MB) {
        Move-Item $LogPath ($LogPath + '.1') -Force
      }
    }
    $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
  } catch {}
}

function Read-Config {
  if (-not (Test-Path $ConfigPath)) {
    throw 'Configuracao nao encontrada. Execute primeiro com -Mode Setup.'
  }
  $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $cfg.siteUrl -or -not $cfg.printerName) {
    throw 'Configuracao incompleta. Execute novamente com -Mode Setup.'
  }
  return $cfg
}

function Get-AgentToken {
  if (-not (Test-Path $TokenPath)) {
    throw 'Token do agente nao encontrado. Execute primeiro com -Mode Setup.'
  }
  try {
    $secure = (Get-Content $TokenPath -Raw -Encoding UTF8).Trim() | ConvertTo-SecureString
    $cred = [System.Management.Automation.PSCredential]::new('FerraciniAgent', $secure)
    return $cred.GetNetworkCredential().Password
  } catch {
    throw 'Nao foi possivel abrir o token. Configure novamente usando o mesmo usuario do Windows que executara o agente.'
  }
}

function Save-AgentToken {
  $secure = Read-Host 'Cole o PRINT_AGENT_TOKEN da Vercel' -AsSecureString
  if ($secure.Length -lt 20) {
    throw 'Token muito curto. Use um token forte, com pelo menos 20 caracteres.'
  }
  $encrypted = $secure | ConvertFrom-SecureString
  Set-Content -Path $TokenPath -Value $encrypted -Encoding UTF8
}

function Get-PrinterNames {
  try {
    return @(Get-Printer -ErrorAction Stop | Sort-Object Name | Select-Object -ExpandProperty Name)
  } catch {
    throw 'O Windows nao conseguiu listar as impressoras. Instale o driver da impressora primeiro.'
  }
}

function Setup-Agent {
  Write-Host ''
  Write-Host '=== Ferracini Lanches - Configuracao da impressao ===' -ForegroundColor Yellow
  Write-Host ''

  $printers = Get-PrinterNames
  if ($printers.Count -eq 0) {
    throw 'Nenhuma impressora instalada. Instale o driver e tente novamente.'
  }

  Write-Host 'Impressoras encontradas:' -ForegroundColor Cyan
  for ($i = 0; $i -lt $printers.Count; $i++) {
    Write-Host ("[{0}] {1}" -f ($i + 1), $printers[$i])
  }

  do {
    $choice = Read-Host 'Digite o numero da impressora que recebera as comandas'
    $index = 0
    $ok = [int]::TryParse([string]$choice, [ref]$index) -and $index -ge 1 -and $index -le $printers.Count
  } until ($ok)

  $printerName = $printers[$index - 1]

  $pollInput = Read-Host 'Intervalo de consulta em segundos [5]'
  $pollValue = 0
  if (-not [int]::TryParse([string]$pollInput, [ref]$pollValue) -or $pollValue -lt 3 -or $pollValue -gt 60) {
    $pollValue = 5
  }

  $widthInput = Read-Host 'Largura aproximada da comanda em caracteres [42]'
  $widthValue = 0
  if (-not [int]::TryParse([string]$widthInput, [ref]$widthValue) -or $widthValue -lt 30 -or $widthValue -gt 64) {
    $widthValue = 42
  }

  $config = [ordered]@{
    siteUrl = $SitePadrao
    printerName = $printerName
    pollSeconds = $pollValue
    paperWidthChars = $widthValue
  }
  $config | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
  Save-AgentToken

  Write-Log "Agente configurado para impressora: $printerName"
  Write-Host ''
  Write-Host "Configuracao salva. Impressora: $printerName" -ForegroundColor Green
  Write-Host 'O token foi salvo criptografado para este usuario do Windows.' -ForegroundColor Green
  Write-Host 'Agora execute -Mode Test para imprimir uma comanda de teste.' -ForegroundColor Cyan
}

function Wrap-Text([string]$Text, [int]$Width) {
  $text = ($Text -replace '\s+', ' ').Trim()
  if (-not $text) { return @('') }
  $result = New-Object 'System.Collections.Generic.List[string]'
  while ($text.Length -gt $Width) {
    $startIndex = [Math]::Min($Width, $text.Length - 1)
    $cut = $text.LastIndexOf(' ', $startIndex)
    if ($cut -lt [Math]::Floor($Width * 0.5)) { $cut = $Width }
    $result.Add($text.Substring(0, $cut).Trim())
    $text = $text.Substring($cut).Trim()
  }
  if ($text) { $result.Add($text) }
  return $result.ToArray()
}

function Money([object]$Cents) {
  $value = ([double]$Cents) / 100.0
  return $value.ToString('C2', [Globalization.CultureInfo]::GetCultureInfo('pt-BR'))
}

function Add-WrappedLine($Lines, [string]$Text, [int]$Width, [string]$Prefix = '') {
  $usable = [Math]::Max(10, $Width - $Prefix.Length)
  $wrapped = @(Wrap-Text $Text $usable)
  for ($i = 0; $i -lt $wrapped.Count; $i++) {
    $currentPrefix = $Prefix
    if ($i -gt 0) { $currentPrefix = ' ' * $Prefix.Length }
    $Lines.Add($currentPrefix + $wrapped[$i])
  }
}

function Format-Receipt($Pedido, [int]$Width) {
  $lines = New-Object 'System.Collections.Generic.List[string]'
  $sep = '-' * $Width
  $doubleSep = '=' * $Width

  $lines.Add($doubleSep)
  $lines.Add('FERRACINI LANCHES')
  $lines.Add('COMANDA ' + [string]$Pedido.numero)
  $lines.Add($doubleSep)

  try {
    $dto = [DateTimeOffset]::Parse([string]$Pedido.criadoEm)
    $tz = [TimeZoneInfo]::FindSystemTimeZoneById('E. South America Standard Time')
    $local = [TimeZoneInfo]::ConvertTime($dto, $tz)
    $lines.Add('Data: ' + $local.ToString('dd/MM/yyyy HH:mm:ss'))
  } catch {
    $lines.Add('Data: ' + (Get-Date -Format 'dd/MM/yyyy HH:mm:ss'))
  }

  $tipo = [string]$Pedido.atendimento.tipo
  if ($tipo -eq 'mesa') {
    $lines.Add('ATENDIMENTO: MESA ' + [string]$Pedido.atendimento.mesa)
  } elseif ($tipo -eq 'entrega') {
    $lines.Add('ATENDIMENTO: ENTREGA')
  } else {
    $lines.Add('ATENDIMENTO: RETIRADA')
  }

  $lines.Add($sep)
  $lines.Add('CLIENTE')
  Add-WrappedLine $lines ([string]$Pedido.cliente.nome) $Width
  if ($Pedido.cliente.telefone) { Add-WrappedLine $lines ([string]$Pedido.cliente.telefone) $Width }

  if ($tipo -eq 'entrega') {
    $lines.Add($sep)
    $lines.Add('ENDERECO')
    $end = $Pedido.atendimento.endereco
    Add-WrappedLine $lines (([string]$end.rua) + ', ' + ([string]$end.numero)) $Width
    if ($end.complemento) { Add-WrappedLine $lines ([string]$end.complemento) $Width }
    Add-WrappedLine $lines (([string]$end.bairro) + ' - ' + ([string]$end.cidade)) $Width
    if ($end.cep) { $lines.Add('CEP: ' + [string]$end.cep) }
    if ($Pedido.atendimento.distanciaKm) {
      $lines.Add(('Distancia: {0:N1} km' -f [double]$Pedido.atendimento.distanciaKm))
    }
    if ($Pedido.atendimento.estimativaMinutos) {
      $lines.Add(('Previsao: {0} a {1} min' -f $Pedido.atendimento.estimativaMinutos.minimo, $Pedido.atendimento.estimativaMinutos.maximo))
    }
  }

  $lines.Add($doubleSep)
  $lines.Add('PEDIDO')
  $lines.Add($doubleSep)
  foreach ($item in @($Pedido.itens)) {
    Add-WrappedLine $lines (([string]$item.quantidade) + 'x ' + ([string]$item.nome)) $Width
    foreach ($adicional in @($item.adicionais)) {
      Add-WrappedLine $lines (([string]$adicional.nome) + '  +' + (Money $adicional.precoCentavos)) $Width '  + '
    }
    if ($item.observacao) {
      Add-WrappedLine $lines ([string]$item.observacao) $Width '  OBS: '
    }

    $addonsTotal = 0L
    foreach ($adicional in @($item.adicionais)) {
      $addonsTotal += [int64]$adicional.precoCentavos
    }
    $unit = [int64]$item.precoUnitarioCentavos + $addonsTotal
    $itemTotal = [int64]$item.quantidade * $unit
    $lines.Add('  Total item: ' + (Money $itemTotal))
    $lines.Add($sep)
  }

  $lines.Add('Subtotal: ' + (Money $Pedido.subtotalCentavos))
  if ($tipo -eq 'entrega' -and $Pedido.atendimento.taxaEntregaCentavos) {
    $lines.Add('Entrega:  ' + (Money $Pedido.atendimento.taxaEntregaCentavos))
  }
  $lines.Add('TOTAL:    ' + (Money $Pedido.totalCentavos))
  $lines.Add($doubleSep)

  $pag = [string]$Pedido.pagamento.metodo
  if ($pag -eq 'dinheiro') {
    $lines.Add('PAGAMENTO: DINHEIRO')
    if ($Pedido.pagamento.precisaTroco -and $Pedido.pagamento.trocoParaCentavos) {
      $lines.Add('Troco para: ' + (Money $Pedido.pagamento.trocoParaCentavos))
      $troco = [int64]$Pedido.pagamento.trocoParaCentavos - [int64]$Pedido.totalCentavos
      $lines.Add('Troco:      ' + (Money $troco))
    } else {
      $lines.Add('Sem troco')
    }
  } elseif ($pag -eq 'pix') {
    $lines.Add('PAGAMENTO: PIX')
    $lines.Add('Conferir comprovante no WhatsApp')
  } else {
    $lines.Add('PAGAMENTO: NAO INFORMADO')
  }

  $lines.Add($doubleSep)
  $lines.Add('Pedido recebido pelo sistema Ferracini')
  $lines.Add('')
  $lines.Add('')
  return ($lines -join [Environment]::NewLine)
}

function Send-ToPrinter([string]$Text, [string]$PrinterName) {
  Get-Printer -Name $PrinterName -ErrorAction Stop | Out-Null
  $Text | Out-Printer -Name $PrinterName
}

function Invoke-Api([string]$Method, [string]$Url, [string]$Token, [object]$Body = $null) {
  $headers = @{
    Authorization = "Bearer $Token"
    Accept = 'application/json'
  }
  $params = @{
    Method = $Method
    Uri = $Url
    Headers = $headers
    TimeoutSec = 20
    ErrorAction = 'Stop'
  }
  if ($null -ne $Body) {
    $headers['Content-Type'] = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Depth 12 -Compress)
  }
  return Invoke-RestMethod @params
}

function Update-OrderStatus($Config, [string]$Token, $Pedido, [string]$Status, [string]$Erro = '') {
  $body = @{
    pathname = [string]$Pedido.pathname
    status = $Status
  }
  if ($Erro) {
    $max = [Math]::Min(280, $Erro.Length)
    $body.erro = $Erro.Substring(0, $max)
  }
  Invoke-Api 'PATCH' (([string]$Config.siteUrl).TrimEnd('/') + '/api/pedidos') $Token $body | Out-Null
}

function Print-Test {
  $cfg = Read-Config
  $width = [int]$cfg.paperWidthChars
  $sep = '=' * $width
  $text = @(
    $sep,
    'FERRACINI LANCHES',
    'TESTE DE IMPRESSAO',
    $sep,
    ('Impressora: ' + [string]$cfg.printerName),
    ('Data: ' + (Get-Date -Format 'dd/MM/yyyy HH:mm:ss')),
    '',
    'Se este texto saiu corretamente,',
    'o notebook esta pronto para receber',
    'as comandas automaticas.',
    '',
    $sep,
    '',
    ''
  ) -join [Environment]::NewLine
  Send-ToPrinter $text ([string]$cfg.printerName)
  Write-Host 'Teste enviado para a impressora.' -ForegroundColor Green
  Write-Log 'Comanda de teste enviada para a impressora.'
}

function Install-Startup {
  $null = Read-Config
  $null = Get-AgentToken
  if (-not $ScriptPath) { throw 'Nao foi possivel localizar o arquivo do agente.' }

  $startup = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startup 'Ferracini Print Agent.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`" -Mode Run"
  $shortcut.WorkingDirectory = $BaseDir
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,16"
  $shortcut.Save()
  Write-Host 'Inicializacao automatica instalada para este usuario do Windows.' -ForegroundColor Green
  Write-Log 'Atalho de inicializacao automatica criado.'
}

function Run-Agent {
  $createdNew = $false
  $mutex = [System.Threading.Mutex]::new($true, $MutexName, [ref]$createdNew)
  if (-not $createdNew) {
    Write-Log 'Outra instancia do agente ja esta rodando.' 'WARN'
    $mutex.Dispose()
    return
  }

  try {
    $cfg = Read-Config
    $token = Get-AgentToken
    $pollSeconds = [Math]::Max(3, [Math]::Min(60, [int]$cfg.pollSeconds))
    $width = [Math]::Max(30, [Math]::Min(64, [int]$cfg.paperWidthChars))
    $baseUrl = ([string]$cfg.siteUrl).TrimEnd('/')
    $printerName = [string]$cfg.printerName

    Get-Printer -Name $printerName -ErrorAction Stop | Out-Null
    Write-Log "Agente iniciado. Impressora: $printerName; consulta: ${pollSeconds}s"

    while ($true) {
      try {
        $fila = Invoke-Api 'GET' ($baseUrl + '/api/pedidos?limit=100') $token
        $pendentes = @($fila.pedidos | Where-Object { $_.status -eq 'pendente' } | Sort-Object criadoEm)

        foreach ($pedido in $pendentes) {
          try {
            Update-OrderStatus $cfg $token $pedido 'imprimindo'
            $receipt = Format-Receipt $pedido $width
            Send-ToPrinter $receipt $printerName
            Update-OrderStatus $cfg $token $pedido 'impresso'
            Write-Log ("Comanda {0} impressa com sucesso." -f $pedido.numero)
          } catch {
            $err = $_.Exception.Message
            try { Update-OrderStatus $cfg $token $pedido 'falhou' $err } catch {}
            Write-Log ("Falha na comanda {0}: {1}" -f $pedido.numero, $err) 'ERROR'
          }
        }
      } catch {
        Write-Log ('Falha ao consultar a fila: ' + $_.Exception.Message) 'ERROR'
        Start-Sleep -Seconds 10
      }
      Start-Sleep -Seconds $pollSeconds
    }
  } finally {
    if ($mutex) {
      try { $mutex.ReleaseMutex() } catch {}
      $mutex.Dispose()
    }
  }
}

try {
  switch ($Mode) {
    'Setup' { Setup-Agent }
    'Test' { Print-Test }
    'InstallStartup' { Install-Startup }
    default { Run-Agent }
  }
} catch {
  Write-Log $_.Exception.Message 'FATAL'
  Write-Host ''
  Write-Host ('ERRO: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
