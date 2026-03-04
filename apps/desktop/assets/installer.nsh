!macro customUnInstall
  ; Remove app data from %APPDATA%/Ripcord
  RMDir /r "$APPDATA\Ripcord"

  ; Remove app data from %LOCALAPPDATA%/Ripcord (electron cache, GPU cache, etc.)
  RMDir /r "$LOCALAPPDATA\Ripcord"

  ; Remove registry entries for autostart (if applicable)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Ripcord"
!macroend
