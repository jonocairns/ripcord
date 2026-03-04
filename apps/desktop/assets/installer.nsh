!macro customUnInstall
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "Also remove local Ripcord app data from this PC? This deletes settings, caches, and other local data stored under AppData." IDYES custom_uninstall_remove_app_data
  Goto custom_uninstall_cleanup_registry

custom_uninstall_remove_app_data:
  ; Remove app data from %APPDATA%/Ripcord
  RMDir /r "$APPDATA\Ripcord"

  ; Remove app data from %LOCALAPPDATA%/Ripcord (electron cache, GPU cache, etc.)
  RMDir /r "$LOCALAPPDATA\Ripcord"

custom_uninstall_cleanup_registry:
  ; Remove registry entries for autostart (if applicable)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Ripcord"
!macroend
