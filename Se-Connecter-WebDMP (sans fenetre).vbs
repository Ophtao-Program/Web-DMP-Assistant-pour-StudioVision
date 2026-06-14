' ============================================================================
'  Se-Connecter-WebDMP (sans fenetre).vbs
'
'  Demarre le service WebDMP en arriere-plan.
'  -> C'est CE fichier qu'il faut lancer (double-clic) pour demarrer le service.
'
'  Comportement :
'   - Si l'application est deja installee (node_modules + dist presents) :
'       Electron est lance DIRECTEMENT, sans AUCUNE fenetre terminal.
'   - Sinon (toute premiere fois) : une fenetre s'affiche le temps de
'       l'installation et de la compilation, puis le service demarre.
'
'  Ensuite : fenetre DMP pour l'authentification e-CPS (puis masquee), icone
'  pres de l'horloge, et Ctrl+Alt+D pour envoyer le document selectionne.
'  Pour arreter : clic droit sur l'icone WebDMP puis Quitter.
' ============================================================================

Dim shell, fso, dir, electronExe, mainJs
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = dir & "\node_modules\electron\dist\electron.exe"
mainJs      = dir & "\dist\main.js"

shell.CurrentDirectory = dir

If fso.FileExists(electronExe) And fso.FileExists(mainJs) Then
    ' Cas normal : tout est pret -> Electron directement, fenetre masquee (0).
    shell.Run """" & electronExe & """ "".""" & " --service", 0, False
Else
    ' Premiere fois : installation/compilation visible via le .bat, puis lancement.
    shell.Run """" & dir & "\Se-Connecter-WebDMP.bat""", 1, False
End If
