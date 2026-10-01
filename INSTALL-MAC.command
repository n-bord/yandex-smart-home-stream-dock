#!/bin/bash

# Yandex Smart Home [n-bord] v1.1.0 — Stream Dock installer for macOS
# Installs the plugin into the current user's Stream Dock plugins directory.

set -u

PLUGIN_NAME="com.nbord.yandexsmarthome.streamdock.sdPlugin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/$PLUGIN_NAME"
LOG_FILE="$SCRIPT_DIR/install-mac.log"
TARGET_ROOT=""
TARGET=""
APP_TO_REOPEN=""

# Start a fresh log for each install attempt.
: > "$LOG_FILE" 2>/dev/null || true

log() {
  local message="$1"
  printf '%s\n' "$message"
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$message" >> "$LOG_FILE" 2>/dev/null || true
}

finish() {
  printf '\n'
  printf 'Нажмите Enter, чтобы закрыть окно...'
  IFS= read -r _ || true
}

fail() {
  printf '\n'
  log "ОШИБКА УСТАНОВКИ"
  log "$1"
  log "Подробности: $LOG_FILE"
  finish
  exit 1
}

log ""
log "============================================================"
log "  Яндекс Умный дом [n-bord] v1.1.0"
log "  Установщик плагина Stream Dock для macOS"
log "============================================================"
log ""
log "Каталог установщика: $SCRIPT_DIR"

if [ ! -d "$SOURCE" ]; then
  fail "Не найдена папка '$PLUGIN_NAME'. Полностью распакуйте ZIP и запускайте INSTALL-MAC.command из распакованной папки."
fi

# Prefer the directory that already contains this plugin, then known Stream Dock locations.
CANDIDATES=(
  "$HOME/Library/Application Support/HotSpot/StreamDock/plugins"
  "$HOME/Library/Application Support/HotSpot/StreamDock/Plugins"
  "$HOME/Library/Application Support/HotSpot/Stream Dock AJAZZ/installedPlugins"
  "$HOME/Library/Application Support/HotSpot/StreamDock/installedPlugins"
  "$HOME/Library/Application Support/StreamDock/plugins"
)

for candidate in "${CANDIDATES[@]}"; do
  if [ -d "$candidate/$PLUGIN_NAME" ]; then
    TARGET_ROOT="$candidate"
    break
  fi
done

if [ -z "$TARGET_ROOT" ]; then
  for candidate in "${CANDIDATES[@]}"; do
    if [ -d "$candidate" ]; then
      TARGET_ROOT="$candidate"
      break
    fi
  done
fi

# Try to discover an existing Stream Dock plugin directory used by another variant.
if [ -z "$TARGET_ROOT" ]; then
  SUPPORT_DIR="$HOME/Library/Application Support"
  if [ -d "$SUPPORT_DIR" ]; then
    DISCOVERED="$(find "$SUPPORT_DIR" -maxdepth 5 -type d \( -iname 'plugins' -o -iname 'installedPlugins' \) 2>/dev/null \
      | grep -Ei '/(HotSpot|Stream ?Dock|AJAZZ|MiraBox)/' \
      | head -n 1 || true)"
    if [ -n "$DISCOVERED" ]; then
      TARGET_ROOT="$DISCOVERED"
    fi
  fi
fi

# Standard macOS Stream Dock location.
if [ -z "$TARGET_ROOT" ]; then
  TARGET_ROOT="${CANDIDATES[0]}"
fi

TARGET="$TARGET_ROOT/$PLUGIN_NAME"
log "Папка установки: $TARGET_ROOT"

# Remember an installed Stream Dock application for restart.
for app_dir in /Applications "$HOME/Applications"; do
  if [ -d "$app_dir" ]; then
    FOUND_APP="$(find "$app_dir" -maxdepth 2 -type d -name '*.app' 2>/dev/null \
      | grep -Ei '/(Stream ?Dock|StreamDock|AJAZZ.*Dock|MiraBox.*Dock)[^/]*\.app$' \
      | head -n 1 || true)"
    if [ -n "$FOUND_APP" ]; then
      APP_TO_REOPEN="$FOUND_APP"
      break
    fi
  fi
done

log "Закрываю Stream Dock, если он запущен..."
# Graceful quit for common application names. Errors are intentionally ignored.
osascript -e 'tell application "Stream Dock" to quit' >/dev/null 2>&1 || true
osascript -e 'tell application "StreamDock" to quit' >/dev/null 2>&1 || true
osascript -e 'tell application "Stream Dock AJAZZ" to quit' >/dev/null 2>&1 || true
sleep 1

# If a host process is still present, request termination. Do not fail installation if access is denied.
pkill -f '/Stream ?Dock[^/]*/Contents/MacOS/' >/dev/null 2>&1 || true
sleep 1

if ! mkdir -p "$TARGET_ROOT" 2>>"$LOG_FILE"; then
  fail "Не удалось создать каталог плагинов: $TARGET_ROOT"
fi

TMP_TARGET="$TARGET_ROOT/.${PLUGIN_NAME}.installing.$$"
rm -rf "$TMP_TARGET" >/dev/null 2>&1 || true

log "Копирую файлы плагина..."
if command -v ditto >/dev/null 2>&1; then
  if ! ditto "$SOURCE" "$TMP_TARGET" >>"$LOG_FILE" 2>&1; then
    rm -rf "$TMP_TARGET" >/dev/null 2>&1 || true
    fail "Не удалось скопировать файлы плагина."
  fi
else
  if ! cp -R "$SOURCE" "$TMP_TARGET" >>"$LOG_FILE" 2>&1; then
    rm -rf "$TMP_TARGET" >/dev/null 2>&1 || true
    fail "Не удалось скопировать файлы плагина."
  fi
fi

if [ -d "$TARGET" ]; then
  log "Удаляю предыдущую версию плагина..."
  if ! rm -rf "$TARGET" >>"$LOG_FILE" 2>&1; then
    rm -rf "$TMP_TARGET" >/dev/null 2>&1 || true
    fail "Не удалось удалить предыдущую версию. Полностью закройте Stream Dock и повторите установку."
  fi
fi

if ! mv "$TMP_TARGET" "$TARGET" >>"$LOG_FILE" 2>&1; then
  rm -rf "$TMP_TARGET" >/dev/null 2>&1 || true
  fail "Не удалось завершить установку плагина."
fi

# Remove quarantine only from our installed copy if macOS attached it to the downloaded ZIP.
# Failure is harmless; no administrator rights are requested.
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$TARGET" >/dev/null 2>&1 || true
fi

log ""
log "Плагин успешно установлен."

REOPENED=0
if [ -n "$APP_TO_REOPEN" ] && [ -d "$APP_TO_REOPEN" ]; then
  if open "$APP_TO_REOPEN" >/dev/null 2>&1; then
    log "Stream Dock запущен снова."
    REOPENED=1
  fi
fi

if [ "$REOPENED" -eq 0 ]; then
  for app_name in "Stream Dock" "StreamDock" "Stream Dock AJAZZ"; do
    if open -a "$app_name" >/dev/null 2>&1; then
      log "Stream Dock запущен снова."
      REOPENED=1
      break
    fi
  done
fi

if [ "$REOPENED" -eq 0 ]; then
  log "Не удалось автоматически найти приложение Stream Dock — запустите его вручную."
fi

log ""
log "Если плагин не появился сразу, полностью закройте Stream Dock и откройте его снова."
log "Для входа: Настройки -> Подключение -> Войти через Яндекс."
log "Журнал установки: $LOG_FILE"

finish
exit 0
