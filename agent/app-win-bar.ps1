# The Stop bar: shown at the top of the screen, over every window, while the program is using the Claude app on this
# computer. Pressing Stop takes the app back at once: nothing more is typed or clicked in it.
#
#   $env:CLAUDECONNECT_BAR = '{"text": "...", "label": "Stop", "parent": 1234}'
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File app-win-bar.ps1
#
# It's its own small process, so it answers whatever the helper doing the work is busy with. It writes "ready" once it's
# on the screen and "stop" when Stop is pressed, then ends. On stdin it takes 'text {"text": "...", "label": "..."}' to
# change what it says, and "quit". It ends by itself when stdin ends or the program that started it goes away. It never
# takes the focus from what you're doing.

$ErrorActionPreference = 'Stop'
$names = @('System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions')
try {
  foreach ($n in $names) { Add-Type -AssemblyName $n }
  $refs = @([AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $names -contains $_.GetName().Name } | ForEach-Object { $_.Location })
} catch {
  [Console]::Error.WriteLine("Windows is missing a part this needs: " + $_.Exception.Message)
  exit 2
}

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ClaudeConnect
{
    public class StopBar : Form
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        Label label;
        Button stop;
        float scale = 1f;
        Point dragFrom;
        bool dragging;
        static TextWriter Out;

        // never activated: clicks reach the Stop button without taking the focus from the window you're in
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008; // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST
                return cp;
            }
        }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0021) { m.Result = (IntPtr)3; return; } // WM_MOUSEACTIVATE -> MA_NOACTIVATE
            base.WndProc(ref m);
        }

        public StopBar(string text, string stopLabel)
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(33, 33, 33);
            using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;

            label = new Label();
            label.ForeColor = Color.White;
            label.BackColor = Color.Transparent;
            label.Font = new Font("Segoe UI", 10f, FontStyle.Regular);
            label.AutoEllipsis = true;
            label.TextAlign = ContentAlignment.MiddleLeft;
            Controls.Add(label);

            stop = new Button();
            stop.FlatStyle = FlatStyle.Flat;
            stop.FlatAppearance.BorderSize = 0;
            stop.BackColor = Color.FromArgb(220, 38, 38);
            stop.ForeColor = Color.White;
            stop.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            stop.Cursor = Cursors.Hand;
            stop.TabStop = false;
            stop.Click += delegate { Say("stop"); Environment.Exit(0); };
            Controls.Add(stop);

            // it can be moved out of the way
            MouseEventHandler down = delegate (object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) { dragging = true; dragFrom = Cursor.Position; } };
            MouseEventHandler move = delegate (object s, MouseEventArgs e)
            {
                if (!dragging) return;
                Point now = Cursor.Position;
                Location = new Point(Location.X + now.X - dragFrom.X, Location.Y + now.Y - dragFrom.Y);
                dragFrom = now;
            };
            MouseEventHandler up = delegate { dragging = false; };
            foreach (Control c in new Control[] { this, label })
            {
                c.MouseDown += down;
                c.MouseMove += move;
                c.MouseUp += up;
            }

            Relabel(text, stopLabel);
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Left + (wa.Width - Width) / 2, wa.Top + (int)(10 * scale));
        }

        int S(float v) { return (int)Math.Round(v * scale); }

        public void Relabel(string text, string stopLabel)
        {
            if (!string.IsNullOrEmpty(stopLabel)) stop.Text = stopLabel;
            label.Text = text;
            int bw = Math.Max(S(84), TextRenderer.MeasureText(stop.Text, stop.Font).Width + S(28));
            int tw = Math.Min(S(560), TextRenderer.MeasureText(text, label.Font).Width + S(8));
            int h = S(44);
            ClientSize = new Size(S(36) + tw + S(12) + bw + S(8), h);
            label.SetBounds(S(36), 0, tw, h);
            stop.SetBounds(ClientSize.Width - bw - S(8), S(8), bw, h - S(16));
            using (GraphicsPath p = Rounded(new Rectangle(0, 0, ClientSize.Width, ClientSize.Height), S(12)))
                Region = new Region(p);
            using (GraphicsPath b = Rounded(new Rectangle(0, 0, stop.Width, stop.Height), S(8)))
                stop.Region = new Region(b);
            Invalidate();
        }

        static GraphicsPath Rounded(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            int d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (SolidBrush dot = new SolidBrush(Color.FromArgb(16, 163, 127)))
                e.Graphics.FillEllipse(dot, S(16), (ClientSize.Height - S(10)) / 2, S(10), S(10));
        }

        static void Say(string s)
        {
            lock (Out) { Out.Write(s + "\n"); Out.Flush(); }
        }

        public static void Run()
        {
            try { SetProcessDPIAware(); } catch { }
            Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            JavaScriptSerializer json = new JavaScriptSerializer();
            string text = "Using the Claude app", stopLabel = "Stop";
            int parent = 0;
            try
            {
                Dictionary<string, object> o = json.DeserializeObject(Environment.GetEnvironmentVariable("CLAUDECONNECT_BAR") ?? "{}") as Dictionary<string, object>;
                if (o != null)
                {
                    if (o.ContainsKey("text") && o["text"] != null) text = o["text"].ToString();
                    if (o.ContainsKey("label") && o["label"] != null) stopLabel = o["label"].ToString();
                    if (o.ContainsKey("parent") && o["parent"] != null) parent = Convert.ToInt32(o["parent"]);
                }
            }
            catch { }

            Application.EnableVisualStyles();
            StopBar bar = new StopBar(text, stopLabel);

            // the program that started it going away ends it too
            System.Windows.Forms.Timer watch = new System.Windows.Forms.Timer();
            watch.Interval = 500;
            watch.Tick += delegate
            {
                if (parent <= 0) return;
                try { if (Process.GetProcessById(parent).HasExited) Environment.Exit(0); }
                catch { Environment.Exit(0); }
            };
            watch.Start();

            // lines on stdin, read beside the window
            Thread reader = new Thread(delegate ()
            {
                TextReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (line == "quit") break;
                    if (line.StartsWith("text "))
                    {
                        try
                        {
                            Dictionary<string, object> t = json.DeserializeObject(line.Substring(5)) as Dictionary<string, object>;
                            if (t == null) continue;
                            string nt = t.ContainsKey("text") && t["text"] != null ? t["text"].ToString() : text;
                            string nl = t.ContainsKey("label") && t["label"] != null ? t["label"].ToString() : "";
                            bar.BeginInvoke((MethodInvoker)delegate { bar.Relabel(nt, nl); });
                        }
                        catch { }
                    }
                }
                Environment.Exit(0);
            });
            reader.IsBackground = true;
            reader.Start();

            bar.Shown += delegate { Say("ready"); };
            Application.Run(bar);
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -ReferencedAssemblies $refs -Language CSharp
} catch {
  [Console]::Error.WriteLine("The Stop bar couldn't start: " + $_.Exception.Message)
  exit 2
}
[ClaudeConnect.StopBar]::Run()
