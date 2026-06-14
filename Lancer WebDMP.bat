@echo off
cd /d "%~dp0"

:: Vérifier que node_modules existe
if not exist "node_modules\" (
    echo Installation des dependances...
    call npm install
    if errorlevel 1 (
        echo ERREUR : npm install a echoue
        pause
        exit /b 1
    )
)

:: Compiler seulement si dist/main.js absent
if not exist "dist\main.js" (
    echo Compilation TypeScript...
    call npm run build
    if errorlevel 1 (
        echo ERREUR : La compilation a echoue
        pause
        exit /b 1
    )
)

:: Lancer Electron
call npx electron .

exit /b 0
