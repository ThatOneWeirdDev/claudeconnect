# The helper that works the Claude app on Windows, through Windows UI Automation: the same way Narrator and automation
# tools work. It reads the app's window as a tree of buttons, text boxes and text, presses buttons, and puts your message
# in the message box. It never starts the app in a debugging mode and never closes it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File app-win.ps1
#
# It runs as long as the program that started it (app-os.mjs), reading one request per line on stdin and answering one
# line on stdout, in JSON: {"id": 7, "cmd": "scan", ...} -> {"id": 7, "ok": true, ...} or {"id": 7, "ok": false,
# "error": "<code>", "detail": "..."}. Its first line is {"id": 0, "ok": true, "ready": true}. Both directions are pure
# ASCII. It stops when stdin ends. The work is done in C#, compiled here by Windows PowerShell 5.1's own compiler (C# 5).

$ErrorActionPreference = 'Stop'
$names = @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Windows.Forms', 'System.Web.Extensions')
try {
  foreach ($n in $names) { Add-Type -AssemblyName $n }
  $refs = @([AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $names -contains $_.GetName().Name } | ForEach-Object { $_.Location })
} catch {
  [Console]::Error.WriteLine("Windows is missing a part this needs: " + $_.Exception.Message)
  exit 2
}

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace ClaudeConnect
{
    public class Failure : Exception
    {
        public string Code;
        public Failure(string code, string detail) : base(detail) { Code = code; }
    }

    class View
    {
        public string Role = "", Name = "", Alt = "", Value = "", Cls = "", Url = "";
        public bool Focused, Disabled, HasChecked, Checked;
    }

    class Query
    {
        public string[] Roles;
        public Regex NameRe, AnyRe, NotRe, ValueRe, ClsRe, UrlRe;
        public string Within;
        public bool Last, Count, Skip, Tree, Focused;
        public int Limit = 50, Lines = 0, ValueMax = 2000, TreeMax = 4000;
    }

    class Hit
    {
        public AutomationElement El;
        public View V;
        public int I;
    }

    public static class AppHelper
    {
        const uint MARK = 0x43434f4e;
        static JavaScriptSerializer Json = new JavaScriptSerializer();
        static TextWriter Out;
        // handles last two generations, so one given out just before a new generation starts still works
        static Dictionary<string, AutomationElement> Handles = new Dictionary<string, AutomationElement>();
        static Dictionary<string, AutomationElement> Older = new Dictionary<string, AutomationElement>();
        static Dictionary<string, string> HandleRoles = new Dictionary<string, string>();
        static int Next = 1;
        static IntPtr Hwnd = IntPtr.Zero;
        static AutomationElement Doc = null;
        static int LastPost = 0, CmdStart = 0;
        static Dictionary<string, object> Info = new Dictionary<string, object>();

        // ------------------------------------------------------------------------------------------------- Windows
        delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
        [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder s, ref uint size);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

        static void Fail(string code, string detail) { throw new Failure(code, detail); }

        static string ImagePath(int pid)
        {
            IntPtr h = OpenProcess(0x1000, false, (uint)pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return "";
            try
            {
                StringBuilder s = new StringBuilder(1024);
                uint n = 1024;
                return QueryFullProcessImageName(h, 0, s, ref n) ? s.ToString() : "";
            }
            finally { CloseHandle(h); }
        }

        // The Claude app's processes: from its Store package or its own folder, never Claude Code's claude.exe.
        static Dictionary<uint, bool> AppPids(Dictionary<string, object> info)
        {
            string dir = Str(info, "path"), exe = Str(info, "exe");
            string exeDir = exe.Length > 0 ? Path.GetDirectoryName(exe) : "";
            // a test names another Chromium program to stand in for the app
            string other = Str(info, "process");
            Dictionary<uint, bool> pids = new Dictionary<uint, bool>();
            if (other.Length > 0)
            {
                foreach (Process p in Process.GetProcessesByName(other)) pids[(uint)p.Id] = true;
                return pids;
            }
            foreach (Process p in Process.GetProcessesByName("claude"))
            {
                string path = ImagePath(p.Id);
                string low = path.ToLowerInvariant();
                bool mine = (dir.Length > 0 && low.StartsWith(dir.ToLowerInvariant().TrimEnd('\\') + "\\"))
                    || (exeDir.Length > 0 && low.StartsWith(exeDir.ToLowerInvariant().TrimEnd('\\') + "\\"))
                    || low.Contains("\\windowsapps\\claude_") || low.Contains("\\anthropicclaude\\") || low.Contains("\\programs\\claude\\");
                if (mine) pids[(uint)p.Id] = true;
            }
            return pids;
        }

        // The app's window: the biggest Chromium window of its processes with a title.
        static IntPtr FindWindow(Dictionary<uint, bool> pids)
        {
            IntPtr best = IntPtr.Zero;
            long bestArea = -1;
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (!pids.ContainsKey(pid)) return true;
                StringBuilder cls = new StringBuilder(256);
                GetClassName(h, cls, 256);
                if (!cls.ToString().StartsWith("Chrome_WidgetWin_")) return true;
                RECT r;
                GetWindowRect(h, out r);
                long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
                if (IsIconic(h)) area = 1;
                if (area > bestArea) { bestArea = area; best = h; }
                return true;
            }, IntPtr.Zero);
            return best;
        }

        static bool Front(IntPtr h)
        {
            if (GetForegroundWindow() == h) return true;
            if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
            uint pid;
            uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            uint me = GetCurrentThreadId();
            bool joined = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
            try
            {
                BringWindowToTop(h);
                SetForegroundWindow(h);
            }
            finally { if (joined) AttachThreadInput(me, fg, false); }
            for (int i = 0; i < 20 && GetForegroundWindow() != h; i++) Thread.Sleep(50);
            return GetForegroundWindow() == h;
        }
        static void GiveBack(IntPtr prev)
        {
            if (prev == IntPtr.Zero || prev == Hwnd || !IsWindow(prev) || GetForegroundWindow() == prev) return;
            Front(prev);
        }

        // ------------------------------------------------------------------------------------------------- keys
        static INPUT Key(ushort vk, ushort scan, uint flags)
        {
            INPUT i = new INPUT();
            i.type = 1; // INPUT_KEYBOARD
            i.u.ki.wVk = vk;
            i.u.ki.wScan = scan;
            i.u.ki.dwFlags = flags;
            i.u.ki.dwExtraInfo = new IntPtr((long)MARK);
            return i;
        }
        static void Send(params INPUT[] keys)
        {
            SendInput((uint)keys.Length, keys, Marshal.SizeOf(typeof(INPUT)));
            LastPost = Environment.TickCount;
        }
        static void Chord(ushort vk, ushort mod)
        {
            if (mod != 0) Send(Key(mod, 0, 0), Key(vk, 0, 0), Key(vk, 0, 2), Key(mod, 0, 2));
            else Send(Key(vk, 0, 0), Key(vk, 0, 2));
            Thread.Sleep(30);
        }
        static uint LastInput()
        {
            LASTINPUTINFO li = new LASTINPUTINFO();
            li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            GetLastInputInfo(ref li);
            return li.dwTime;
        }
        // Whether the person used the keyboard or mouse since this request began (not counting these key presses).
        static bool PersonActive()
        {
            int last = (int)LastInput();
            int since = Math.Max(CmdStart, LastPost);
            return last - since > 150;
        }
        static void GuardKeys(AutomationElement el)
        {
            if (GetForegroundWindow() != Hwnd) Fail("not-frontmost", "The Claude app is not in front.");
            if (el != null && !el.Current.HasKeyboardFocus) Fail("focus-lost", "The message box lost the focus.");
            if (PersonActive()) Fail("person-active", "You were using the keyboard or mouse.");
        }
        static void TypeText(string text, AutomationElement el)
        {
            string[] lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            for (int li = 0; li < lines.Length; li++)
            {
                if (li > 0) { GuardKeys(el); Chord(0x0D, 0x10); } // Shift+Enter: a new line, not send
                string s = lines[li];
                for (int at = 0; at < s.Length; at += 20)
                {
                    GuardKeys(el);
                    string part = s.Substring(at, Math.Min(20, s.Length - at));
                    List<INPUT> keys = new List<INPUT>();
                    foreach (char c in part) { keys.Add(Key(0, c, 4)); keys.Add(Key(0, c, 4 | 2)); } // KEYEVENTF_UNICODE
                    Send(keys.ToArray());
                    Thread.Sleep(10);
                }
            }
        }

        // ------------------------------------------------------------------------------------------------- UI Automation
        static CacheRequest cache;
        static CacheRequest Cache()
        {
            if (cache != null) return cache;
            CacheRequest cr = new CacheRequest();
            cr.TreeScope = TreeScope.Subtree;
            cr.TreeFilter = Automation.RawViewCondition;
            cr.AutomationElementMode = AutomationElementMode.Full;
            cr.Add(AutomationElement.NameProperty);
            cr.Add(AutomationElement.ControlTypeProperty);
            cr.Add(AutomationElement.LocalizedControlTypeProperty);
            cr.Add(AutomationElement.ClassNameProperty);
            cr.Add(AutomationElement.HelpTextProperty);
            cr.Add(AutomationElement.IsEnabledProperty);
            cr.Add(AutomationElement.HasKeyboardFocusProperty);
            cr.Add(AutomationElement.IsPasswordProperty);
            cr.Add(AutomationElement.IsTogglePatternAvailableProperty);
            cr.Add(AutomationElement.IsValuePatternAvailableProperty);
            cr.Add(TogglePattern.ToggleStateProperty);
            cr.Add(ValuePattern.ValueProperty);
            cache = cr;
            return cr;
        }
        static object Cached(AutomationElement e, AutomationProperty p)
        {
            try
            {
                object v = e.GetCachedPropertyValue(p, true);
                return v == AutomationElement.NotSupported ? null : v;
            }
            catch { return null; }
        }
        static string CStr(AutomationElement e, AutomationProperty p) { object v = Cached(e, p); return v == null ? "" : v.ToString(); }

        static string RoleOf(AutomationElement e, string parent, int kids)
        {
            ControlType ct = Cached(e, AutomationElement.ControlTypeProperty) as ControlType;
            string lt = CStr(e, AutomationElement.LocalizedControlTypeProperty).ToLowerInvariant();
            bool toggle = Cached(e, AutomationElement.IsTogglePatternAvailableProperty) is bool && (bool)Cached(e, AutomationElement.IsTogglePatternAvailableProperty);
            if (ct == null) return "group";
            if (ct == ControlType.Button || ct == ControlType.SplitButton) return toggle ? "toggle" : "button";
            if (ct == ControlType.Edit) return Cached(e, AutomationElement.IsPasswordProperty) is bool && (bool)Cached(e, AutomationElement.IsPasswordProperty) ? "secret" : "textbox";
            if (ct == ControlType.ComboBox) return "textbox";
            if (ct == ControlType.Text)
            {
                if (lt == "heading") return "heading";
                if (kids == 0) return "text";
                if (lt == "code") return "code";
                if (lt == "strong") return "strong";
                if (lt == "emphasis") return "em";
                return "group";
            }
            if (ct == ControlType.Hyperlink) return "link";
            if (ct == ControlType.Document) return "document";
            if (ct == ControlType.List) return "list";
            if (ct == ControlType.ListItem) return "listitem";
            if (ct == ControlType.Menu) return "menu";
            if (ct == ControlType.MenuItem) return "menuitem";
            if (ct == ControlType.CheckBox) return lt == "switch" ? "switch" : "checkbox";
            if (ct == ControlType.RadioButton) return "radio";
            if (ct == ControlType.Table || ct == ControlType.DataGrid) return "table";
            if (ct == ControlType.HeaderItem || ct == ControlType.Header) return parent == "row" ? "cell" : "row";
            if (ct == ControlType.DataItem) return parent == "row" ? "cell" : (parent == "table" || parent == "group") ? "row" : "cell";
            if (ct == ControlType.Image) return "image";
            if (ct == ControlType.Separator) return "separator";
            if (ct == ControlType.Window || ct == ControlType.Pane || ct == ControlType.Group || ct == ControlType.Custom)
            {
                if (lt == "dialog") return "dialog";
                if (lt == "alert dialog") return "alertdialog";
                if (lt == "alert") return "alert";
                if (lt == "code") return "code";
                if (lt == "strong") return "strong";
                if (lt == "emphasis") return "em";
                return "group";
            }
            string n = ct.ProgrammaticName;
            return n.Substring(n.LastIndexOf('.') + 1).ToLowerInvariant();
        }

        static View ViewOf(AutomationElement e, string parent, int kids)
        {
            View v = new View();
            v.Role = RoleOf(e, parent, kids);
            v.Name = CStr(e, AutomationElement.NameProperty);
            v.Alt = CStr(e, AutomationElement.HelpTextProperty);
            if (v.Alt == v.Name) v.Alt = "";
            string value = CStr(e, ValuePattern.ValueProperty);
            if (v.Role == "link") v.Url = value;
            else if (v.Role != "secret" && v.Role != "document") v.Value = value;
            if (v.Role == "text" && v.Value.Length == 0) v.Value = v.Name;
            v.Cls = CStr(e, AutomationElement.ClassNameProperty);
            object f = Cached(e, AutomationElement.HasKeyboardFocusProperty);
            v.Focused = f is bool && (bool)f;
            object en = Cached(e, AutomationElement.IsEnabledProperty);
            v.Disabled = en is bool && !(bool)en;
            object t = Cached(e, TogglePattern.ToggleStateProperty);
            if (t is ToggleState) { v.HasChecked = true; v.Checked = (ToggleState)t == ToggleState.On; }
            return v;
        }

        static void NewGeneration()
        {
            if (Handles.Count < 10000) return;
            Older = Handles;
            Handles = new Dictionary<string, AutomationElement>();
            HandleRoles.Clear();
        }
        static string HandleFor(AutomationElement e, string role)
        {
            string h = "h" + (Next++);
            Handles[h] = e;
            HandleRoles[h] = role;
            return h;
        }
        static AutomationElement Resolve(string h)
        {
            AutomationElement e = null;
            if (h == null || (!Handles.TryGetValue(h, out e) && !Older.TryGetValue(h, out e))) Fail("stale-handle", "That part of the app is gone.");
            try
            {
                ControlType ct = e.Current.ControlType;
                if (ct == null) Fail("stale-handle", "That part of the app is gone.");
            }
            catch (ElementNotAvailableException) { Fail("stale-handle", "That part of the app is gone."); }
            return e;
        }

        static string UrlOf(AutomationElement doc)
        {
            try
            {
                object p;
                if (doc.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return ((ValuePattern)p).Current.Value ?? "";
            }
            catch { }
            return "";
        }
        // The page inside the window; the one on claude.ai is the conversation.
        static AutomationElement FindDoc()
        {
            if (Hwnd == IntPtr.Zero || !IsWindow(Hwnd)) return null;
            AutomationElement win = AutomationElement.FromHandle(Hwnd);
            AutomationElementCollection docs = win.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
            AutomationElement best = null;
            foreach (AutomationElement d in docs)
            {
                string u = UrlOf(d);
                if (Regex.IsMatch(u, "^https://([a-z0-9-]+\\.)?claude\\.ai(/|$)", RegexOptions.IgnoreCase)) return d;
                if (best == null) best = d;
            }
            return best;
        }
        static bool Alive(AutomationElement e)
        {
            if (e == null) return false;
            try { return e.Current.ControlType == ControlType.Document; } catch { return false; }
        }
        static void Attach(Dictionary<string, object> a)
        {
            if (Hwnd == IntPtr.Zero || !IsWindow(Hwnd) || !IsWindowVisible(Hwnd))
            {
                Hwnd = FindWindow(AppPids(Info));
                Doc = null;
            }
            if (Hwnd == IntPtr.Zero) Fail("no-window", "The Claude app has no window open.");
            if (!Alive(Doc)) Doc = FindDoc();
            if (Doc == null) Fail("no-page", "The Claude app has no page open.");
        }

        // ------------------------------------------------------------------------------------------------- reading
        static Query Compile(Dictionary<string, object> q)
        {
            Query c = new Query();
            if (q.ContainsKey("role"))
            {
                object r = q["role"];
                if (r is string) c.Roles = new string[] { (string)r };
                else if (r is IList) { IList arr = (IList)r; c.Roles = new string[arr.Count]; for (int i = 0; i < arr.Count; i++) c.Roles[i] = Convert.ToString(arr[i]); }
            }
            c.NameRe = Re(q, "name"); c.AnyRe = Re(q, "any"); c.NotRe = Re(q, "not"); c.ValueRe = Re(q, "value"); c.ClsRe = Re(q, "cls"); c.UrlRe = Re(q, "url");
            c.Within = Str(q, "within");
            c.Last = Bool(q, "last"); c.Count = Bool(q, "count"); c.Skip = Bool(q, "skip"); c.Tree = Bool(q, "tree"); c.Focused = Bool(q, "focused");
            if (q.ContainsKey("limit")) c.Limit = Convert.ToInt32(q["limit"]);
            if (q.ContainsKey("lines")) c.Lines = Convert.ToInt32(q["lines"]);
            if (q.ContainsKey("valueMax")) c.ValueMax = Convert.ToInt32(q["valueMax"]);
            if (q.ContainsKey("treeMax")) c.TreeMax = Convert.ToInt32(q["treeMax"]);
            return c;
        }
        static Regex Re(Dictionary<string, object> q, string k)
        {
            string s = Str(q, k);
            return s.Length > 0 ? new Regex(s, RegexOptions.IgnoreCase) : null;
        }
        static bool Matches(Query q, View v)
        {
            if (q.Roles != null && Array.IndexOf(q.Roles, v.Role) < 0) return false;
            if (q.NameRe != null && !q.NameRe.IsMatch(v.Name) && !(v.Alt.Length > 0 && q.NameRe.IsMatch(v.Alt))) return false;
            if (q.AnyRe != null && !q.AnyRe.IsMatch(v.Name + " " + v.Alt + " " + v.Value)) return false;
            if (q.NotRe != null && q.NotRe.IsMatch(v.Name)) return false;
            if (q.ValueRe != null && !q.ValueRe.IsMatch(v.Value)) return false;
            if (q.ClsRe != null && !q.ClsRe.IsMatch(v.Cls)) return false;
            if (q.UrlRe != null && !q.UrlRe.IsMatch(v.Url)) return false;
            if (q.Focused && !v.Focused) return false;
            return true;
        }
        static AutomationElement[] Kids(AutomationElement e)
        {
            try
            {
                AutomationElementCollection c = e.CachedChildren;
                AutomationElement[] out1 = new AutomationElement[c.Count];
                c.CopyTo(out1, 0);
                return out1;
            }
            catch { return new AutomationElement[0]; }
        }
        static List<object> LinesOf(AutomationElement e, int max, string parent)
        {
            List<object> out1 = new List<object>();
            Stack<object[]> stack = new Stack<object[]>();
            stack.Push(new object[] { e, parent, 0 });
            int n = 0;
            while (stack.Count > 0 && out1.Count < max && n++ < 3000)
            {
                object[] p = stack.Pop();
                AutomationElement el = (AutomationElement)p[0];
                AutomationElement[] ks = Kids(el);
                View v = ViewOf(el, (string)p[1], ks.Length);
                if (v.Role == "text") { string t = Regex.Replace(v.Value, "\\s+", " ").Trim(); if (t.Length > 0) out1.Add(t.Length > 300 ? t.Substring(0, 300) : t); continue; }
                if (v.Role == "button" && (int)p[2] > 0) continue;
                for (int j = ks.Length - 1; j >= 0; j--) stack.Push(new object[] { ks[j], v.Role, (int)p[2] + 1 });
            }
            return out1;
        }
        static Dictionary<string, object> TreeOf(AutomationElement e, string parent, int depth, int[] budget)
        {
            if (budget[0]-- <= 0 || depth > 60) return null;
            AutomationElement[] ks = Kids(e);
            View v = ViewOf(e, parent, ks.Length);
            Dictionary<string, object> o = new Dictionary<string, object>();
            o["r"] = v.Role;
            if (v.Role == "text") { o["v"] = v.Value; return o; }
            if (v.Role == "button" || v.Role == "image" || v.Role == "textbox" || v.Role == "secret") return depth == 0 ? o : null;
            if (v.Role == "link") o["u"] = v.Url;
            Match m = Regex.Match(v.Cls, "(^|\\s)(language-[\\w+#.-]+)");
            if (m.Success) o["c"] = m.Groups[2].Value;
            List<object> out1 = new List<object>();
            foreach (AutomationElement k in ks)
            {
                Dictionary<string, object> t = TreeOf(k, v.Role, depth + 1, budget);
                if (t != null) out1.Add(t);
            }
            if (v.Role == "heading" && out1.Count == 0 && v.Name.Length > 0) { Dictionary<string, object> t = new Dictionary<string, object>(); t["r"] = "text"; t["v"] = v.Name; out1.Add(t); }
            if (out1.Count > 0) o["k"] = out1;
            return o;
        }

        // One walk of the page (or of one part of it), answering several questions at once. The same requests as app-mac.js.
        static Dictionary<string, object> Scan(Dictionary<string, object> a)
        {
            AutomationElement start;
            Dictionary<string, object> doc = null;
            if (Str(a, "root").Length > 0) start = Resolve(Str(a, "root"));
            else
            {
                Attach(a);
                start = Doc;
                doc = new Dictionary<string, object>();
                doc["url"] = UrlOf(Doc);
                doc["title"] = Doc.Current.Name ?? "";
            }
            NewGeneration();
            AutomationElement root;
            try { root = start.GetUpdatedCache(Cache()); }
            catch (ElementNotAvailableException) { Doc = null; throw new Failure("no-page", "The page changed."); }
            Dictionary<string, object> queries = Dict(a, "queries");
            List<string> names = new List<string>(queries.Keys);
            Dictionary<string, Query> qs = new Dictionary<string, Query>();
            Dictionary<string, List<Hit>> kept = new Dictionary<string, List<Hit>>();
            Dictionary<string, object> count = new Dictionary<string, object>();
            foreach (string k in names) { qs[k] = Compile(Dict(queries, k)); kept[k] = new List<Hit>(); count[k] = 0; }
            int max = a.ContainsKey("maxNodes") ? Convert.ToInt32(a["maxNodes"]) : 12000;
            int nodes = 0, order = 0;
            string cut = "";
            Stack<object[]> stack = new Stack<object[]>();
            stack.Push(new object[] { root, 0, new List<string>(), "" });
            while (stack.Count > 0)
            {
                if (nodes >= max) { cut = "nodes"; break; }
                object[] p = stack.Pop();
                AutomationElement el = (AutomationElement)p[0];
                int d = (int)p[1];
                List<string> inside = (List<string>)p[2];
                AutomationElement[] ks = Kids(el);
                View v = ViewOf(el, (string)p[3], ks.Length);
                nodes++;
                order++;
                bool skip = false;
                List<string> here = inside;
                foreach (string k in names)
                {
                    Query q = qs[k];
                    if (q.Within.Length > 0 && !inside.Contains(q.Within)) continue;
                    if (!Matches(q, v)) continue;
                    count[k] = (int)count[k] + 1;
                    Hit hit = new Hit();
                    hit.El = el; hit.V = v; hit.I = order;
                    if (q.Count) { }
                    else if (q.Last) { kept[k].Clear(); kept[k].Add(hit); }
                    else if (kept[k].Count < q.Limit) kept[k].Add(hit);
                    if (q.Skip) skip = true;
                    if (here == inside) here = new List<string>(inside);
                    here.Add(k);
                }
                if (skip || v.Role == "text" || v.Role == "textbox" || v.Role == "secret" || d >= 90) continue;
                for (int j = ks.Length - 1; j >= 0; j--) stack.Push(new object[] { ks[j], d + 1, here, v.Role });
            }
            Dictionary<string, object> found = new Dictionary<string, object>();
            foreach (string k in names)
            {
                Query q = qs[k];
                List<object> list = new List<object>();
                foreach (Hit hit in kept[k])
                {
                    View v = hit.V;
                    Dictionary<string, object> n = new Dictionary<string, object>();
                    n["h"] = HandleFor(hit.El, v.Role);
                    n["i"] = hit.I;
                    n["role"] = v.Role;
                    n["name"] = Clip(v.Name, 300);
                    if (v.Alt.Length > 0) n["alt"] = Clip(v.Alt, 300);
                    if (v.Value.Length > 0) n["value"] = Clip(v.Value, q.ValueMax);
                    if (v.HasChecked) n["checked"] = v.Checked;
                    if (v.Focused) n["focused"] = true;
                    if (v.Disabled) n["disabled"] = true;
                    if (v.Url.Length > 0) n["url"] = v.Url;
                    if (q.Lines > 0) n["lines"] = LinesOf(hit.El, q.Lines, "");
                    if (q.Tree)
                    {
                        int[] budget = new int[] { q.TreeMax };
                        n["tree"] = TreeOf(hit.El, "", 0, budget);
                        if (budget[0] <= 0) n["cut"] = true;
                    }
                    list.Add(n);
                }
                found[k] = list;
            }
            Dictionary<string, object> res = new Dictionary<string, object>();
            res["found"] = found;
            res["count"] = count;
            res["doc"] = doc;
            res["nodes"] = nodes;
            res["cut"] = cut;
            return res;
        }

        // ------------------------------------------------------------------------------------------------- the clipboard
        // What's on it is kept and put back afterwards, unless something else was copied in the meantime.
        static System.Windows.Forms.DataObject SaveClipboard()
        {
            try
            {
                System.Windows.Forms.IDataObject d = System.Windows.Forms.Clipboard.GetDataObject();
                if (d == null) return null;
                System.Windows.Forms.DataObject copy = new System.Windows.Forms.DataObject();
                foreach (string f in d.GetFormats(false))
                {
                    try { object v = d.GetData(f, false); if (v != null) copy.SetData(f, false, v); } catch { }
                }
                return copy;
            }
            catch { return null; }
        }
        static uint PutClipboard(string text)
        {
            System.Windows.Forms.DataObject d = new System.Windows.Forms.DataObject();
            d.SetData(System.Windows.Forms.DataFormats.UnicodeText, false, text);
            // left out of Windows' clipboard history and cloud clipboard
            d.SetData("ExcludeClipboardContentFromMonitorProcessing", false, new MemoryStream(new byte[] { 0, 0, 0, 0 }));
            d.SetData("CanIncludeInClipboardHistory", false, new MemoryStream(new byte[] { 0, 0, 0, 0 }));
            d.SetData("CanUploadToCloudClipboard", false, new MemoryStream(new byte[] { 0, 0, 0, 0 }));
            System.Windows.Forms.Clipboard.SetDataObject(d, true, 5, 100);
            return GetClipboardSequenceNumber();
        }

        // ------------------------------------------------------------------------------------------------- requests
        static Dictionary<string, object> Handle(string cmd, Dictionary<string, object> a)
        {
            Dictionary<string, object> r = new Dictionary<string, object>();
            switch (cmd)
            {
                case "ping":
                    r["version"] = 1;
                    r["trusted"] = true;
                    r["os"] = Environment.OSVersion.VersionString;
                    return r;
                case "trust":
                    r["trusted"] = true;
                    return r;
                case "app":
                {
                    Dictionary<string, object> info = Info;
                    Dictionary<uint, bool> pids = AppPids(info);
                    r["path"] = Str(info, "path").Length > 0 ? Str(info, "path") : Str(info, "exe");
                    r["running"] = pids.Count > 0;
                    if (pids.Count > 0)
                    {
                        IntPtr w = FindWindow(pids);
                        r["window"] = w != IntPtr.Zero;
                        r["front"] = w != IntPtr.Zero && GetForegroundWindow() == w;
                    }
                    return r;
                }
                case "launch":
                {
                    // Started by its app id (Store) or its program; the window that was in front gets the focus back.
                    Dictionary<string, object> info = Info;
                    bool already = AppPids(info).Count > 0;
                    if (already && !Bool(a, "reopen")) { r["already"] = true; return r; }
                    IntPtr prev = GetForegroundWindow();
                    string aumid = Str(info, "aumid"), exe = Str(info, "exe"), path = Str(info, "path");
                    ProcessStartInfo psi;
                    if (aumid.Length > 0) psi = new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + aumid);
                    else if (exe.Length > 0) psi = new ProcessStartInfo(exe);
                    else if (path.Length > 0) psi = new ProcessStartInfo(path);
                    else { Fail("not-installed", "The Claude app is not installed."); return r; }
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                    IntPtr w = IntPtr.Zero;
                    for (int i = 0; i < 300 && w == IntPtr.Zero; i++) { Thread.Sleep(100); w = FindWindow(AppPids(info)); }
                    if (w == IntPtr.Zero) Fail("launch-failed", "The Claude app did not open.");
                    Hwnd = w;
                    Doc = null;
                    Thread.Sleep(500);
                    GiveBack(prev);
                    r["already"] = already;
                    return r;
                }
                case "openUrl":
                {
                    string url = Str(a, "url");
                    if (!url.StartsWith("claude://")) Fail("bad-url", url);
                    IntPtr prev = GetForegroundWindow();
                    ProcessStartInfo psi = new ProcessStartInfo(url);
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                    Thread.Sleep(800);
                    GiveBack(prev);
                    return r;
                }
                case "enable":
                {
                    // Chromium builds the page's tree once something asks for it, a moment later
                    int wait = a.ContainsKey("waitMs") ? Convert.ToInt32(a["waitMs"]) : 10000;
                    int end = Environment.TickCount + wait;
                    for (;;)
                    {
                        try
                        {
                            Attach(a);
                            if (TreeWalker.RawViewWalker.GetFirstChild(Doc) != null)
                            {
                                Dictionary<string, object> web = new Dictionary<string, object>();
                                web["url"] = UrlOf(Doc);
                                web["title"] = Doc.Current.Name ?? "";
                                r["web"] = web;
                                return r;
                            }
                        }
                        catch (Failure) { }
                        catch (ElementNotAvailableException) { Doc = null; }
                        if (Environment.TickCount - end > 0) { r["web"] = null; return r; }
                        Thread.Sleep(250);
                    }
                }
                case "show":
                    if (Hwnd != IntPtr.Zero && IsIconic(Hwnd)) ShowWindow(Hwnd, 4); // SW_SHOWNOACTIVATE
                    r["minimized"] = Hwnd != IntPtr.Zero && IsIconic(Hwnd);
                    return r;
                case "scan":
                    return Scan(a);
                case "read":
                {
                    AutomationElement e = Resolve(Str(a, "h"));
                    object p;
                    r["value"] = e.TryGetCurrentPattern(ValuePattern.Pattern, out p) ? (((ValuePattern)p).Current.Value ?? "") : "";
                    r["focused"] = e.Current.HasKeyboardFocus;
                    r["disabled"] = !e.Current.IsEnabled;
                    if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) r["checked"] = ((TogglePattern)p).Current.ToggleState == ToggleState.On;
                    return r;
                }
                case "press":
                {
                    // the same as a click on it, without the mouse and without bringing the app forward
                    AutomationElement e = Resolve(Str(a, "h"));
                    object p;
                    if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) ((InvokePattern)p).Invoke();
                    else if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) ((TogglePattern)p).Toggle();
                    else if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) ((SelectionItemPattern)p).Select();
                    else if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p))
                    {
                        ExpandCollapsePattern ec = (ExpandCollapsePattern)p;
                        if (ec.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) ec.Expand(); else ec.Collapse();
                    }
                    else Fail("press-failed", "That can't be pressed.");
                    return r;
                }
                case "setValue":
                {
                    AutomationElement e = Resolve(Str(a, "h"));
                    object p;
                    if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) Fail("no-value", "That box can't be filled in directly.");
                    string text = Str(a, "text");
                    ((ValuePattern)p).SetValue(text);
                    string want = Regex.Replace(text, "\\s+", " ").Trim();
                    if (want.Length > 60) want = want.Substring(0, 60);
                    bool landed = false;
                    for (int i = 0; i < 10 && !landed; i++)
                    {
                        Thread.Sleep(100);
                        landed = Regex.Replace(((ValuePattern)p).Current.Value ?? "", "\\s+", " ").Contains(want);
                    }
                    r["landed"] = landed;
                    return r;
                }
                case "paste":
                {
                    // the way a person would: the app forward, a click into the box, a paste, then the clipboard and the
                    // window that was in front put back. With "type" it types the characters instead.
                    AutomationElement e = Resolve(Str(a, "h"));
                    IntPtr prev = GetForegroundWindow();
                    bool landed = false;
                    try
                    {
                        if (!Front(Hwnd)) Fail("not-frontmost", "The Claude app could not be brought forward.");
                        object p;
                        bool hasValue = e.TryGetCurrentPattern(ValuePattern.Pattern, out p);
                        // whatever an earlier try left in the box goes first, so the message isn't there twice
                        if (hasValue) { try { ((ValuePattern)p).SetValue(""); } catch { } }
                        e.SetFocus();
                        for (int i = 0; i < 20 && !e.Current.HasKeyboardFocus; i++) Thread.Sleep(50);
                        if (!e.Current.HasKeyboardFocus) Fail("focus-failed", "Could not click into the message box.");
                        GuardKeys(e);
                        Chord(0x41, 0x11); // Ctrl+A: what's left in the box is replaced
                        string text = Str(a, "text");
                        string want = Regex.Replace(text, "\\s+", "");
                        if (Bool(a, "type")) TypeText(text, e);
                        else
                        {
                            System.Windows.Forms.DataObject saved = SaveClipboard();
                            // what's on the clipboard can't be kept: it isn't touched, and the text is typed instead
                            if (saved == null) Fail("clipboard-unreadable", "The clipboard could not be read, so it was left alone.");
                            uint mine = PutClipboard(text);
                            try
                            {
                                GuardKeys(e);
                                Chord(0x56, 0x11); // Ctrl+V
                                Thread.Sleep(400);
                            }
                            finally
                            {
                                if (GetClipboardSequenceNumber() == mine)
                                {
                                    try { System.Windows.Forms.Clipboard.SetDataObject(saved, true, 5, 100); } catch { }
                                }
                            }
                        }
                        for (int i = 0; i < 15 && !landed; i++)
                        {
                            string now = hasValue ? (((ValuePattern)p).Current.Value ?? "") : "";
                            landed = !hasValue || Regex.Replace(now, "\\s+", "") == want;
                            if (!landed) Thread.Sleep(100);
                        }
                    }
                    finally { GiveBack(prev); }
                    r["landed"] = landed;
                    return r;
                }
                case "key":
                {
                    string k = Str(a, "key");
                    ushort vk = k == "return" ? (ushort)0x0D : k == "escape" ? (ushort)0x1B : (ushort)0;
                    if (vk == 0) Fail("bad-key", k);
                    IntPtr prev = GetForegroundWindow();
                    try
                    {
                        if (Bool(a, "activate") && !Front(Hwnd)) Fail("not-frontmost", "The Claude app could not be brought forward.");
                        AutomationElement e = Str(a, "h").Length > 0 ? Resolve(Str(a, "h")) : null;
                        if (e != null && !e.Current.HasKeyboardFocus) { e.SetFocus(); Thread.Sleep(150); }
                        GuardKeys(e);
                        Chord(vk, 0);
                        Thread.Sleep(200);
                    }
                    finally { if (Bool(a, "activate")) GiveBack(prev); }
                    return r;
                }
                case "idle":
                    r["seconds"] = (Environment.TickCount - (int)LastInput()) / 1000.0;
                    return r;
                case "forget":
                    Handles.Clear();
                    Older.Clear();
                    HandleRoles.Clear();
                    return r;
                case "quit":
                    Environment.Exit(0);
                    return r;
            }
            Fail("unknown-cmd", cmd);
            return r;
        }

        // ------------------------------------------------------------------------------------------------- JSON lines
        static string Str(Dictionary<string, object> d, string k)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : "";
        }
        static bool Bool(Dictionary<string, object> d, string k)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v is bool && (bool)v;
        }
        static Dictionary<string, object> Dict(Dictionary<string, object> d, string k)
        {
            object v;
            if (d != null && d.TryGetValue(k, out v) && v is Dictionary<string, object>) return (Dictionary<string, object>)v;
            return new Dictionary<string, object>();
        }
        static string Clip(string s, int n) { return s.Length > n ? s.Substring(0, n) : s; }
        static string Ascii(string s)
        {
            StringBuilder b = new StringBuilder(s.Length + 16);
            foreach (char c in s)
            {
                if (c < 0x7f) b.Append(c);
                else b.Append("\\u").Append(((int)c).ToString("x4"));
            }
            return b.ToString();
        }
        static void Write(Dictionary<string, object> o)
        {
            Out.Write(Ascii(Json.Serialize(o)) + "\n");
            Out.Flush();
        }

        public static void Run()
        {
            Json.MaxJsonLength = int.MaxValue;
            Json.RecursionLimit = 1000;
            Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            TextReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            Dictionary<string, object> hello = new Dictionary<string, object>();
            hello["id"] = 0; hello["ok"] = true; hello["ready"] = true; hello["version"] = 1; hello["trusted"] = true;
            Write(hello);
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                Dictionary<string, object> req = null;
                object id = null;
                Dictionary<string, object> res;
                try
                {
                    req = Json.DeserializeObject(line) as Dictionary<string, object>;
                    if (req == null) throw new Failure("bad-json", "not an object");
                    req.TryGetValue("id", out id);
                    if (req.ContainsKey("info")) Info = Dict(req, "info");
                    CmdStart = Environment.TickCount;
                    res = Handle(Str(req, "cmd"), req);
                    res["ok"] = true;
                }
                catch (Failure f)
                {
                    res = new Dictionary<string, object>();
                    res["ok"] = false; res["error"] = f.Code; res["detail"] = f.Message;
                }
                catch (ElementNotAvailableException e)
                {
                    res = new Dictionary<string, object>();
                    res["ok"] = false; res["error"] = "stale-handle"; res["detail"] = e.Message;
                }
                catch (Exception e)
                {
                    res = new Dictionary<string, object>();
                    res["ok"] = false; res["error"] = "exception"; res["detail"] = e.GetType().Name + ": " + e.Message;
                }
                res["id"] = id;
                Write(res);
            }
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -ReferencedAssemblies $refs -Language CSharp
} catch {
  [Console]::Error.WriteLine("The helper couldn't start: " + $_.Exception.Message)
  exit 2
}
[ClaudeConnect.AppHelper]::Run()
