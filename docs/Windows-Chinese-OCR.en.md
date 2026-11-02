# Installing Chinese text recognition (OCR) on Windows

Juanzhi reads images, scans and phone photos with the OCR engine that ships with Windows. **Windows only includes the English engine by default; the Chinese one must be installed once.** Without it, Chinese text in images comes out as garbage and the AI splits questions badly.

You only do this once. Text-based PDFs and Word files do not need OCR (Juanzhi reads their text directly).

> Tip: Method 1 (Settings) is the most reliable. Method 2 (one PowerShell line) is faster if you have administrator rights or need to set up several PCs.

Juanzhi asks Windows directly for the Simplified Chinese (zh-Hans-CN) recognizer, so once the Chinese OCR capability is installed it works; Chinese does **not** have to be in your Windows preferred-language list (so the Method 2 one-liner is enough). This has not been confirmed on every real machine: if Settings still shows English only afterwards, add Chinese through Method 1 as well.

## Before you start

- The PC must be **online** (the package comes from Microsoft; tens of MB, a few minutes).
- On a work or school PC an administrator may block language-feature downloads. If so, ask them, or use a vision model inside Juanzhi instead (see the end).
- You do **not** need to change the Windows display language or the keyboard.

## Method 1: Settings, Windows 11

1. Start menu -> **Settings** -> **Time & language** -> **Language & region**.
2. Next to "Preferred languages" click **Add a language**.
3. Search for "Chinese", choose **Chinese (Simplified, China)**, click **Next**.
4. In the optional language features, make sure **Optical character recognition** is ticked. The others (speech, handwriting, basic typing) are optional.
5. Untick **Set as my Windows display language** if you want to keep your current interface language, then click **Install**.
6. Wait until it shows as installed, then **close and reopen Juanzhi**.

## Method 1: Settings, Windows 10

1. Start menu -> **Settings** (gear) -> **Time & Language** -> **Language** on the left.
2. Click **Add a preferred language** (some builds say "Add a language").
3. Pick **Chinese (Simplified, China)**, click **Next**.
4. Under optional language features make sure **Optical character recognition** is ticked ("Basic typing" can be ticked too), untick **Set as my Windows display language**, and click **Install**.
5. Wait for the download to finish (the spinner next to the language disappears), then **close and reopen Juanzhi**.

## Method 2: administrator PowerShell, one line

1. Search for **PowerShell** in the Start menu, right-click it, choose **Run as administrator**, and click Yes.
2. Paste this whole line and press Enter:

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'Language.OCR~~~zh-CN~*' | Add-WindowsCapability -Online
```

3. Wait for it to finish. A successful run prints `Online : True` and `RestartNeeded : False`.
4. To confirm, run:

```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'Language.OCR*' | Format-Table Name, State -AutoSize
```

`Language.OCR~~~zh-CN~0.0.1.0` with State `Installed` means it worked.

> Note: this is the same command our automated Windows tests (GitHub Actions) use, but it has **not been verified on every Windows build and every managed-PC setup**. If you get "not found", `0x800f0954`, or "access denied", use Method 1 instead, or send us the full error text.

## Check that Juanzhi can use it

1. Reopen Juanzhi, go to **Settings** and expand **Admin settings** at the bottom.
2. In the **Text recognition (OCR)** card the status should read **Available** (shown as "可用") and the detail should mention **zh-Hans-CN**. If it still shows English only, click **Re-check** ("重新检测"); if that fails, restart the PC and try again.
3. When a scanned paper has recognition problems, you will see a notice on the paper details and in the processing queue instead of silent errors.

## If you cannot or do not want to install it

- Under **Settings -> Admin settings -> AI service**, set a **vision model** that can read images; poor scans are sent to it. Note that **those page images are then sent to the AI provider you chose** (text PDFs and Word files never send images). If you do not want images sent, do not set a vision model; install Chinese OCR instead.
- Prefer text-based PDF or Word files when you have them; they are the most accurate.

## Still stuck

In Juanzhi open **Settings -> About**, click **Export diagnostics** ("导出诊断信息"), then **Report a problem** ("反馈问题"), and drag the zip into the issue. The diagnostics contain no student data or keys. Please do not write student names or API keys in the issue.

Chinese version: [Windows中文识别安装.md](Windows中文识别安装.md)
