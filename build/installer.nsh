!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var BenchForgeDesktopShortcutCheckbox
  Var BenchForgeCreateDesktopShortcut
!endif

LangString BenchForgeShortcutPageTitle 1033 "Shortcuts"
LangString BenchForgeShortcutPageTitle 1045 "Skróty"
LangString BenchForgeShortcutPageTitle 1031 "Verknüpfungen"
LangString BenchForgeShortcutPageTitle 3082 "Accesos directos"

LangString BenchForgeShortcutPageSubtitle 1033 "Choose additional shortcuts before installing BenchForge."
LangString BenchForgeShortcutPageSubtitle 1045 "Wybierz dodatkowe skróty przed instalacją BenchForge."
LangString BenchForgeShortcutPageSubtitle 1031 "Wählen Sie zusätzliche Verknüpfungen vor der Installation von BenchForge."
LangString BenchForgeShortcutPageSubtitle 3082 "Elige accesos directos adicionales antes de instalar BenchForge."

LangString BenchForgeDesktopShortcutLabel 1033 "Create a desktop shortcut"
LangString BenchForgeDesktopShortcutLabel 1045 "Utwórz skrót na pulpicie"
LangString BenchForgeDesktopShortcutLabel 1031 "Desktop-Verknüpfung erstellen"
LangString BenchForgeDesktopShortcutLabel 3082 "Crear acceso directo en el escritorio"

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Page custom BenchForgeShortcutPageCreate BenchForgeShortcutPageLeave
!macroend

Function BenchForgeShortcutPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${if} $0 == error
    Abort
  ${endif}

  ${NSD_CreateLabel} 0 0u 100% 12u "$(BenchForgeShortcutPageTitle)"
  Pop $1
  ${NSD_CreateLabel} 0 16u 100% 18u "$(BenchForgeShortcutPageSubtitle)"
  Pop $1

  ${NSD_CreateCheckbox} 0 44u 100% 14u "$(BenchForgeDesktopShortcutLabel)"
  Pop $BenchForgeDesktopShortcutCheckbox
  ${NSD_Check} $BenchForgeDesktopShortcutCheckbox

  nsDialogs::Show
FunctionEnd

Function BenchForgeShortcutPageLeave
  ${NSD_GetState} $BenchForgeDesktopShortcutCheckbox $BenchForgeCreateDesktopShortcut
FunctionEnd

!macro customInstall
  ${if} $BenchForgeCreateDesktopShortcut != ${BST_CHECKED}
    Delete "$newDesktopLink"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${endif}
!macroend
!endif

!macro customRemoveFiles
  ; BenchForge is portable-first: runtime data lives under $INSTDIR\data.
  ; On real uninstall remove everything. During an update, preserve data while
  ; replacing app files so users do not lose benchmarks/results/API settings.
  ${if} ${isUpdated}
    RMDir /r "$PLUGINSDIR\benchforge-data"
    ${if} ${FileExists} "$INSTDIR\data\*.*"
      Rename "$INSTDIR\data" "$PLUGINSDIR\benchforge-data"
    ${endif}
  ${endif}

  RMDir /r "$INSTDIR"

  ${if} ${isUpdated}
    ${if} ${FileExists} "$PLUGINSDIR\benchforge-data\*.*"
      CreateDirectory "$INSTDIR"
      Rename "$PLUGINSDIR\benchforge-data" "$INSTDIR\data"
    ${endif}
  ${endif}
!macroend

!macro customUnInstall
  ; Final safety pass: remove the installation directory if it is empty after
  ; customRemoveFiles and shortcut/registry cleanup.
  RMDir "$INSTDIR"
!macroend
