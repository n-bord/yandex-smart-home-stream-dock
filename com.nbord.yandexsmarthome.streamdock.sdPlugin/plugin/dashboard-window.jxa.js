ObjC.import('Cocoa')
ObjC.import('WebKit')
ObjC.import('Foundation')

var YSHWindow = null
var YSHWebView = null
var YSHDelegate = null
var YSHFocusObserver = null
var YSHFocusNotificationName = null
var YSHFocusFile = ''
var YSHFocusStamp = ''
var YSHFocusPoller = null
var YSHFocusTimer = null
var YSHRestoreLevelAt = 0
var YSHLogFile = ''
var YSHDebugFlagFile = ''

function helperDebugEnabled() {
  if (!YSHDebugFlagFile) return false
  try { return $.NSFileManager.defaultManager.fileExistsAtPath(YSHDebugFlagFile) } catch (_) { return false }
}

function helperLog(message, forceError) {
  if (!YSHLogFile) return
  // Обычные сообщения helper пишем только при включённой отладке.
  // Ошибки можно принудительно записать независимо от режима.
  if (!forceError && !helperDebugEnabled()) return
  try {
    var prefix = forceError ? 'ERROR DASHBOARD_HELPER ' : 'DASHBOARD_HELPER '
    var line = '[' + (new Date()).toISOString() + '] ' + prefix + String(message) + '\n'
    var fm = $.NSFileManager.defaultManager
    var data = $(line).dataUsingEncoding($.NSUTF8StringEncoding)
    if (!fm.fileExistsAtPath(YSHLogFile)) {
      fm.createFileAtPathContentsAttributes(YSHLogFile, data, null)
      return
    }
    var h = $.NSFileHandle.fileHandleForWritingAtPath(YSHLogFile)
    if (h) {
      h.seekToEndOfFile
      h.writeData(data)
      h.closeFile
    }
  } catch (_) {}
}

function readFocusStamp() {
  if (!YSHFocusFile) return ''
  try {
    if (!$.NSFileManager.defaultManager.fileExistsAtPath(YSHFocusFile)) return ''
    var s = $.NSString.stringWithContentsOfFileEncodingError(YSHFocusFile, $.NSUTF8StringEncoding, null)
    return s ? String(ObjC.unwrap(s)) : ''
  } catch (_) { return '' }
}

function focusDashboardWindow(reason) {
  var app = $.NSApplication.sharedApplication
  helperLog('focus reason=' + String(reason || 'unknown'))
  try { app.unhide(null) } catch (_) {}
  try { if (YSHWindow && YSHWindow.isMiniaturized) YSHWindow.deminiaturize(null) } catch (_) {}
  // Raise above ordinary application windows first. The level is returned to normal shortly after.
  try { if (YSHWindow) YSHWindow.setLevel($.NSFloatingWindowLevel) } catch (_) {}
  try { if (YSHWindow) YSHWindow.orderFrontRegardless } catch (_) {}
  try { if (YSHWindow) YSHWindow.makeKeyAndOrderFront(null) } catch (_) {}
  try {
    var running = $.NSRunningApplication.currentApplication
    if (running) running.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps)
  } catch (_) {}
  try { app.activateIgnoringOtherApps(true) } catch (_) {}
  try { if (YSHWindow) YSHWindow.orderFrontRegardless } catch (_) {}
  try { if (YSHWindow) YSHWindow.makeKeyAndOrderFront(null) } catch (_) {}
  YSHRestoreLevelAt = Date.now() + 1200
}

if (!$.YSHWindowDelegate) {
  ObjC.registerSubclass({
    name: 'YSHWindowDelegate',
    superclass: 'NSObject',
    methods: {
      'windowWillClose:': {
        types: ['void', ['NSNotification']],
        implementation: function () {
          helperLog('window closed')
          try { if (YSHFocusTimer) YSHFocusTimer.invalidate } catch (_) {}
          try {
            if (YSHFocusObserver && YSHFocusNotificationName) {
              $.NSDistributedNotificationCenter.defaultCenter.removeObserverNameObject(
                YSHFocusObserver,
                YSHFocusNotificationName,
                null
              )
            }
          } catch (_) {}
          $.NSApplication.sharedApplication.terminate(null)
        }
      }
    }
  })
}

// Keep the old distributed notification as a fallback for compatibility.
if (!$.YSHDashboardFocusObserver) {
  ObjC.registerSubclass({
    name: 'YSHDashboardFocusObserver',
    superclass: 'NSObject',
    methods: {
      'focusDashboard:': {
        types: ['void', ['NSNotification']],
        implementation: function () {
          focusDashboardWindow('distributed-notification')
        }
      }
    }
  })
}

// Primary focus transport: polling a tiny focus file is deliberately simple and reliable
// inside osascript/JXA. It avoids depending on cross-process Cocoa notification delivery.
if (!$.YSHDashboardFocusPoller) {
  ObjC.registerSubclass({
    name: 'YSHDashboardFocusPoller',
    superclass: 'NSObject',
    methods: {
      'pollFocus:': {
        types: ['void', ['id']],
        implementation: function () {
          try {
            var stamp = readFocusStamp()
            if (stamp && stamp !== YSHFocusStamp) {
              YSHFocusStamp = stamp
              focusDashboardWindow('focus-file')
            }
            if (YSHRestoreLevelAt && Date.now() >= YSHRestoreLevelAt) {
              YSHRestoreLevelAt = 0
              try { if (YSHWindow) YSHWindow.setLevel($.NSNormalWindowLevel) } catch (_) {}
            }
          } catch (_) {}
        }
      }
    }
  })
}

function run(argv) {
  var url = String((argv && argv.length ? argv[0] : '') || '')
  if (!url) return
  YSHFocusFile = String((argv && argv.length > 1 ? argv[1] : '') || '')
  YSHLogFile = String((argv && argv.length > 2 ? argv[2] : '') || '')
  YSHDebugFlagFile = String((argv && argv.length > 3 ? argv[3] : '') || '')

  var app = $.NSApplication.sharedApplication
  try { app.setActivationPolicy($.NSApplicationActivationPolicyAccessory) } catch (_) {}

  var style = $.NSWindowStyleMaskTitled |
              $.NSWindowStyleMaskClosable |
              $.NSWindowStyleMaskMiniaturizable |
              $.NSWindowStyleMaskResizable

  YSHWindow = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, 1360, 840),
    style,
    $.NSBackingStoreBuffered,
    false
  )
  YSHWindow.title = 'Яндекс Умный дом [n-bord]'
  YSHWindow.releasedWhenClosed = false
  YSHWindow.minSize = $.NSMakeSize(1080, 680)
  YSHWindow.center

  var config = $.WKWebViewConfiguration.alloc.init
  YSHWebView = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, 1360, 840), config)
  YSHWebView.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable
  var request = $.NSURLRequest.requestWithURL($.NSURL.URLWithString(url))
  YSHWebView.loadRequest(request)

  YSHDelegate = $.YSHWindowDelegate.alloc.init
  YSHWindow.delegate = YSHDelegate
  YSHWindow.contentView.addSubview(YSHWebView)

  var pid = Number($.NSProcessInfo.processInfo.processIdentifier)
  YSHFocusNotificationName = 'com.yandex.smarthome.streamdock.dashboard.focus.' + String(pid)
  YSHFocusObserver = $.YSHDashboardFocusObserver.alloc.init
  try {
    $.NSDistributedNotificationCenter.defaultCenter.addObserverSelectorNameObject(
      YSHFocusObserver,
      'focusDashboard:',
      YSHFocusNotificationName,
      null
    )
  } catch (_) {}

  YSHFocusStamp = readFocusStamp()
  YSHFocusPoller = $.YSHDashboardFocusPoller.alloc.init
  try {
    YSHFocusTimer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(
      0.20,
      YSHFocusPoller,
      'pollFocus:',
      null,
      true
    )
    $.NSRunLoop.mainRunLoop.addTimerForMode(YSHFocusTimer, $.NSRunLoopCommonModes)
  } catch (e) {
    helperLog('focus timer error=' + String(e), true)
  }

  helperLog('started pid=' + String(pid) + ' focusFile=' + YSHFocusFile)
  focusDashboardWindow('initial')
  app.run
}
