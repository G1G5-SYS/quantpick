/* 生成 QuantPick 品牌图标 app.ico(多尺寸 PNG 嵌入)
 * 红金风格: 红渐变圆角底 + 金色上升箭头 + 金元宝(外金环+内方孔)
 * 编译: csc /nologo /r:System.Drawing.dll /out:MakeIcon.exe MakeIcon.cs */
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

class MakeIcon {
    static Bitmap Draw(int size) {
        var bmp = new Bitmap(size, size);
        var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);
        float s = size / 256f;
        int r = (int)(48 * s);
        var rect = new Rectangle(0, 0, size, size);
        using (var gp = new GraphicsPath()) {
            int d = 2 * r;
            gp.AddArc(rect.X, rect.Y, d, d, 180, 90);
            gp.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            gp.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            gp.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            gp.CloseFigure();
            using (var lg = new LinearGradientBrush(rect, Color.FromArgb(230, 48, 48), Color.FromArgb(150, 10, 20), 45f)) {
                g.FillPath(lg, gp);
            }
            using (var sh = new SolidBrush(Color.FromArgb(28, 255, 255, 255))) {
                g.FillEllipse(sh, rect.X, rect.Y, size, size * 0.6f);
            }
        }
        float pw = Math.Max(3, 20 * s);
        using (var pen = new Pen(Color.FromArgb(255, 224, 143), pw))
        using (pen) {
            pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round; pen.LineJoin = LineJoin.Round;
            var pts = new PointF[] {
                new PointF(60*s,176*s), new PointF(112*s,120*s), new PointF(140*s,146*s), new PointF(196*s,84*s)
            };
            g.DrawLines(pen, pts);
            g.DrawLine(pen, 168*s, 84*s, 196*s, 84*s);
            g.DrawLine(pen, 196*s, 84*s, 196*s, 112*s);
        }
        using (var gold = new SolidBrush(Color.FromArgb(255, 211, 77))) g.FillEllipse(gold, 178*s, 166*s, 62*s, 62*s);
        using (var gold2 = new SolidBrush(Color.FromArgb(245, 179, 1))) g.FillEllipse(gold2, 186*s, 174*s, 46*s, 46*s);
        using (var hole = new SolidBrush(Color.FromArgb(200, 16, 46))) g.FillRectangle(hole, 198*s, 186*s, 22*s, 22*s);
        g.Dispose();
        return bmp;
    }
    static void Main() {
        var sizes = new[] { 256, 48, 32, 16 };
        var imgs = new List<byte[]>();
        foreach (var sz in sizes) {
            using (var b = Draw(sz)) { using (var ms = new MemoryStream()) { b.Save(ms, ImageFormat.Png); imgs.Add(ms.ToArray()); } }
        }
        using (var fs = File.Create("app.ico")) {
            var bw = new BinaryWriter(fs);
            bw.Write((short)0); bw.Write((short)1); bw.Write((short)sizes.Length);
            int off = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++) {
                int wh = sizes[i] >= 256 ? 0 : sizes[i];
                bw.Write((byte)wh); bw.Write((byte)wh); bw.Write((byte)0); bw.Write((byte)0);
                bw.Write((short)1); bw.Write((short)32); bw.Write(imgs[i].Length); bw.Write(off);
                off += imgs[i].Length;
            }
            foreach (var im in imgs) bw.Write(im);
        }
        // 输出 256 PNG 便于预览
        Directory.CreateDirectory("icons");
        using (var b = Draw(256)) b.Save(Path.Combine("icons", "preview.png"), ImageFormat.Png);
        Console.WriteLine("app.ico 生成完成: " + sizes.Length + " 个尺寸");
    }
}
