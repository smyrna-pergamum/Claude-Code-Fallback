' Creates "CC Desk" shortcuts on the Desktop and in the Start menu.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
exe = appDir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  WScript.Echo "Electron not found. Run npm install in " & appDir & " first."
  WScript.Quit 1
End If
For Each folder In Array(sh.SpecialFolders("Desktop"), sh.SpecialFolders("Programs"))
  Set lnk = sh.CreateShortcut(folder & "\CC Desk.lnk")
  lnk.TargetPath = exe
  lnk.Arguments = """" & appDir & """"
  lnk.WorkingDirectory = appDir
  lnk.Description = "Claude Code with cc-fallback"
  lnk.IconLocation = exe & ",0"
  lnk.Save
Next
WScript.Echo "CC Desk shortcuts created on the Desktop and in the Start menu."
