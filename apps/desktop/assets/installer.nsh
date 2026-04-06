!macro customUnInstall
  ; Remove registry entries for autostart (if applicable)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Ripcord"
!macroend
