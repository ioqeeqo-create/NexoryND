; Удаляем только старые установщики/portable с версией в имени в папке текущего .exe
; (например "Flow 2.2.2.exe", "Flow Setup 2.2.3.exe"). Кеш и %AppData% не трогаем.
!macro customInstall
  Push $R0
  Push $R1
  Push $R2
  FindFirst $R0 $R1 "$EXEDIR\Flow*.exe"
  loopCleanupOldFlowExe:
    StrCmp $R1 "" doneCleanupOldFlowExe
    StrCmp "$EXEDIR\$R1" "$EXEPATH" nextCleanupOldFlowExe
    StrCpy $R2 $R1 11
    StrCmp $R2 "Flow Setup " delOldFlowExe
    StrCpy $R2 $R1 5
    StrCmp $R2 "Flow " delOldFlowExe
    Goto nextCleanupOldFlowExe
  delOldFlowExe:
    Delete "$EXEDIR\$R1"
  nextCleanupOldFlowExe:
    FindNext $R0 $R1
    Goto loopCleanupOldFlowExe
  doneCleanupOldFlowExe:
  FindClose $R0
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
