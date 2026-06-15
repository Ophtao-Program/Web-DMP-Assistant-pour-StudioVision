' ============================================================================
'  Se-Connecter-WebDMP (sans fenetre).vbs
'
'  Demarre le service WebDMP en arriere-plan, SANS aucune fenetre terminal.
'  -> C'est CE fichier qu'il faut lancer (double-clic) pour demarrer le service.
'
'  - Si l'installation ou la compilation sont necessaires (par ex. apres une
'    mise a jour), elles s'executent en arriere-plan, masquees (aucune console).
'  - Puis Electron est lance directement (application graphique : pas de console).
'  - La fenetre du portail DMP s'ouvre le temps de l'authentification e-CPS, puis
'    se masque. Une icone WebDMP apparait pres de l'horloge. Ctrl+Alt+D envoie le
'    document selectionne dans StudioVision. Pour arreter : clic droit sur l'icone.
'
'  Astuce : lors d'une mise a jour, decompressez par-dessus le dossier existant
'  pour conserver node_modules ; l'install ne sera pas refaite et le demarrage
'  sera instantane.
' ============================================================================

Dim shell, fso, dir, electronExe, mainJs, needSetup
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
electronExe = dir & "\node_modules\electron\dist\electron.exe"
mainJs      = dir & "\dist\main.js"

needSetup = (Not fso.FileExists(electronExe)) Or (Not fso.FileExists(mainJs))

If needSetup Then
    ' Installation des dependances + compilation, totalement masquees ; on attend la fin.
    shell.Run "cmd /c ""npm install && npm run build""", 0, True
End If

If fso.FileExists(electronExe) And fso.FileExists(mainJs) Then
    ' Electron directement : application GUI, aucune console. Fenetre du lanceur masquee.
    shell.Run """" & electronExe & """ "".""" & " --service", 0, False
Else
    MsgBox "L'installation de WebDMP a echoue." & vbCrLf & _
           "Verifiez que Node.js est installe et que la connexion reseau fonctionne." & vbCrLf & _
           "Pour voir le detail de l'erreur, lancez Se-Connecter-WebDMP.bat.", _
           vbExclamation, "WebDMP"
End If
