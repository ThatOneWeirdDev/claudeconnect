// The Stop bar: shown at the top of the screen, over every window, while the program is using the Claude app on this Mac.
// Pressing Stop takes the app back at once: nothing more is typed or clicked in it.
//
//   CLAUDECONNECT_BAR='{"text": "...", "label": "Stop"}' /usr/bin/osascript -l JavaScript app-mac-bar.js
//
// It's its own small process, so it answers whatever the helper doing the work is busy with. It writes "ready" once it's
// on the screen and "stop" when Stop is pressed, then ends. On stdin it takes 'text {"text": "...", "label": "..."}' to
// change what it says, and "quit". It ends by itself when stdin ends or the program that started it goes away.

ObjC.import('Cocoa');
ObjC.import('unistd');
ObjC.import('stdlib');

function run() {
  var opt = { text: 'Using the Claude app', label: 'Stop' };
  try {
    var env = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey($('CLAUDECONNECT_BAR')));
    var o = JSON.parse(env || '{}');
    if (o.text) opt.text = String(o.text);
    if (o.label) opt.label = String(o.label);
  } catch (e) {}

  var parent = $.getppid();
  var OUT = $.NSFileHandle.fileHandleWithStandardOutput;
  function say(s) { OUT.writeData($(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
  var done = false;
  function stop() {
    if (done) return;
    done = true;
    say('stop');
    $.exit(0);
  }

  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory); // no Dock icon, no menu bar

  ObjC.registerSubclass({
    name: 'CCBarTarget',
    superclass: 'NSObject',
    methods: {
      'stop:': { types: ['void', ['id']], implementation: function () { stop(); } },
      'tick:': { types: ['void', ['id']], implementation: function () { if ($.getppid() !== parent) $.exit(0); } }
    }
  });
  var target = $.CCBarTarget.alloc.init;
  // a button that works on the first click, though the bar never takes the focus from what you're doing
  var buttonClass = 'NSButton';
  try {
    ObjC.registerSubclass({
      name: 'CCStopButton',
      superclass: 'NSButton',
      methods: { 'acceptsFirstMouse:': { types: ['bool', ['id']], implementation: function () { return true; } } }
    });
    buttonClass = 'CCStopButton';
  } catch (e) {}

  var H = 44;
  function widthFor(text, label) { return Math.max(360, Math.min(760, 150 + text.length * 7.4 + label.length * 7)); }
  var W = widthFor(opt.text, opt.label);
  var vf = $.NSScreen.mainScreen.visibleFrame; // below the menu bar
  var STYLE = $.NSWindowStyleMaskBorderless | ($.NSWindowStyleMaskNonactivatingPanel || 128);
  var bar = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(vf.origin.x + (vf.size.width - W) / 2, vf.origin.y + vf.size.height - H - 10, W, H), STYLE, $.NSBackingStoreBuffered, false);
  bar.setLevel($.NSStatusWindowLevel || 25);
  // on every desktop, over full-screen apps too, and left out of Mission Control's window cycling
  bar.setCollectionBehavior(1 | 16 | 64 | 256);
  bar.setHidesOnDeactivate(false);
  // (no setFloatingPanel: it would put the level back down to an ordinary floating window's)
  bar.setBecomesKeyOnlyIfNeeded(true);
  bar.setWorksWhenModal(true);
  bar.setReleasedWhenClosed(false);
  bar.setOpaque(false);
  bar.setBackgroundColor($.NSColor.clearColor);
  bar.setHasShadow(true);
  bar.setMovableByWindowBackground(true);

  var content = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
  content.setWantsLayer(true);
  content.layer.setCornerRadius(12);
  content.layer.setBackgroundColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(0.13, 0.13, 0.13, 0.96).CGColor);
  content.layer.setBorderWidth(1);
  content.layer.setBorderColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 1, 1, 0.14).CGColor);
  bar.setContentView(content);

  // a small dot that says something is happening
  var dot = $.NSView.alloc.initWithFrame($.NSMakeRect(16, (H - 10) / 2, 10, 10));
  dot.setWantsLayer(true);
  dot.layer.setCornerRadius(5);
  dot.layer.setBackgroundColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(0.06, 0.64, 0.5, 1).CGColor);
  content.addSubview(dot);

  var label = $.NSTextField.alloc.initWithFrame($.NSMakeRect(36, 12, W - 36 - 130, 20));
  label.setBezeled(false);
  label.setBordered(false);
  label.setDrawsBackground(false);
  label.setEditable(false);
  label.setSelectable(false);
  label.setTextColor($.NSColor.whiteColor);
  label.setFont($.NSFont.systemFontOfSizeWeight(13, $.NSFontWeightMedium || 0.23));
  label.setLineBreakMode($.NSLineBreakByTruncatingTail);
  label.setStringValue($(opt.text));
  content.addSubview(label);

  var button = $[buttonClass].buttonWithTitleTargetAction($(opt.label), target, 'stop:');
  button.setBezelStyle($.NSBezelStyleRounded || 1);
  try { button.setBezelColor($.NSColor.systemRedColor); } catch (e) {}
  button.setToolTip($('Stop now: nothing more is typed or clicked in the Claude app.'));
  button.sizeToFit;
  var bw = Math.max(84, Number(button.frame.size.width) + 16);
  button.setFrame($.NSMakeRect(W - bw - 8, (H - 28) / 2, bw, 28));
  content.addSubview(button);

  function relabel(text, stopLabel) {
    var w = widthFor(text, stopLabel || opt.label);
    var f = bar.frame;
    bar.setFrameDisplay($.NSMakeRect(f.origin.x + (f.size.width - w) / 2, f.origin.y, w, H), true);
    content.setFrame($.NSMakeRect(0, 0, w, H));
    if (stopLabel) { button.setTitle($(stopLabel)); opt.label = stopLabel; }
    button.sizeToFit;
    var nb = Math.max(84, Number(button.frame.size.width) + 16);
    button.setFrame($.NSMakeRect(w - nb - 8, (H - 28) / 2, nb, 28));
    label.setFrame($.NSMakeRect(36, 12, w - 36 - nb - 20, 20));
    label.setStringValue($(text));
  }

  // there's no signal for the parent going away on macOS, so it's checked twice a second
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.5, target, 'tick:', null, true);

  // lines on stdin, read without holding up the bar
  var stdin = $.NSFileHandle.fileHandleWithStandardInput;
  var pending = '';
  $.NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
    $.NSFileHandleDataAvailableNotification, stdin, $.NSOperationQueue.mainQueue, function () {
      var data = stdin.availableData;
      if (!data || Number(data.length) === 0) $.exit(0);
      pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
      var at;
      while ((at = pending.indexOf('\n')) >= 0) {
        var line = pending.slice(0, at).trim();
        pending = pending.slice(at + 1);
        if (line === 'quit') $.exit(0);
        else if (line.indexOf('text ') === 0) {
          try { var t = JSON.parse(line.slice(5)); relabel(String(t.text || opt.text), t.label ? String(t.label) : ''); } catch (e) {}
        }
      }
      stdin.waitForDataInBackgroundAndNotify;
    });
  stdin.waitForDataInBackgroundAndNotify;

  bar.orderFrontRegardless;
  say('ready');
  app.run;
}
