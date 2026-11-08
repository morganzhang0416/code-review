import { execFile } from 'node:child_process';
import path from 'node:path';

// Windows PowerShell 5.1 can raise WinRT toasts without extra modules; PowerShell 7 cannot.
const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$title = [Security.SecurityElement]::Escape($env:AM_TOAST_TITLE)
$body = [Security.SecurityElement]::Escape($env:AM_TOAST_BODY)
$launch = [Security.SecurityElement]::Escape($env:AM_TOAST_LAUNCH)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast activationType=""protocol"" launch=""$launch""><visual><binding template=""ToastGeneric""><text>$title</text><text>$body</text></binding></visual></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`;

/** Show a Windows toast that opens the report in VS Code when clicked. Never throws. */
export function notifyReportReady({ title, body, reportPath, log }) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const launch = `vscode://file/${reportPath.replace(/\\/g, '/')}`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, AM_TOAST_TITLE: title, AM_TOAST_BODY: body, AM_TOAST_LAUNCH: launch },
      },
      (err, _stdout, stderr) => {
        if (err) {
          log?.warn(`notification failed: ${String(stderr || err.message).trim().split(/\r?\n/)[0]}`);
          resolve(false);
        } else {
          resolve(true);
        }
      },
    );
  });
}
