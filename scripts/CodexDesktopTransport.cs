using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

internal static class CodexDesktopTransport
{
    private static int Main(string[] args)
    {
        try
        {
            var bin = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            string root = bin.Parent.Parent.FullName;
            string node = File.ReadAllText(Path.Combine(bin.FullName, "node-path.txt")).Trim();
            string codex = File.ReadAllText(Path.Combine(bin.FullName, "codex-path.txt")).Trim();
            string script = Path.Combine(root, "src", "native-desktop-host.mjs");
            string arguments = String.Join(" ", new[] { script, codex }.Concat(args).Select(Quote));
            var info = new ProcessStartInfo(node, arguments);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (var child = Process.Start(info))
            {
                Task.Run(async () =>
                {
                    try { await Relay(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                    catch (IOException) { }
                    finally { try { child.StandardInput.Close(); } catch (IOException) { } }
                });
                var output = Relay(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                var error = Relay(child.StandardError.BaseStream, Console.OpenStandardError());
                child.WaitForExit();
                Task.WaitAll(output, error);
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Codex desktop bridge could not start: " + error.Message);
            return 1;
        }
    }

    private static async Task Relay(Stream source, Stream destination)
    {
        byte[] buffer = new byte[16384];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) != 0)
        {
            await destination.WriteAsync(buffer, 0, count);
            await destination.FlushAsync();
        }
    }

    private static string Quote(string value)
    {
        string escaped = Regex.Replace(value, "(\\\\*)\"", match => match.Groups[1].Value + match.Groups[1].Value + "\\\"");
        escaped = Regex.Replace(escaped, "(\\\\+)$", "$1$1");
        return "\"" + escaped + "\"";
    }
}
