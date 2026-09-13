/* QuantPick 桌面版自解压启动器
 * 把自己(exe)末尾追加的 ZIP(含 node.exe + 项目文件)解压到 %LOCALAPPDATA%\QuantPick,
 * 然后启动 run.cmd(打开浏览器 + node server.js)。
 * 编译: csc /nologo /out:stub.exe /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll SelfExtract.cs */
using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;

class QuantPickLauncher {
    static int Main() {
        try {
            string self = Assembly.GetExecutingAssembly().Location;
            byte[] all = File.ReadAllBytes(self);
            int zipStart = FindZipStart(all);
            if (zipStart < 0) { Console.WriteLine("错误: 未找到程序数据(请重新下载安装包)"); Pause(); return 1; }
            string target = Environment.GetEnvironmentVariable("QUANTPICK_HOME");
            if (string.IsNullOrEmpty(target))
                target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuantPick");
            Directory.CreateDirectory(target);
            using (MemoryStream ms = new MemoryStream(all, zipStart, all.Length - zipStart, false))
            using (ZipArchive zip = new ZipArchive(ms, ZipArchiveMode.Read)) {
                foreach (ZipArchiveEntry e in zip.Entries) {
                    if (string.IsNullOrEmpty(e.Name)) continue;           // 目录项
                    string dest = Path.Combine(target, e.FullName.Replace('/', Path.DirectorySeparatorChar));
                    string dir = Path.GetDirectoryName(dest);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    using (Stream s = e.Open())
                    using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.Read)) {
                        s.CopyTo(fs);
                    }
                }
            }
            string cmd = Path.Combine(target, "run.cmd");
            Process.Start(new ProcessStartInfo(cmd) { WorkingDirectory = target, UseShellExecute = true });
            return 0;
        } catch (Exception ex) {
            Console.WriteLine("启动失败: " + ex.Message);
            if (ex.InnerException != null) Console.WriteLine("  详细: " + ex.InnerException.Message);
            Pause();
            return 1;
        }
    }
    /* 从末尾找 ZIP 中央目录结束标记(EOCD "PK\x05\x06"), 推算 zip 数据物理起点
     * zip 物理起点 = 物理中央目录起始 - cdOff(相对zip起点) = (EOCD位置 - cdSize) - cdOff */
    static int FindZipStart(byte[] b) {
        for (int i = b.Length - 22; i >= 0; i--) {
            if (b[i] == 0x50 && b[i + 1] == 0x4B && b[i + 2] == 0x05 && b[i + 3] == 0x06) {
                long cdOff = BitConverter.ToUInt32(b, i + 16);
                long cdSize = BitConverter.ToUInt32(b, i + 12);
                long cdStart = i - cdSize;              // 物理中央目录起始
                long zipStart = cdStart - cdOff;        // 物理 zip 数据起点
                if (zipStart >= 0 && zipStart < cdStart &&
                    b[zipStart] == 0x50 && b[zipStart + 1] == 0x4B && b[zipStart + 2] == 0x03 && b[zipStart + 3] == 0x04)
                    return (int)zipStart;               // 校验首个本地头签名 "PK\x03\x04"
            }
        }
        return -1;
    }
    static void Pause() {
        try { Console.WriteLine("按任意键退出..."); Console.ReadKey(); } catch { }
    }
}
