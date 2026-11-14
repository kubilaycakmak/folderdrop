using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;

internal static class FolderDrop
{
    [STAThread]
    private static int Main(string[] args)
    {
        var directory = AppDomain.CurrentDomain.BaseDirectory;
        var configured = args.Length > 0;
        try
        {
            var start = new ProcessStartInfo(Path.Combine(directory, "runtime", "node.exe"));
            start.Arguments = Quote(Path.Combine(directory, "app", "bin", "folderdrop.js"));
            foreach (var argument in args) start.Arguments += " " + Quote(argument);
            start.WorkingDirectory = directory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            if (!configured)
            {
                start.RedirectStandardError = true;
                start.RedirectStandardOutput = true;
            }

            using (var process = Process.Start(start))
            {
                if (configured)
                {
                    process.WaitForExit();
                }
                else
                {
                    var output = process.StandardOutput.ReadToEndAsync();
                    var error = process.StandardError.ReadToEndAsync();
                    process.WaitForExit();
                    if (process.ExitCode != 0)
                        ShowError(error.GetAwaiter().GetResult().Trim());
                    output.GetAwaiter().GetResult();
                }
                return process.ExitCode;
            }
        }
        catch (Exception)
        {
            if (!configured) ShowError("Check that the FolderDrop archive was extracted completely and try again.");
            return 1;
        }
    }

    private static void ShowError(string message)
    {
        if (String.IsNullOrWhiteSpace(message)) message = "The workspace could not start.";
        MessageBox.Show(message, "FolderDrop", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static string Quote(string argument)
    {
        return "\"" + Regex.Replace(argument, "(\\\\*)(\"|$)", match =>
            match.Groups[1].Value + match.Groups[1].Value + (match.Groups[2].Length == 1 ? "\\\"" : "")) + "\"";
    }
}
