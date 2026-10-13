// The helper that works the Claude app on a Mac, through macOS's Accessibility features: the same way VoiceOver and
// automation tools work, and only with your permission (System Settings → Privacy & Security → Accessibility). It reads
// the app's window as a tree of buttons, text boxes and text, presses buttons, and puts your message in the message box.
// It never starts the app in a debugging mode and never quits it.
//
//   /usr/bin/osascript -l JavaScript app-mac.js
//
// It runs as long as the program that started it (app-os.mjs), reading one request per line on stdin and answering one
// line on stdout, in JSON:  {"id": 7, "cmd": "scan", ...}  ->  {"id": 7, "ok": true, ...}  or  {"id": 7, "ok": false,
// "error": "<code>", "detail": "..."}. Its first line is {"id": 0, "ok": true, "ready": true}. Both directions are pure
// ASCII (anything else is written \uXXXX), so a line never ends partway through a character. It stops when stdin ends.
//
// JavaScript for Automation reaches the Accessibility C functions through ObjC.bindFunction. They're bound with `id` for
// every CFTypeRef, so an element taken out of an AXChildren array goes straight back in, and an out-parameter is a plain
// Ref() whose [0] is an object.

ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.import('unistd');
ObjC.import('stdlib');

// It never gets a Dock icon or a menu bar.
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);

ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCreateSystemWide', ['id', []]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
ObjC.bindFunction('AXUIElementCopyMultipleAttributeValues', ['int', ['id', 'id', 'int', 'id*']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']]);
ObjC.bindFunction('AXIsProcessTrustedWithOptions', ['bool', ['id']]);
ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void*', 'unsigned long', 'void*']]);
ObjC.bindFunction('malloc', ['void*', ['int']]);
ObjC.bindFunction('free', ['void', ['void*']]);

var VERSION = 1;
// a test names another Chromium program to stand in for the app
var BUNDLE = (function () {
  try { return ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey($('CLAUDECONNECT_APP_BUNDLE'))) || 'com.anthropic.claudefordesktop'; } catch (e) { return 'com.anthropic.claudefordesktop'; }
})();
var MARK = 0x43434f4e; // written into every key event this posts (kCGEventSourceUserData), so they can be told apart
var ANY_INPUT = 4294967295; // kCGAnyInputEventType
var KEY = { v: 9, return: 36, escape: 53 };
var FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 };
var MODKEYS = [55, 54, 56, 60, 58, 61, 59, 62];
var BASE = ['AXRole', 'AXSubrole', 'AXTitle', 'AXDescription', 'AXValue', 'AXDOMClassList', 'AXFocused', 'AXEnabled'];
// roles whose insides are never walked
var LEAF = { AXStaticText: 1, AXImage: 1, AXScrollBar: 1, AXSlider: 1, AXValueIndicator: 1, AXIncrementor: 1,
  AXProgressIndicator: 1, AXTextField: 1, AXTextArea: 1, AXColumn: 1, AXSplitter: 1 };

var S = { pid: 0, app: null, ax: null, manualFor: 0, manualAt: 0, web: null, handles: {}, nHandles: 0, next: 1, lastPostAt: 0, cmdStart: 0, menuPaste: null };

// ------------------------------------------------------------------------------------------------------------- plumbing
var OUT = $.NSFileHandle.fileHandleWithStandardOutput;
function ascii(s) {
  return s.replace(/[\u007f-￿]/g, function (c) { return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); });
}
function send(o) { OUT.writeData($(ascii(JSON.stringify(o)) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
function Fail(code, detail) { this.code = code; this.detail = detail; }
function fail(code, detail) { throw new Fail(code, detail || code); }
function now() { return Date.now(); }
// turns the run loop, so what NSRunningApplication and NSWorkspace say is up to date, and waits a little
function tick(sec) { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(sec || 0.005)); }
function waitFor(fn, sec, step) {
  var end = now() + sec * 1000;
  for (;;) {
    var v;
    try { v = fn(); } catch (e) { v = null; }
    if (v) return v;
    if (now() >= end) return null;
    tick(step || 0.05);
  }
}
function nil(o) { try { return o === undefined || o === null || (typeof o.isNil === 'function' && o.isNil()); } catch (e) { return true; } }
function js(o) {
  if (nil(o)) return null;
  try { var u = ObjC.unwrap(o); return (typeof u === 'string' || typeof u === 'number' || typeof u === 'boolean') ? u : null; } catch (e) { return null; }
}
function jstr(o) { var v = js(o); return v === null ? '' : String(v); }
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// ------------------------------------------------------------------------------------------------------- accessibility
var lastErr = 0;
function attr(el, name) {
  var r = Ref();
  lastErr = $.AXUIElementCopyAttributeValue(el, $(name), r);
  return lastErr === 0 ? r[0] : null;
}
function str(el, name) { return jstr(attr(el, name)); }
function bool(el, name) { var v = js(attr(el, name)); return v === true || v === 1; }
function kids(el) {
  var v = attr(el, 'AXChildren'), out = [];
  if (nil(v)) return out;
  try { var n = Number(v.count); for (var i = 0; i < n; i++) out.push(v.objectAtIndex(i)); } catch (e) {}
  return out;
}
function setAttr(el, name, value) { return $.AXUIElementSetAttributeValue(el, $(name), value); }
function perform(el, action) { return $.AXUIElementPerformAction(el, $(action)); }
function urlOf(el) { var u = attr(el, 'AXURL'); try { return nil(u) ? '' : jstr(u.absoluteString); } catch (e) { return ''; } }

// The attributes every node is looked at by, in one round trip when the app allows it.
function readBase(el) {
  var o = {}, r = Ref();
  var err = $.AXUIElementCopyMultipleAttributeValues(el, $(BASE), 0, r);
  if (err === 0 && !nil(r[0])) {
    var vals = r[0];
    for (var i = 0; i < BASE.length; i++) {
      var v = vals.objectAtIndex(i), name = BASE[i];
      if (name === 'AXDOMClassList') {
        try { o.cls = nil(v) ? [] : (ObjC.deepUnwrap(v) || []); if (!Array.isArray(o.cls)) o.cls = []; } catch (e) { o.cls = []; }
        continue;
      }
      var u = js(v);
      if (u !== null) o[name] = u;
    }
    return o.AXRole ? o : null;
  }
  if (err === -25202) return null; // the element is gone
  for (var j = 0; j < BASE.length; j++) {
    var n = BASE[j];
    if (n === 'AXDOMClassList') { try { o.cls = ObjC.deepUnwrap(attr(el, n)) || []; if (!Array.isArray(o.cls)) o.cls = []; } catch (e) { o.cls = []; } continue; }
    var w = js(attr(el, n));
    if (n === 'AXRole' && lastErr === -25202) return null;
    if (w !== null) o[n] = w;
  }
  return o.AXRole ? o : null;
}

// What a node is, in the same words app-win.ps1 uses for Windows.
function roleOf(b) {
  var r = b.AXRole || '', s = b.AXSubrole || '';
  switch (r) {
    case 'AXButton': case 'AXPopUpButton': case 'AXMenuButton': case 'AXDisclosureTriangle': return 'button';
    case 'AXTextArea': return 'textbox';
    case 'AXTextField': return s === 'AXSecureTextField' ? 'secret' : 'textbox';
    case 'AXComboBox': return 'textbox';
    case 'AXStaticText': return 'text';
    case 'AXLink': return 'link';
    case 'AXHeading': return 'heading';
    case 'AXList': return 'list';
    case 'AXListMarker': return 'marker';
    case 'AXMenu': return 'menu';
    case 'AXMenuItem': return 'menuitem';
    case 'AXCheckBox': return s === 'AXSwitch' ? 'switch' : (s === 'AXToggleButton' || s === 'AXToggle') ? 'toggle' : 'checkbox';
    case 'AXRadioButton': return 'radio';
    case 'AXWebArea': return 'document';
    case 'AXTable': return 'table';
    case 'AXRow': return 'row';
    case 'AXCell': return 'cell';
    case 'AXColumn': return 'column';
    case 'AXImage': return 'image';
    case 'AXSplitter': return 'separator';
    case 'AXSheet': return 'dialog';
    case 'AXGroup':
      if (s === 'AXApplicationDialog') return 'dialog';
      if (s === 'AXApplicationAlertDialog') return 'alertdialog';
      if (s === 'AXApplicationAlert') return 'alert';
      if (s === 'AXApplicationStatus') return 'status';
      if (s === 'AXCodeStyleGroup') return 'code';
      if (s === 'AXStrongStyleGroup') return 'strong';
      if (s === 'AXEmphasisStyleGroup') return 'em';
      return 'group';
    default: return r.replace(/^AX/, '').toLowerCase();
  }
}
var CHECKABLE = { checkbox: 1, switch: 1, toggle: 1, radio: 1, menuitem: 1 };
// A node as a request sees it.
function view(b) {
  var role = roleOf(b);
  var title = typeof b.AXTitle === 'string' ? b.AXTitle : '', desc = typeof b.AXDescription === 'string' ? b.AXDescription : '';
  var v = {
    role: role,
    name: desc || title,
    alt: desc && title && desc !== title ? title : '',
    value: typeof b.AXValue === 'string' && role !== 'secret' ? b.AXValue : '',
    cls: (b.cls || []).join(' '),
    focused: b.AXFocused === true,
    disabled: b.AXEnabled === false
  };
  if (CHECKABLE[role] && typeof b.AXValue === 'number') v.checked = b.AXValue === 1;
  return v;
}

function handleFor(el, v) {
  if (S.nHandles > 20000) { S.handles = {}; S.nHandles = 0; }
  var h = 'h' + (S.next++);
  S.handles[h] = { el: el, role: v.role };
  S.nHandles++;
  return h;
}
function resolve(h) {
  var e = S.handles[h];
  if (!e) fail('stale-handle', h);
  var b = readBase(e.el);
  if (!b) fail('stale-handle', h);
  if (roleOf(b) !== e.role) fail('stale-handle', h);
  return e.el;
}

// ------------------------------------------------------------------------------------------------------------- the app
function runningApp() {
  tick();
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier($(BUNDLE));
  var n = Number(apps.count);
  for (var i = 0; i < n; i++) { var a = apps.objectAtIndex(i); if (!a.isTerminated) return a; }
  return null;
}
function attach() {
  var a = runningApp();
  if (!a) { S.pid = 0; S.app = null; S.ax = null; S.web = null; fail('not-running', 'The Claude app is not running.'); }
  var pid = Number(a.processIdentifier);
  if (pid !== S.pid) {
    S.pid = pid; S.app = a; S.ax = $.AXUIElementCreateApplication(pid); S.web = null;
    S.handles = {}; S.nHandles = 0; S.menuPaste = null;
  }
  return S.ax;
}
function trusted(prompt) { return !!$.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: !!prompt })); }
function requireTrust() { if (!trusted(false)) fail('not-trusted', 'Accessibility permission is off.'); }
function appUrl() { var u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier($(BUNDLE)); return nil(u) ? null : u; }

function mainWindow() {
  var w = attr(S.ax, 'AXMainWindow');
  if (nil(w)) w = attr(S.ax, 'AXFocusedWindow');
  if (nil(w)) { var all = kids(S.ax).filter(function (k) { return str(k, 'AXRole') === 'AXWindow'; }); w = all.length ? all[0] : null; }
  return nil(w) ? null : w;
}
// Every page in the app's windows; the one on claude.ai is the conversation.
function webAreas() {
  var out = [], wins = [];
  var v = attr(S.ax, 'AXWindows');
  try { if (!nil(v)) for (var i = 0; i < Number(v.count); i++) wins.push(v.objectAtIndex(i)); } catch (e) {}
  for (var w = 0; w < wins.length; w++) {
    var stack = [[wins[w], 0]], seen = 0;
    while (stack.length && seen < 400) {
      var p = stack.pop(), el = p[0], d = p[1];
      seen++;
      var role = str(el, 'AXRole');
      if (role === 'AXWebArea') { out.push({ el: el, url: urlOf(el), title: str(el, 'AXTitle'), kids: kids(el).length }); continue; }
      if (d >= 30 || LEAF[role]) continue;
      var k = kids(el);
      for (var j = k.length - 1; j >= 0; j--) stack.push([k[j], d + 1]);
    }
  }
  return out;
}
function claudeWeb(fresh) {
  if (!fresh && S.web) {
    var b = readBase(S.web.el);
    if (b && b.AXRole === 'AXWebArea') { S.web.url = urlOf(S.web.el); S.web.title = str(S.web.el, 'AXTitle'); return S.web; }
  }
  var all = webAreas(), onSite = /^https:\/\/([a-z0-9-]+\.)?claude\.ai(\/|$)/i;
  var pool = all.filter(function (w) { return onSite.test(w.url); });
  if (!pool.length) pool = all;
  pool.sort(function (x, y) { return y.kids - x.kids; });
  S.web = pool.length ? pool[0] : null;
  return S.web;
}

// ------------------------------------------------------------------------------------------------------------- reading
function compile(q) {
  var c = {};
  for (var k in q) c[k] = q[k];
  ['name', 'any', 'value', 'cls', 'url', 'not'].forEach(function (k) { if (q[k]) c[k + 'Re'] = new RegExp(q[k], 'i'); });
  if (q.role) c.roles = Array.isArray(q.role) ? q.role : [q.role];
  return c;
}
function matches(q, v, el) {
  if (q.roles && q.roles.indexOf(v.role) < 0) return false;
  if (q.nameRe && !q.nameRe.test(v.name) && !(v.alt && q.nameRe.test(v.alt))) return false;
  if (q.anyRe && !q.anyRe.test([v.name, v.alt, v.value].join(' '))) return false;
  if (q.notRe && q.notRe.test(v.name)) return false;
  if (q.valueRe && !q.valueRe.test(v.value)) return false;
  if (q.clsRe && !q.clsRe.test(v.cls)) return false;
  if (q.urlRe) { if (v.url === undefined) v.url = urlOf(el); if (!q.urlRe.test(v.url)) return false; }
  if (q.focused && !v.focused) return false;
  return true;
}
// The text below a node, one string per piece of text, buttons left out.
function linesOf(el, max, st) {
  var out = [], stack = [[el, 0]];
  while (stack.length && out.length < max && st.n < st.max && now() < st.end) {
    var p = stack.pop(), b = readBase(p[0]);
    st.n++;
    if (!b) continue;
    var r = roleOf(b);
    if (r === 'text') { var t = norm(b.AXValue); if (t) out.push(clip(t, 300)); continue; }
    if (r === 'button' && p[1] > 0) continue;
    if (LEAF[b.AXRole] || p[1] > 40) continue;
    var k = kids(p[0]);
    for (var j = k.length - 1; j >= 0; j--) stack.push([k[j], p[1] + 1]);
  }
  return out;
}
// A node and what's below it, small: role, text, the language of a code block, a link's address, a heading's level.
function treeOf(el, st, depth) {
  if (st.n >= st.max || now() > st.end || depth > 60) { st.cut = true; return null; }
  var b = readBase(el);
  st.n++;
  if (!b) return null;
  var r = roleOf(b), o = { r: r };
  if (r === 'text' || r === 'marker') { o.v = typeof b.AXValue === 'string' ? b.AXValue : String(b.AXTitle || b.AXDescription || ''); return o; }
  if (r === 'button' || r === 'image' || r === 'textbox' || r === 'secret' || r === 'column') return depth === 0 ? o : null;
  if (r === 'link') o.u = urlOf(el);
  if (r === 'heading') { var lv = js(attr(el, 'AXDisclosureLevel')); o.l = (Number(lv) || 0) + 1; }
  var c = (b.cls || []).filter(function (x) { return /^language-/.test(x); });
  if (c.length) o.c = c.join(' ');
  var k = kids(el), out = [];
  for (var i = 0; i < k.length; i++) { var t = treeOf(k[i], st, depth + 1); if (t) out.push(t); }
  if (out.length) o.k = out;
  return o;
}

// One walk of the page (or of one node), answering several questions at once:
// {"queries": {"send": {"role": "button", "name": "^send", "last": true}, ...}}. A question can ask for the last match
// ("last"), the first few ("limit"), only how many ("count"), not to look inside its matches ("skip"), only matches
// inside another question's matches ("within"), the text lines of each match ("lines": n) or its whole tree ("tree").
function scan(a) {
  requireTrust();
  attach();
  var root, doc = null;
  if (a.root) root = resolve(a.root);
  else {
    var w = claudeWeb(false);
    if (!w) fail('no-page', 'The Claude app has no page open.');
    root = w.el;
    doc = { url: w.url, title: w.title };
  }
  var names = Object.keys(a.queries || {}), qs = {}, kept = {}, count = {};
  names.forEach(function (k) { qs[k] = compile(a.queries[k]); kept[k] = []; count[k] = 0; });
  var st = { nodes: 0, cut: '', order: 0 };
  var end = now() + (a.budgetMs || 4000), max = a.maxNodes || 8000;
  var stack = [[root, 0, []]];
  while (stack.length) {
    if (st.nodes >= max) { st.cut = 'nodes'; break; }
    if (now() > end) { st.cut = 'time'; break; }
    var p = stack.pop(), el = p[0], d = p[1], inside = p[2];
    var b = readBase(el);
    st.nodes++;
    if (!b) continue;
    var v = view(b), skip = false, here = inside;
    st.order++;
    for (var i = 0; i < names.length; i++) {
      var k = names[i], q = qs[k];
      if (q.within && inside.indexOf(q.within) < 0) continue;
      if (!matches(q, v, el)) continue;
      count[k]++;
      var hit = { el: el, v: v, i: st.order };
      if (q.count) {} else if (q.last) kept[k] = [hit]; else if (kept[k].length < (q.limit || 50)) kept[k].push(hit);
      if (q.skip) skip = true;
      if (here === inside) here = inside.slice();
      here.push(k);
    }
    if (skip || LEAF[b.AXRole] || d >= 90) continue;
    var ks = kids(el);
    for (var j = ks.length - 1; j >= 0; j--) stack.push([ks[j], d + 1, here]);
  }
  var found = {};
  names.forEach(function (k) {
    var q = qs[k];
    found[k] = kept[k].map(function (hit) {
      var v = hit.v, n = { h: handleFor(hit.el, v), i: hit.i, role: v.role, name: clip(v.name, 300) };
      if (v.alt) n.alt = clip(v.alt, 300);
      if (v.value) n.value = clip(v.value, q.valueMax || 2000);
      if (v.checked !== undefined) n.checked = v.checked;
      if (v.focused) n.focused = true;
      if (v.disabled) n.disabled = true;
      if (v.url) n.url = v.url;
      var lim = { n: 0, max: 3000, end: now() + 2500 };
      if (q.lines) n.lines = linesOf(hit.el, q.lines, lim);
      if (q.tree) { n.tree = treeOf(hit.el, lim, 0); if (lim.cut) n.cut = true; }
      return n;
    });
  });
  return { found: found, count: count, doc: doc, nodes: st.nodes, cut: st.cut };
}

// ------------------------------------------------------------------------------------------------------------- input
function frontPid() { tick(); var f = $.NSWorkspace.sharedWorkspace.frontmostApplication; return nil(f) ? 0 : Number(f.processIdentifier); }
// Brings the app forward: NSRunningApplication, then AXFrontmost, then LaunchServices.
function activate(pid) {
  if (frontPid() === pid) return 'already';
  var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!nil(a)) {
    try { if (a.isHidden) a.unhide; } catch (e) {}
    a.activateWithOptions(1 | 2);
    if (waitFor(function () { return frontPid() === pid; }, 1.0)) return 'app';
  }
  setAttr($.AXUIElementCreateApplication(pid), 'AXFrontmost', $(true));
  if (waitFor(function () { return frontPid() === pid; }, 1.0)) return 'ax';
  task('/usr/bin/open', ['-b', BUNDLE]);
  if (waitFor(function () { return frontPid() === pid; }, 2.0)) return 'open';
  return '';
}
// Puts back whichever app was in front before.
function giveBack(pid) {
  if (!pid || pid === S.pid || frontPid() === pid) return;
  var prev = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!nil(prev)) prev.activateWithOptions(2);
  if (!waitFor(function () { return frontPid() === pid; }, 0.8)) setAttr($.AXUIElementCreateApplication(pid), 'AXFrontmost', $(true));
}
function task(path, args) {
  var t = $.NSTask.alloc.init;
  t.executableURL = $.NSURL.fileURLWithPath(path);
  t.arguments = $(args);
  var err = $();
  if (!t.launchAndReturnError(err)) return -1;
  t.waitUntilExit;
  return Number(t.terminationStatus);
}
// Whether the person used the keyboard or mouse since `since` (and it wasn't one of these key presses).
function personActive(since) {
  var ref = Math.max(since, S.lastPostAt);
  var idle = Number($.CGEventSourceSecondsSinceLastEventType(1, ANY_INPUT));
  return idle * 1000 < now() - ref - 150;
}
function post(code, down, flags) {
  var e = $.CGEventCreateKeyboardEvent(null, code, down);
  if (!e) fail('key-failed', 'Could not make a key event.');
  $.CGEventSetFlags(e, flags || 0);
  $.CGEventSetIntegerValueField(e, 42, MARK);
  $.CGEventPost(0, e);
  S.lastPostAt = now();
}
function chord(code, flags) { post(code, true, flags); tick(0.012); post(code, false, flags); tick(0.012); }
function releaseMods() { MODKEYS.forEach(function (k) { try { post(k, false, 0); } catch (e) {} }); }
function guardKeys(focusEl) {
  if (frontPid() !== S.pid) fail('not-frontmost', 'The Claude app is not in front.');
  if (focusEl && !bool(focusEl, 'AXFocused')) fail('focus-lost', 'The message box lost the focus.');
  if (personActive(S.cmdStart)) fail('person-active', 'You were using the keyboard or mouse.');
}
// Types text with key events that carry the characters (no clipboard), 20 at a time; new lines with Shift+Return.
function typeText(text, focusEl) {
  var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (var li = 0; li < lines.length; li++) {
    if (li > 0) { guardKeys(focusEl); chord(KEY.return, FLAG.shift); }
    var s = lines[li];
    for (var at = 0; at < s.length; at += 20) {
      guardKeys(focusEl);
      var part = s.slice(at, at + 20), buf = $.malloc(part.length * 2);
      try {
        for (var i = 0; i < part.length; i++) { var c = part.charCodeAt(i); buf[i * 2] = c & 255; buf[i * 2 + 1] = c >> 8; }
        [true, false].forEach(function (down) {
          var e = $.CGEventCreateKeyboardEvent(null, 0, down);
          $.CGEventKeyboardSetUnicodeString(e, part.length, buf);
          $.CGEventSetIntegerValueField(e, 42, MARK);
          $.CGEventPost(0, e);
        });
        S.lastPostAt = now();
      } finally { $.free(buf); }
      tick(0.01);
    }
  }
}

// ---- the clipboard: everything on it is kept and put back, unless something else was copied in the meantime
function pbSave(pb) {
  try {
    var items = pb.pasteboardItems, out = [];
    if (nil(items)) return null;
    for (var i = 0; i < Number(items.count); i++) {
      var it = items.objectAtIndex(i), types = it.types, entry = [];
      for (var j = 0; j < Number(types.count); j++) {
        var t = types.objectAtIndex(j), d = it.dataForType(t);
        if (!nil(d)) entry.push({ t: t, d: d });
      }
      if (entry.length) out.push(entry);
    }
    return out;
  } catch (e) { return null; }
}
function pbRestore(pb, saved) {
  if (!saved) return false;
  pb.clearContents;
  if (!saved.length) return true;
  var arr = $.NSMutableArray.array;
  saved.forEach(function (entry) {
    var item = $.NSPasteboardItem.alloc.init;
    entry.forEach(function (x) { item.setDataForType(x.d, x.t); });
    arr.addObject(item);
  });
  return !!pb.writeObjects(arr);
}
function pbPut(pb, text) {
  var item = $.NSPasteboardItem.alloc.init;
  item.setStringForType($(text), $.NSPasteboardTypeString);
  // clipboard managers that follow nspasteboard.org don't keep these
  item.setStringForType($(''), $('org.nspasteboard.TransientType'));
  item.setStringForType($(''), $('org.nspasteboard.AutoGeneratedType'));
  pb.clearContents;
  pb.writeObjects($([item]));
  return Number(pb.changeCount);
}
// Edit > Paste in the app's menu, found by its shortcut, so it works in any language.
function pasteItem() {
  if (S.menuPaste) { try { if (str(S.menuPaste, 'AXRole') === 'AXMenuItem') return S.menuPaste; } catch (e) {} }
  var bar = attr(S.ax, 'AXMenuBar');
  if (nil(bar)) return null;
  var tops = kids(bar);
  for (var i = 1; i < tops.length; i++) {
    var menus = kids(tops[i]);
    for (var m = 0; m < menus.length; m++) {
      var items = kids(menus[m]);
      for (var k = 0; k < items.length; k++) {
        if (str(items[k], 'AXMenuItemCmdChar').toUpperCase() === 'V' && Number(js(attr(items[k], 'AXMenuItemCmdModifiers')) || 0) === 0) {
          S.menuPaste = items[k];
          return items[k];
        }
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------- requests
var CMD = {};

CMD.ping = function () {
  return { version: VERSION, trusted: trusted(false), os: jstr($.NSProcessInfo.processInfo.operatingSystemVersionString) };
};

// Asks macOS for the permission: {prompt: true} shows its alert and puts this program in the list in System Settings,
// switched off; {open: true} also opens Privacy & Security > Accessibility there.
CMD.trust = function (a) {
  var ok = trusted(!!a.prompt);
  if (!ok && a.open) $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString($('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')));
  return { trusted: ok };
};

// Where the app is, and whether it's running.
CMD.app = function () {
  var url = appUrl(), r = runningApp();
  var out = { path: url ? jstr(url.path) : '', running: !!r };
  if (r) {
    out.pid = Number(r.processIdentifier);
    out.hidden = !!r.isHidden;
    out.front = frontPid() === out.pid;
  }
  return out;
};

// Starts the app without bringing it forward. {reopen: true} asks a running app for its window back, still behind.
CMD.launch = function (a) {
  var r = runningApp();
  if (r && !a.reopen) return { pid: Number(r.processIdentifier), already: true };
  var url = appUrl();
  if (!url) fail('not-installed', 'The Claude app is not installed.');
  if (r) { task('/usr/bin/open', ['-g', '-b', BUNDLE]); return { pid: Number(r.processIdentifier), already: true }; }
  var conf = $.NSWorkspaceOpenConfiguration.configuration;
  conf.activates = false;
  conf.addsToRecentItems = false;
  $.NSWorkspace.sharedWorkspace.openApplicationAtURLConfigurationCompletionHandler(url, conf, null);
  var started = waitFor(function () { return runningApp(); }, 10, 0.2);
  if (!started) {
    task('/usr/bin/open', ['-g', '-b', BUNDLE]);
    started = waitFor(function () { return runningApp(); }, 20, 0.2);
  }
  if (!started) fail('launch-failed', 'The Claude app did not start.');
  return { pid: Number(started.processIdentifier), already: false };
};

// Opens one of the app's own links (claude://...) in it, behind other windows.
CMD.openUrl = function (a) {
  if (!/^claude:\/\//.test(String(a.url || ''))) fail('bad-url', String(a.url));
  return { status: task('/usr/bin/open', ['-g', String(a.url)]) };
};

// The app builds the tree of its page for tools like this one only once it's asked to (AXManualAccessibility, an
// Electron switch), about two seconds later. It's asked once per run of the app: asking again restarts the wait.
CMD.enable = function (a) {
  requireTrust();
  attach();
  if (S.manualFor !== S.pid) {
    setAttr(S.ax, 'AXManualAccessibility', $(true));
    S.manualFor = S.pid;
    S.manualAt = now();
  }
  var web = waitFor(function () { var w = claudeWeb(true); return w && w.kids > 0 ? w : null; }, (a.waitMs === undefined ? 10000 : a.waitMs) / 1000, 0.25);
  return { pid: S.pid, web: web ? { url: web.url, title: web.title } : null };
};

// Un-minimizes the app's window without bringing the app forward, so its page keeps drawing.
CMD.show = function () {
  requireTrust();
  attach();
  var w = mainWindow();
  if (!w) fail('no-window', 'The Claude app has no window.');
  if (bool(w, 'AXMinimized')) setAttr(w, 'AXMinimized', $(false));
  return { minimized: bool(w, 'AXMinimized') };
};

CMD.scan = function (a) { return scan(a); };

CMD.read = function (a) {
  requireTrust();
  attach();
  var b = readBase(resolve(a.h)) || {}, v = view(b);
  return { value: v.value, focused: v.focused, disabled: v.disabled, checked: v.checked };
};

// The same as a click on it, without the mouse, and without bringing the app forward.
CMD.press = function (a) {
  requireTrust();
  attach();
  var err = perform(resolve(a.h), 'AXPress');
  if (err !== 0 && err !== -25204) fail('press-failed', 'AXPress returned ' + err);
  return {};
};

// Puts the text in a text box directly (no keys, no clipboard, the app stays where it is).
CMD.setValue = function (a) {
  requireTrust();
  attach();
  var el = resolve(a.h);
  var err = setAttr(el, 'AXValue', $(String(a.text)));
  var want = norm(a.text).slice(0, 60);
  var got = waitFor(function () { return norm(str(el, 'AXValue')).indexOf(want) >= 0; }, 1.0);
  return { err: err, landed: !!got };
};

// Puts the text in a text box the way a person would: brings the app forward, clicks into the box, pastes, and puts back
// the clipboard and the app that was in front. With {type: true} it types the characters instead of pasting.
CMD.paste = function (a) {
  requireTrust();
  attach();
  var el = resolve(a.h);
  var before = frontPid();
  var out = { landed: false };
  try {
    if (!activate(S.pid)) fail('not-frontmost', 'The Claude app could not be brought forward.');
    if (!bool(el, 'AXFocused')) {
      setAttr(el, 'AXFocused', $(true));
      if (!waitFor(function () { return bool(el, 'AXFocused'); }, 1.0)) fail('focus-failed', 'Could not click into the message box.');
    }
    var start = str(el, 'AXValue'), want = norm(a.text).slice(0, 60);
    var landed = function () { var v = str(el, 'AXValue'); return v !== start && norm(v).indexOf(want) >= 0; };
    if (a.type) {
      typeText(a.text, el);
      out.landed = !!waitFor(landed, 1.5);
    } else {
      var pb = $.NSPasteboard.generalPasteboard;
      var saved = pbSave(pb);
      var mine = pbPut(pb, String(a.text));
      try {
        guardKeys(el);
        var item = pasteItem();
        if (item && js(attr(item, 'AXEnabled')) !== false) perform(item, 'AXPress');
        else chord(KEY.v, FLAG.cmd);
        out.landed = !!waitFor(landed, 1.5);
        if (!out.landed) { tick(0.5); out.landed = !!landed(); }
      } finally {
        tick(0.3); // the app reads the clipboard a moment after the paste
        if (Number(pb.changeCount) === mine) pbRestore(pb, saved);
      }
    }
  } finally {
    giveBack(before);
  }
  return out;
};

// A key in the app: Return or Escape. With {activate: true} the app comes forward for it, and goes back after.
CMD.key = function (a) {
  requireTrust();
  attach();
  var code = KEY[a.key];
  if (code === undefined) fail('bad-key', String(a.key));
  var before = frontPid();
  try {
    if (a.activate && !activate(S.pid)) fail('not-frontmost', 'The Claude app could not be brought forward.');
    var el = a.h ? resolve(a.h) : null;
    if (el && !bool(el, 'AXFocused')) { setAttr(el, 'AXFocused', $(true)); waitFor(function () { return bool(el, 'AXFocused'); }, 1.0); }
    guardKeys(el);
    chord(code, 0);
    tick(0.2);
  } finally {
    if (a.activate) giveBack(before);
  }
  return {};
};

// Seconds since the last key press or click.
CMD.idle = function () { return { seconds: Number($.CGEventSourceSecondsSinceLastEventType(1, ANY_INPUT)) }; };
CMD.forget = function () { S.handles = {}; S.nHandles = 0; return {}; };
CMD.quit = function () { $.exit(0); };

// ------------------------------------------------------------------------------------------------------------- main loop
function handle(line) {
  var req;
  try { req = JSON.parse(line); } catch (e) { send({ id: null, ok: false, error: 'bad-json', detail: String(e) }); return; }
  var id = req.id === undefined ? null : req.id;
  var fn = Object.prototype.hasOwnProperty.call(CMD, req.cmd) ? CMD[req.cmd] : null;
  if (!fn) { send({ id: id, ok: false, error: 'unknown-cmd', detail: String(req.cmd) }); return; }
  S.cmdStart = now();
  lastErr = 0;
  try {
    var res = fn(req) || {};
    res.id = id;
    res.ok = true;
    send(res);
  } catch (e) {
    var out = e instanceof Fail ? { error: e.code, detail: e.detail } : { error: 'exception', detail: String((e && e.message) || e) };
    if (lastErr === -25211) out.error = 'not-trusted';
    out.id = id;
    out.ok = false;
    send(out);
  }
}

function run() {
  // a busy app doesn't hold every call for long
  $.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(), 1.5);
  send({ id: 0, ok: true, ready: true, version: VERSION, trusted: trusted(false) });
  var IN = $.NSFileHandle.fileHandleWithStandardInput;
  var NL = $('\n').dataUsingEncoding($.NSUTF8StringEncoding);
  var buf = $.NSMutableData.data;
  for (;;) {
    var chunk = IN.availableData; // waits for something; nothing at all means the program that started this has gone
    if (nil(chunk) || Number(chunk.length) === 0) break;
    buf.appendData(chunk);
    for (;;) {
      var len = Number(buf.length);
      var r = buf.rangeOfDataOptionsRange(NL, 0, $.NSMakeRange(0, len));
      if (Number(r.location) === Number($.NSNotFound) || Number(r.location) >= len) break;
      var at = Number(r.location);
      var line = jstr($.NSString.alloc.initWithDataEncoding(buf.subdataWithRange($.NSMakeRange(0, at)), $.NSUTF8StringEncoding));
      buf = $.NSMutableData.dataWithData(buf.subdataWithRange($.NSMakeRange(at + 1, len - at - 1)));
      if (line.trim()) handle(line);
    }
    if ($.getppid() === 1) break;
  }
  if (S.lastPostAt) { try { releaseMods(); } catch (e) {} }
  $.exit(0);
}
