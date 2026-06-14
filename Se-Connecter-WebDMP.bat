@echo off
cd /d "%~dp0"

REM ==================================================================
REM  Se-Connecter-WebDMP : connexion initiale + service de fond.
REM  Lance Electron en mode service. Normalement appele par le
REM  lanceur invisible "Se-Connecter-WebDMP (sans fenetre).vbs".
REM ==================================================================

if not exist "node_modules\" (
    echo Installation des dependances...
    call npm install
    if errorlevel 1 (
        echo ERREUR : npm install a echoue
        pause
        exit /b 1
    )
)

if not exist "dist\main.js" (
    echo Compilation TypeScript...
    call npm run build
    if errorlevel 1 (
        echo ERREUR : la compilation a echoue
        pause
        exit /b 1
    )
)

call npx electron . --service
exit /b 0
