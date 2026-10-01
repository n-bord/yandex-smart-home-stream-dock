#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Path $PSScriptRoot -Parent
$PluginName = 'com.nbord.yandexsmarthome.streamdock.sdPlugin'
$Source = Join-Path $Here $PluginName
$LogPath = Join-Path $Here 'install-windows.log'

function Write-Log {
    param(
        [string]$Message,
        [ConsoleColor]$Color = [ConsoleColor]::Gray
    )
    $time = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    try {
        Add-Content -LiteralPath $LogPath -Value "[$time] $Message" -Encoding UTF8
    } catch {}
    Write-Host $Message -ForegroundColor $Color
}

function Wait-ForExit {
    Write-Host ''
    Write-Host 'Нажмите любую клавишу, чтобы закрыть окно...'
    try {
        $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    } catch {
        try { Read-Host 'Нажмите Enter, чтобы закрыть окно' | Out-Null } catch {}
    }
}

try {
    '' | Set-Content -LiteralPath $LogPath -Encoding UTF8
    Write-Host ''
    Write-Log 'Яндекс Умный дом [n-bord] v1.1.0 — установка для Windows' Cyan
    Write-Log "Каталог установщика: $Here"

    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Не найдена папка '$PluginName' рядом с установщиком. Полностью распакуйте ZIP и запускайте INSTALL-WINDOWS.bat из распакованной папки."
    }

    if (-not $env:APPDATA) {
        throw 'Windows не вернул путь APPDATA. Невозможно определить каталог Stream Dock.'
    }

    # Поддерживаем известные варианты каталогов Stream Dock.
    $Candidates = @(
        (Join-Path $env:APPDATA 'HotSpot\StreamDock\plugins'),
        (Join-Path $env:APPDATA 'HotSpot\Stream Dock AJAZZ\installedPlugins'),
        (Join-Path $env:APPDATA 'HotSpot\StreamDock\installedPlugins'),
        (Join-Path $env:APPDATA 'StreamDock\plugins')
    )

    # Сначала выбираем уже существующий каталог plugins/installedPlugins.
    $DestRoot = $Candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    # Если самого каталога ещё нет — ищем существующего родителя.
    if (-not $DestRoot) {
        foreach ($candidate in $Candidates) {
            $parent = Split-Path -Path $candidate -Parent
            if ($parent -and (Test-Path -LiteralPath $parent)) {
                $DestRoot = $candidate
                break
            }
        }
    }

    # Последний вариант — стандартный путь первой конфигурации.
    if (-not $DestRoot) {
        $DestRoot = $Candidates[0]
    }

    Write-Log "Папка установки: $DestRoot"

    # Закрытие Stream Dock — best effort. Ошибка доступа не должна прерывать установку.
    $appExe = $null
    $matched = @()
    try {
        $allProcesses = Get-Process -ErrorAction SilentlyContinue
        $matched = $allProcesses | Where-Object {
            $_.ProcessName -match 'StreamDock|Stream.?Dock|Control.?Deck|MiraBox|Mirabox'
        }

        foreach ($item in $matched) {
            if (-not $appExe) {
                try {
                    if ($item.Path -and (Test-Path -LiteralPath $item.Path)) {
                        $appExe = $item.Path
                    }
                } catch {}
            }
            try {
                Stop-Process -Id $item.Id -Force -ErrorAction Stop
                Write-Log "Закрыт процесс: $($item.ProcessName)"
            } catch {
                Write-Log "Не удалось закрыть $($item.ProcessName): $($_.Exception.Message)" Yellow
            }
        }
    } catch {
        Write-Log "Не удалось проверить процессы Stream Dock: $($_.Exception.Message)" Yellow
    }

    Start-Sleep -Milliseconds 700

    New-Item -ItemType Directory -Path $DestRoot -Force | Out-Null
    $Target = Join-Path $DestRoot $PluginName

    if (Test-Path -LiteralPath $Target) {
        Write-Log 'Удаляется предыдущая версия плагина...'
        try {
            Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction Stop
        } catch {
            throw "Не удалось удалить предыдущую версию плагина: $($_.Exception.Message)`nПолностью закройте Stream Dock и повторите установку."
        }
    }

    Write-Log 'Копирование файлов плагина...'
    Copy-Item -LiteralPath $Source -Destination $Target -Recurse -Force -ErrorAction Stop

    # Best-effort: очищаем только известный кэш Stream Dock.
    $CacheCandidates = @(
        (Join-Path $env:APPDATA 'HotSpot\StreamDock\cache'),
        (Join-Path $env:APPDATA 'HotSpot\Stream Dock AJAZZ\cache')
    )
    foreach ($cache in $CacheCandidates) {
        if (Test-Path -LiteralPath $cache) {
            try {
                Get-ChildItem -LiteralPath $cache -Force -ErrorAction SilentlyContinue |
                    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            } catch {}
        }
    }

    Write-Host ''
    Write-Log 'Плагин успешно установлен.' Green

    if ($appExe -and (Test-Path -LiteralPath $appExe)) {
        try {
            Start-Process -FilePath $appExe | Out-Null
            Write-Log 'Stream Dock запущен снова.' Green
        } catch {
            Write-Log 'Не удалось автоматически запустить Stream Dock. Запустите его вручную.' Yellow
        }
    } else {
        Write-Log 'Запустите Stream Dock вручную.' Yellow
    }

    Write-Host ''
    Write-Log 'Если плагин не появился сразу, полностью закройте Stream Dock и откройте его снова.'
    Write-Log 'Для входа: Настройки -> Подключение -> Войти через Яндекс.'
    Write-Log "Журнал установки: $LogPath"
}
catch {
    Write-Host ''
    Write-Host 'ОШИБКА УСТАНОВКИ' -ForegroundColor Red
    Write-Host '-----------------' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    try {
        Add-Content -LiteralPath $LogPath -Value "[ERROR] $($_.Exception.ToString())" -Encoding UTF8
    } catch {}
    Write-Host ''
    Write-Host "Подробности сохранены в: $LogPath" -ForegroundColor Yellow
    Write-Host 'Если пришлёте мне этот файл, я смогу точно определить причину.' -ForegroundColor Yellow
}
finally {
    Wait-ForExit
}
